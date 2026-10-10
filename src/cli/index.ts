#!/usr/bin/env node
// framer-cms-sync command line. With no command in an interactive terminal it opens the terminal app.

import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, loadDotEnv, CONFIG_NAMES } from "../config/load.ts";
import { createSync, type Sync } from "../engine.ts";
import { SyncError } from "../core/issues.ts";
import { addProject, initConfig, addToken, deleteSite, deleteSync, renameProject, revokeToken, setProjectLabel, type DeleteResult } from "../config/write.ts";
import { SCOPE_HELP, tokenSnippets } from "../core/snippets.ts";
import { HOW_LABEL } from "../core/map.ts";
import { inspectSource } from "../inspect.ts";
import { readState, writeState } from "../core/state.ts";
import { framerConnector } from "../framer/adapter.ts";
import type { SourceInput } from "../sources/index.ts";
import { slugOf, type Post } from "../core/posts.ts";
import { listSkills, readSkill, shortName, skillsDir } from "./skills.ts";
import { bold, dim, formatIssues, formatReport, green, red, table, yellow } from "./format.ts";
import { formatFromPath, isMarkdownFile, postName, type FileKind } from "../core/filetypes.ts";
import { NAME_RE, SCOPES, type Scope } from "../config/schema.ts";
import type { SyncReport } from "../core/report.ts";
import { VERSION } from "../version.ts";


const HELP = `${bold("framer-cms-sync")} ${VERSION} — keep Framer CMS collections in sync with your data

${bold("Usage")}
  framer-cms-sync                      open the terminal app (interactive terminals only)
  framer-cms-sync <command> [options]

${bold("Setup")}
  init --url URL --key KEY             write a starter config and .env, check the connection
  init --name NAME --url URL --key KEY add another site (Framer project) to an existing config
  projects [--check]                   list the sites (• = current; --check connects to each)
  projects use <name>                  make a site current: commands use it when --project isn't given
  projects rename <name> <new-name>    change a site's short name (syncs follow)
  projects label <name> <display name> change the name shown for a site
  projects remove <name> [--with-syncs] [--delete-files]
                                       delete a site from this program (its syncs too with --with-syncs);
                                       Framer isn't touched. --delete-files also deletes the syncs' source files
  collections                          list collections, who owns them, whether they're writable
  fields <collection>                  list a collection's fields
  syncs                                list the syncs in the config
  syncs remove <name> [--delete-files] delete a sync from this program (Framer isn't touched)
  setup <sync> [--force]               create the sync's collection (managed or regular) and its fields
  check <sync> [input...]              compare your data with the collection's fields

${bold("Access tokens")} (for the HTTP API and MCP over HTTP)
  tokens                               list tokens (never their values)
  tokens add <name> --scope read|write|publish|admin [--description "…"] [--sites a,b] [--syncs x,y]
  tokens revoke <name>                 takes effect immediately, even on a running server

${bold("Looking at data")}
  inspect <url | file | folder | sync> [--rows data.items] [--header "Authorization: Bearer …"]
                                       show the format, where the records are, and each field's type and
                                       sample values. URLs are fetched live (GET); nothing is stored.

${bold("Files")}
  download <collection> <file|folder> [--format csv|excel|json|markdown] [--overwrite]
                                       save every item of a collection to a file, with exact slugs, so your
                                       local data starts identical to the CMS
  pull <sync>                          replace the sync's file or folder with everything in Framer
                                       (a backup copy is saved next to it first)
  template <file|folder> [--from <collection>] [--format …]
                                       a starter file with one example row (columns from --from if given)

${bold("Syncing")}
  plan <sync> [input...]               preview: what would change (writes nothing)
  apply <sync> [input...]              write the changes
      --publish | --no-publish | --publish-on-change
      --no-deploy                      publish a preview without promoting it to production
      --plan-id ID                     refuse unless the data matches that plan
      --partial                        this is only some of the data: add and update, never remove
      --create-only                    only add new items; leave existing ones untouched
      --update-only                    only update existing items; leave new ones out
      --replace                        replace all: also remove items whose slug isn't in the data
      --limit N   --only slug,slug     write a subset (never removes)
      --allow-mass-remove              allow removing more than prune.maxRemove
  items <sync>                         list items in the collection

${bold("Single Markdown posts")} (written straight away; the sync's folder is kept in step)
  add <sync> <post.md...>              add new posts (refuses slugs already in Framer)
  update <sync> <post.md...>           update existing posts, matched by slug
  remove <sync> <slug|post.md...>      delete posts from Framer and their files from the folder
      [--keep-file] [--redirect-to SLUG]
  Use - to read one post from stdin (slug from its frontmatter or --slug). All take --publish.
  map <sync>                           show how each column is matched to a field
  map <sync> <column> <field>          send a column to a specific field
  map <sync> <column> --ignore | --auto    never send it / back to automatic matching

${bold("Redirects")}
  redirects list
  redirects plan <file.csv>
  redirects apply <file.csv> [--publish]
  redirects remove <from...>

${bold("Other")}
  publish [--no-deploy]                publish the whole site as it is now
  history                              recent runs
  describe                             config keys, issue codes and workflow (for agents)
  serve [--port N] [--host H]          run the HTTP service
  mcp [--scope read|write|publish|admin]   run the MCP server on stdio

${bold("Guides")} (for people and agents; also in the skills/ folder)
  skills                               list the guides: setup, sources, syncing, mapping, cli, http, mcp, …
  skills <name> [reference]            print one, e.g. \`skills cli\`, \`skills cli commands\`, \`skills troubleshooting\`

${bold("Input")} is files, folders, globs, or - for stdin. Without input, the sync's source.path / source.url is used.

${bold("Options")}
  -c, --config FILE    config file (default: search upward for framer-cms-sync.config.yaml)
  -p, --project NAME   which site, for collections, fields, redirects and publish (needed when there are several)
  --json               print JSON (default when output isn't a terminal)
  -h, --help           this help

New here? \`framer-cms-sync skills overview\`. Every command and option: \`framer-cms-sync skills cli commands\`.
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    config: { type: "string", short: "c" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    force: { type: "boolean" },
    publish: { type: "boolean" },
    "no-publish": { type: "boolean" },
    "publish-on-change": { type: "boolean" },
    "no-deploy": { type: "boolean" },
    "plan-id": { type: "string" },
    limit: { type: "string" },
    only: { type: "string" },
    "allow-mass-remove": { type: "boolean" },
    partial: { type: "boolean" },
    "create-only": { type: "boolean" },
    "delete-files": { type: "boolean" },
    "with-syncs": { type: "boolean" },
    "update-only": { type: "boolean" },
    replace: { type: "boolean" },
    "redirect-to": { type: "string" },
    slug: { type: "string" },
    "keep-file": { type: "boolean" },
    full: { type: "boolean" },
    ignore: { type: "boolean" },
    rows: { type: "string" },
    format: { type: "string" },
    from: { type: "string" },
    overwrite: { type: "boolean" },
    header: { type: "string", multiple: true },
    auto: { type: "boolean" },
    port: { type: "string" },
    host: { type: "string" },
    scope: { type: "string" },
    description: { type: "string" },
    sites: { type: "string" },
    syncs: { type: "string" },
    project: { type: "string", short: "p" },
    url: { type: "string" },
    name: { type: "string" },
    label: { type: "string" },
    check: { type: "boolean" },
    key: { type: "string" },
    "key-env": { type: "string" },
  },
});

const interactive = !!process.stdout.isTTY && !!process.stdin.isTTY;
const json = !!flags.json || !process.stdout.isTTY;
const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, t.lastIndexOf(" ", n - 1)) + "…" : t);

function print(human: () => string, data: unknown) {
  if (json) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  else console.log(human());
}

function engine(actor = "cli"): Sync {
  const loaded = loadConfig(str("config"));
  return createSync({ config: loaded.config, configDir: loaded.dir, configFile: loaded.file, actor, defaultProject: readState(loaded.dir).currentProject });
}

async function readInput(args: string[]): Promise<SourceInput | undefined> {
  if (!args.length) return undefined;
  if (args.length === 1 && args[0] === "-") {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return { text: Buffer.concat(chunks).toString("utf8") };
  }
  return { files: args.map((a) => path.resolve(a)) };
}

/** Markdown posts from files, or from stdin with "-" (slug from the frontmatter or --slug). */
async function readPosts(args: string[]): Promise<Post[]> {
  if (args.length === 1 && args[0] === "-") {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return [{ markdown: Buffer.concat(chunks).toString("utf8"), slug: str("slug") }];
  }
  return args.map((a) => {
    const file = path.resolve(a);
    if (!existsSync(file)) throw new SyncError("INPUT_INVALID", `no such file: ${a}`);
    return { markdown: readFileSync(file, "utf8"), slug: postName(file), file };
  });
}

function postSlugFromFile(e: Sync, syncName: string, file: string): string {
  const sync = e.syncConfig(syncName);
  const slug = slugOf({ markdown: readFileSync(file, "utf8"), slug: postName(file) }, sync);
  if (!slug) throw new SyncError("INPUT_INVALID", `couldn't work out the slug of ${file}`);
  return slug;
}

/** What plan and apply should cover, from --limit, --only, --partial, --create-only, --update-only, --replace. */
const runFlags = () => ({
  limit: num("limit"), only: list("only"), full: !!flags.full,
  partial: !!flags.partial, createOnly: !!flags["create-only"], updateOnly: !!flags["update-only"], replace: !!flags.replace,
});

/** 0 ok; 2 when only a safety guard (large removal) refused it; 1 when the data has problems. */
const reportExit = (r: SyncReport) => (r.ok ? 0 : r.issues.errors.length && r.issues.errors.every((e) => e.code === "PRUNE_GUARD") ? 2 : 1);

const publishOpt = (): boolean | "on-change" | undefined =>
  flags.publish ? true : flags["no-publish"] ? false : flags["publish-on-change"] ? "on-change" : undefined;

async function init() {
  const dir = process.cwd();
  const existing = (str("config") && existsSync(path.resolve(str("config")!))) ? path.resolve(str("config")!) : CONFIG_NAMES.map((n) => path.join(dir, n)).find(existsSync);
  const url = str("url");
  let key = str("key");
  if ((!url || !key) && interactive && !json) {
    const { runTui } = await import("../tui/app.tsx");
    return runTui({ dir, configFile: existing, initialScreen: existing ? "addsite" : "setup" });
  }
  if (!url) throw new SyncError("INPUT_INVALID", "init needs --url <Framer project URL>", { fix: "framer-cms-sync init --url https://framer.com/projects/... --key <API key>" });
  const keyEnv = str("key-env") ?? "FRAMER_API_KEY";
  loadDotEnv(existing ? path.dirname(existing) : dir);
  key ??= process.env[keyEnv];
  if (!key) throw new SyncError("INPUT_INVALID", `init needs --key, or ${keyEnv} in the environment`, { fix: "create an API key in Framer → Site Settings → API" });
  const client = await framerConnector(url, key)();
  const framerName = await client.projectName();
  const count = (await client.listCollections()).length;
  await client.disconnect();

  if (existing) {
    // Add another site to an existing config.
    const name = str("name");
    if (!name || !NAME_RE.test(name))
      throw new SyncError("INPUT_INVALID", "a config already exists here; to add another site, give it a short name with --name", { fix: "framer-cms-sync init --name shop --url … --key …" });
    const current = loadConfig(existing).config;
    if (current.projects[name]) throw new SyncError("INPUT_INVALID", `a project named "${name}" already exists`);
    const r = addProject(existing, { name, url, apiKey: key, label: str("label") ?? framerName });
    return print(() => [
      green(`✓ Connected to "${framerName}" (${count} collections) and added it as "${name}"`),
      ...(r.converted ? [dim(`  your existing site is now called "${r.converted}" and its syncs point at it`)] : []),
      dim(`  URL and key saved to .env as ${r.envVars.join(", ")}`),
      "", `Next: framer-cms-sync collections --project ${name}`,
    ].join("\n"), { ok: true, added: name, project: framerName, collections: count, converted: r.converted });
  }

  const siteName = str("name");
  if (siteName && !NAME_RE.test(siteName)) throw new SyncError("INPUT_INVALID", "site names: letters, digits, - and _");
  const file = initConfig(dir, { url, key, keyEnv, siteName, label: siteName ? framerName : undefined });
  print(() => [
    green(`✓ Connected to "${framerName}" (${count} collections)`),
    `Wrote ${path.basename(file)}; saved the URL and key to .env (git-ignored).`,
    "", "Next: run `framer-cms-sync collections`, then add a sync to the config.",
  ].join("\n"), { ok: true, project: framerName, collections: count, config: file });
}

async function main() {
  const [cmd, ...args] = positionals;
  if (flags.version) return console.log(VERSION);
  if (flags.help || cmd === "help") return console.log(HELP);
  if (!cmd) {
    if (interactive) { const { runTui } = await import("../tui/app.tsx"); return runTui({ dir: process.cwd(), configFile: str("config") }); }
    return console.log(HELP);
  }

  switch (cmd) {
    case "init": return init();

    case "projects": return projects(args);
    case "tokens": return tokens(args);

    case "collections": {
      const cols = await engine().collections({ project: str("project") });
      return print(() => table(cols.map((c) => ({ name: c.name, id: c.id, mode: c.mode ?? "—", writable: c.writable ? "yes" : red("no"), note: c.note })), ["name", "id", "mode", "writable", "note"]), cols);
    }
    case "fields": {
      if (!args[0]) throw new SyncError("INPUT_INVALID", "fields needs a collection name or id");
      const r = await engine().fields(args[0], { project: str("project") });
      return print(() => `${bold(r.collection.name)} ${dim(r.collection.id)}\n` + table(r.fields.map((f) => ({ name: f.name, id: f.id, type: f.type, options: f.cases?.map((c) => c.name).join(", ") ?? "" })), ["name", "id", "type", "options"]), r);
    }
    case "syncs": {
      if (args[0] === "remove") {
        need(args[1], "syncs remove <name> [--delete-files]");
        const loaded = loadConfig(str("config"));
        if (!loaded.config.syncs[args[1]]) throw new SyncError("SYNC_NOT_FOUND", `no sync named "${args[1]}"`);
        const r = deleteSync(loaded.file, args[1], { deleteFiles: !!flags["delete-files"] });
        return print(() => describeDelete(r, `sync "${args[1]}"`), r);
      }
      const s = engine().syncs();
      const multi = new Set(s.map((x) => x.project)).size > 1;
      return print(() => table(s.map((x) => ({ name: x.name, project: x.project, source: x.source, collection: x.collection, mode: x.mode, publish: x.publish, prune: x.prune ? "on" : "off" })), ["name", ...(multi ? ["project"] : []), "source", "collection", "mode", "publish", "prune"]), s);
    }
    case "setup": {
      need(args[0], "setup <sync>");
      const r = await engine().setup(args[0], { force: !!flags.force });
      return print(() => r.unchanged ? yellow(`• ${r.note}`)
        : [green(`✓ ${r.created ? "Created" : "Updated"} "${r.collection.name}" (${r.collection.id}) with ${r.fieldCount} fields, ${r.fieldsFrom}`),
           ...(r.fields ? [dim(`  ${r.fields.map((f) => `${f.name} (${f.type})`).join(", ")}`)] : []),
           ...(r.skipped?.length ? [dim(`  skipped: ${r.skipped.join(", ")}`)] : []),
           ...(r.savedToConfig ? [dim("  collection id saved to the config")] : []), `→ ${r.next}`].join("\n"), r);
    }
    case "check": {
      need(args[0], "check <sync> [input...]");
      const r = await engine().check(args[0], await readInput(args.slice(1))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      process.exitCode = r.ok ? 0 : 1;
      return print(() => [
        `${bold(r.sync)} → "${r.collection.name}": ${r.ownership}`,
        `  ${r.fieldCount} fields${r.records != null ? ` · ${r.records} records in the source` : ""}`,
        ...(r.unusedFields?.length ? [`  ${yellow("fields nothing writes to:")} ${r.unusedFields.join(", ")}`] : []),
        ...(r.slugCheck ? [`  slugs: ${r.slugCheck.matching} of ${r.slugCheck.total} match "${r.slugCheck.against}"` + (r.slugCheck.newSlugs.length ? yellow(` · ${r.slugCheck.newSlugs.length} would change URL: ${r.slugCheck.newSlugs.slice(0, 8).join(", ")}`) : "")] : []),
        ...(r.note ? [dim(`  ${r.note}`)] : []),
        ...formatIssues(r.issues),
        "", r.ok ? green("  ✓ ready") : red("  fix the errors above"),
      ].join("\n"), r);
    }
    case "plan": {
      need(args[0], "plan <sync> [input...]");
      const r = await engine().plan(args[0], await readInput(args.slice(1)), runFlags());
      process.exitCode = reportExit(r);
      return print(() => formatReport(r), r);
    }
    case "apply": {
      need(args[0], "apply <sync> [input...]");
      const r = await engine().apply(args[0], await readInput(args.slice(1)), {
        publish: publishOpt(), deploy: flags["no-deploy"] ? false : undefined, planId: str("plan-id"),
        requirePlanId: process.env.FRAMER_CMS_SYNC_REQUIRE_PLAN === "1" && !interactive,
        allowMassRemove: !!flags["allow-mass-remove"], ...runFlags(),
      });
      process.exitCode = reportExit(r);
      return print(() => formatReport(r), r);
    }
    case "items": {
      need(args[0], "items <sync>");
      const r = await engine().items(args[0]);
      return print(() => `${bold(r.collection.name)}: ${r.count} items\n` + r.items.map((i) => `  ${i.slug}${i.draft ? dim(" (draft)") : ""}`).join("\n"), r);
    }
    case "add": case "update": {
      need(args[0] && args[1], `${cmd} <sync> <post.md...> [--publish]`);
      const posts = await readPosts(args.slice(1));
      const e = engine();
      const r = cmd === "add" ? await e.addPosts(args[0], posts, { publish: publishOpt(), deploy: flags["no-deploy"] ? false : undefined })
        : await e.updatePosts(args[0], posts, { publish: publishOpt(), deploy: flags["no-deploy"] ? false : undefined });
      print(() => {
        if (!r.applied) return formatIssues(r.issues) + "\n" + red("Nothing was written. Fix the errors above and run it again.");
        const done = cmd === "add" ? r.items.create : r.items.update;
        return [
          ...done.map((i) => green(`✓ ${cmd === "add" ? "added" : "updated"} ${typeof i === "string" ? i : i.slug}`)),
          ...(r.items.unchanged ? [dim(`  ${r.items.unchanged} already up to date`)] : []),
          ...r.files.filter((f) => f.action === "created" || f.action === "updated").map((f) => dim(`  saved ${f.file}`)),
          ...(r.issues.warnings.length ? [formatIssues(r.issues)] : []),
          r.publish ? green(`✓ published → ${r.publish.hostnames.join(", ")}`) : dim("  (site not published; add --publish to put it live)"),
        ].join("\n");
      }, r);
      process.exitCode = r.applied ? 0 : 1;
      return;
    }
    case "remove": {
      need(args[0] && args[1], "remove <sync> <slug|post.md...> [--redirect-to slug] [--keep-file] [--publish]");
      const e = engine(), keys = args.slice(1), out: Awaited<ReturnType<Sync["remove"]>>[] = [];
      for (const [i, k] of keys.entries()) {
        const slug = isMarkdownFile(k) && existsSync(k) ? postSlugFromFile(e, args[0], k) : k;
        // Publish once, after the last removal.
        out.push(await e.remove(args[0], slug, { redirectTo: str("redirect-to"), keepFile: !!flags["keep-file"], publish: !!flags.publish && i === keys.length - 1, deploy: flags["no-deploy"] ? false : undefined }));
      }
      const last = out[out.length - 1];
      return print(() => [
        ...out.flatMap((r) => [green(`✓ removed ${r.removed}`) + (r.file ? dim(` (deleted ${r.file})`) : ""),
          ...(r.redirect ? [green(`✓ redirect ${r.redirect.from} → ${r.redirect.to}`) + (r.repointed ? dim(` (re-pointed ${r.repointed} existing)`) : "")] : []),
          ...(r.reminder ? [dim(`  ${r.reminder}`)] : [])]),
        last.publish ? green(`✓ published → ${last.publish.hostnames.join(", ")}`) : dim("  (site not published)"),
      ].join("\n"), out.length === 1 ? last : out);
    }
    case "redirects": return redirects(args);
    case "inspect": return inspect(args);
    case "pull": {
      need(args[0], "pull <sync>");
      const r = await engine().pull(args[0]);
      return print(() => [
        green(`✓ downloaded ${r.rows} item${r.rows === 1 ? "" : "s"} from "${r.collection.name}" into ${r.dest}`),
        ...(r.backup ? [dim(`  the previous version was saved as ${r.backup}`)] : []),
        ...(r.configUpdated.length ? [dim(`  sync updated: ${r.configUpdated.join(", ")}`)] : []),
        dim(`  your file now matches Framer; run plan ${args[0]} to confirm`),
      ].join("\n"), r);
    }
    case "download": case "template": {
      const isDl = cmd === "download";
      const dest = isDl ? args[1] : args[0];
      need(isDl ? args[0] && dest : dest, isDl ? "download <collection> <file|folder>" : "template <file|folder> [--from <collection>]");
      const fmt = (str("format") ?? formatFromPath(dest) ?? "markdown") as FileKind;
      if (!["csv", "excel", "json", "markdown"].includes(fmt)) throw new SyncError("INPUT_INVALID", "--format must be csv, excel, json or markdown");
      const e = engine();
      const r = isDl
        ? await e.download({ collection: args[0], format: fmt, dest, overwrite: !!flags.overwrite, project: str("project") })
        : await e.template({ format: fmt, dest, from: str("from"), overwrite: !!flags.overwrite, project: str("project") });
      return print(() => [
        green(`✓ ${isDl ? `saved ${r.rows} item${r.rows === 1 ? "" : "s"}` : "wrote a template"} to ${dest}${r.format === "markdown" ? ` (${r.files} file${r.files === 1 ? "" : "s"})` : ""}`),
        dim(`  columns: ${r.columns.join(", ")}`),
        "", dim("for a sync:"),
        `  source: { type: ${r.format}, path: ${dest} }`,
        ...(r.format !== "markdown" ? [`  key: { field: ${r.keyColumn}${r.keyTransform === "none" ? ", transform: none" : ""} }`] : []),
        ...(r.bodyField ? [`  fields: { map: { content: ${JSON.stringify(r.bodyField)} } }`] : []),
      ].join("\n"), r);
    }
    case "map": {
      need(args[0], "map <sync> [column] [field | --ignore | --auto]");
      const e = engine();
      let r;
      if (args[1]) {
        const to = flags.ignore ? "ignore" : flags.auto ? "auto" : args[2];
        need(to, `map ${args[0]} "${args[1]}" <field name>   (or --ignore / --auto)`);
        r = await e.setMappings(args[0], [{ column: args[1], to: to! }]);
      } else r = await e.mappings(args[0]);
      const changed = args[1] ? r.columns.find((c) => c.column === args[1]) : null;
      return print(() => [
        ...(changed ? [green(`✓ "${changed.column}" → ${flags.auto ? `automatic (${changed.field ? `now "${changed.field.name}", ${HOW_LABEL[changed.how]}` : "no field matches"})` : changed.field ? `"${changed.field.name}"` : HOW_LABEL[changed.how]}`) + dim("   saved to the config; run plan to see the effect"), ""] : []),
        `${bold(r.sync)} → "${r.collection.name}"${r.source ? dim(`  (${r.source.records} records from ${r.source.from})`) : ""}`,
        table(r.columns.map((c) => ({
          column: c.column + (c.column === r.key ? dim(" (key)") : ""),
          "→ field": c.field ? c.field.name : c.how === "ignored" ? dim("(ignored)") : c.how === "map-missing" ? red(`"${c.mappedTo}" (missing)`) : yellow("(nothing)"),
          how: (c.how === "none" || c.how === "map-missing" ? yellow : c.how === "map" ? green : (x: string) => x)(HOW_LABEL[c.how]) + (c.ambiguous ? yellow(` · also matches ${c.ambiguous.slice(1).join(", ")}`) : "") + (c.shadowedBy ? yellow(` · "${c.shadowedBy}" already fills it`) : "") + (c.inData ? "" : dim(" · not in the data")),
          sample: c.sample === undefined ? "" : dim(String(c.sample).slice(0, 30)),
        })), ["column", "→ field", "how", "sample"]),
        ...(r.unusedFields.length ? ["", `${dim("fields nothing writes to:")} ${r.unusedFields.map((f) => f.name).join(", ")}`] : []),
        ...(r.note ? ["", dim(r.note)] : []),
        ...(!args[1] ? ["", dim(`change one: framer-cms-sync map ${r.sync} "<column>" "<field>"   (or --ignore / --auto)`)] : []),
      ].join("\n"), r);
    }
    case "publish": {
      const r = await engine().publish({ project: str("project"), deploy: flags["no-deploy"] ? false : undefined });
      return print(() => green(`✓ published${r.deployed ? " and deployed" : " (preview only)"} → ${r.hostnames.join(", ") || r.deploymentId}`) + "\n" + dim(`  ${r.note}`), r);
    }
    case "history": {
      const h = await engine().history(30);
      return print(() => table(h.map((e) => ({ when: e.at.replace("T", " ").slice(0, 16), who: e.actor, what: e.op + (e.sync ? ` ${e.sync}` : e.project ? ` (${e.project})` : ""), ok: e.ok ? "✓" : red("✗"), detail: e.error ?? (e.counts ? Object.entries(e.counts).map(([k, v]) => `${k} ${v}`).join(", ") : "") })), ["when", "who", "what", "ok", "detail"]), h);
    }
    case "skills": {
      const [name, ref] = positionals.slice(1);
      if (!name) {
        const all = listSkills();
        return print(() => [
          bold("Guides") + dim(` (${skillsDir()})`), "",
          table(all.map((sk) => ({ name: shortName(sk.name), about: clip(sk.description.split(" - ")[0].split(". Use when")[0].split(", the tool")[0], 70), references: sk.references.join(", ") })), ["name", "about", "references"]),
          "", dim("Print one: framer-cms-sync skills <name> [reference]"),
        ].join("\n"), all.map(({ dir: _d, ...sk }) => ({ ...sk, short: shortName(sk.name) })));
      }
      const r = readSkill(name, ref);
      if (json) return print(() => "", { name: r.skill.name, reference: ref ?? null, file: r.file, references: r.skill.references, text: r.text });
      process.stdout.write(r.text.endsWith("\n") ? r.text : r.text + "\n");
      if (!ref && r.skill.references.length) console.log(dim(`\nMore detail: ${r.skill.references.map((x) => `framer-cms-sync skills ${shortName(r.skill.name)} ${x}`).join(" · ")}`));
      return;
    }
    case "describe": return console.log(JSON.stringify(engine().describe(), null, 2));
    case "serve": {
      const { startServer } = await import("../server/http.ts");
      return startServer(str("config"), { port: num("port"), host: str("host") });
    }
    case "mcp": {
      const loaded = loadConfig(str("config"));
      const { runMcpStdio } = await import("../mcp/server.ts");
      const scope = (str("scope") ?? "write") as Scope;
      if (!SCOPES.includes(scope)) throw new SyncError("INPUT_INVALID", `unknown scope "${scope}"`, { fix: `use one of: ${SCOPES.join(", ")}` });
      return runMcpStdio(loaded, { scope });
    }
    default:
      throw new SyncError("INPUT_INVALID", `unknown command "${cmd}"`, { fix: "run framer-cms-sync --help" });
  }
}

async function projects(args: string[]) {
  const [sub, ...rest] = args;
  const loaded = loadConfig(str("config"));
  const file = loaded.file;
  const current = readState(loaded.dir).currentProject;
  const names = Object.keys(loaded.config.projects);
  const fail = (e: unknown) => { throw new SyncError("INPUT_INVALID", (e as Error).message); };
  if (!sub || sub === "list") {
    const ps = await engine().projects({ check: !!flags.check });
    const cur = names.length === 1 ? names[0] : current;
    return print(() => table(ps.map((p) => ({
      name: `${p.name === cur ? "• " : "  "}${p.name}`, site: (p as { framerName?: string }).framerName ?? p.label ?? "", syncs: p.syncs.join(", ") || dim("(none)"),
      ...(flags.check ? { status: (p as { ok?: boolean }).ok ? green(`✓ ${(p as { collections?: number }).collections} collection${(p as { collections?: number }).collections === 1 ? "" : "s"}`) : red(`✗ ${(p as { error?: string }).error}`) } : {}),
    })), ["name", "site", "syncs", ...(flags.check ? ["status"] : [])]) + (names.length > 1 && !cur ? dim("\n\nNo current site. Set one with `framer-cms-sync projects use <name>`.") : ""), ps.map((p) => ({ ...p, current: p.name === cur })));
  }
  if (sub === "use") {
    need(rest[0], "projects use <name>");
    if (!names.includes(rest[0])) throw new SyncError("NOT_FOUND", `no site named "${rest[0]}"`, { fix: `use one of: ${names.join(", ")}` });
    writeState(loaded.dir, { currentProject: rest[0] });
    return print(() => green(`✓ "${rest[0]}" is now the current site`) + dim("\n  commands use it when you don't pass --project"), { ok: true, current: rest[0] });
  }
  if (sub === "rename") {
    need(rest[0] && rest[1], "projects rename <name> <new-name>");
    try { renameProject(file, rest[0], rest[1]); } catch (e) { fail(e); }
    if (current === rest[0]) writeState(loaded.dir, { currentProject: rest[1] });
    return print(() => green(`✓ renamed "${rest[0]}" to "${rest[1]}"`) + dim("\n  syncs and tokens that used the old name were updated"), { ok: true, from: rest[0], to: rest[1] });
  }
  if (sub === "label") {
    need(rest[0], "projects label <name> <display name>");
    try { setProjectLabel(file, rest[0], rest.slice(1).join(" ")); } catch (e) { fail(e); }
    return print(() => green(`✓ ${rest.length > 1 ? `"${rest[0]}" is now shown as "${rest.slice(1).join(" ")}"` : `cleared the display name of "${rest[0]}"`}`), { ok: true });
  }
  if (sub === "remove") {
    need(rest[0], "projects remove <name> [--with-syncs] [--delete-files]");
    if (!names.includes(rest[0])) throw new SyncError("NOT_FOUND", `no site named "${rest[0]}"`, { fix: `use one of: ${names.join(", ")}` });
    const syncs = Object.entries(loaded.config.syncs).filter(([, s]) => s.project === rest[0]).map(([n]) => n);
    if (syncs.length && !flags["with-syncs"]) throw new SyncError("INPUT_INVALID", `"${rest[0]}" has syncs: ${syncs.join(", ")}`, { fix: "add --with-syncs to delete them too (Framer isn't touched), and --delete-files to also delete their source files" });
    const r = deleteSite(file, rest[0], { deleteFiles: !!flags["delete-files"] });
    if (current === rest[0] && !r.reset) writeState(loaded.dir, { currentProject: undefined });
    return print(() => describeDelete(r, `site "${rest[0]}"`), r);
  }
  throw new SyncError("INPUT_INVALID", `unknown projects command "${sub}"`, { fix: "use list, use, rename, label or remove" });
}

async function inspect(args: string[]) {
  const target = args[0];
  need(target, "inspect <url | file | folder | sync>");
  const headers: Record<string, string> = {};
  for (const h of (flags.header as string[] | undefined) ?? []) { const i = h.indexOf(":"); if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
  const base = { rows: str("rows"), ...(Object.keys(headers).length ? { headers } : {}) };
  let r;
  if (/^https?:\/\//i.test(target)) r = await inspectSource({ url: target, ...base });
  else if (target === "-") { const chunks: Buffer[] = []; for await (const c of process.stdin) chunks.push(c as Buffer); r = await inspectSource({ text: Buffer.concat(chunks).toString("utf8"), ...base }); }
  else if (existsSync(path.resolve(target))) r = await inspectSource({ file: target, ...base });
  else r = await engine().inspect({ sync: target, ...base });
  return print(() => {
    const lines = [`${bold(r.from)}  ${dim(`${r.format}${r.rowsAt && r.rowsAt !== "(top level)" ? ` · records at "${r.rowsAt}"` : ""} · ${r.records} record${r.records === 1 ? "" : "s"}`)}`];
    if (!r.ok) {
      lines.push(yellow(`  ${r.note}`));
      if (r.candidates?.length) lines.push("", "  lists of records found:", ...r.candidates.slice(0, 5).map((c) => `    ${c.path}  ${dim(`(${c.count} items)`)}`), "", dim(`  inspect again with --rows ${r.candidates[0].path}`));
      return lines.join("\n");
    }
    lines.push("", table(r.fields.map((f) => ({
      field: f.path + (f.path === r.suggestedKey ? dim(" (key?)") : ""),
      type: f.type,
      filled: f.filled === r.records ? "all" : `${f.filled}/${r.records}`,
      examples: dim(f.examples.join(" · ").slice(0, 70)),
    })), ["field", "type", "filled", "examples"]));
    if (r.note) lines.push("", dim(r.note));
    if (r.fields.some((f) => f.path.includes("."))) lines.push("", dim('nested values are shown as paths (price.amount); map them like any column: fields.map: { "price.amount": "Price" }'));
    if (r.suggestedSource) lines.push("", dim("for a sync:"), `  source: { ${Object.entries(r.suggestedSource).map(([k, v]) => `${k}: ${v}`).join(", ")} }`, ...(r.suggestedKey ? [`  key: { field: ${/^[\w.-]+$/.test(r.suggestedKey) ? r.suggestedKey : JSON.stringify(r.suggestedKey)} }`] : []));
    return lines.join("\n");
  }, r);
}

async function tokens(args: string[]) {
  const [sub, ...rest] = args;
  const loaded = loadConfig(str("config"));
  const cfg = loaded.config;
  if (!sub || sub === "list") {
    const rows = cfg.server.tokens.map((t) => ({
      name: t.name, scope: t.scope,
      "limited to": [...(t.projects ?? []).map((p) => `site ${p}`), ...(t.syncs ?? []).map((x) => `sync ${x}`)].join(", ") || "everything",
      "used by": t.description ?? "", created: t.created ?? "",
    }));
    return print(() => (rows.length ? table(rows, ["name", "scope", "limited to", "used by", "created"]) : dim("No tokens yet. Create one with: framer-cms-sync tokens add <name> --scope write")), rows);
  }
  if (sub === "add") {
    const name = rest[0];
    need(name, "tokens add <name> --scope read|write|publish|admin");
    const scope = (str("scope") ?? "") as Scope;
    if (!SCOPE_HELP[scope]) throw new SyncError("INPUT_INVALID", "choose a scope with --scope", { fix: Object.entries(SCOPE_HELP).map(([k, v]) => `${k}: ${v}`).join("; ") });
    const projects = list("sites"), syncs = list("syncs");
    for (const p of projects ?? []) if (!cfg.projects[p]) throw new SyncError("INPUT_INVALID", `no site named "${p}"`);
    for (const x of syncs ?? []) if (!cfg.syncs[x]) throw new SyncError("INPUT_INVALID", `no sync named "${x}"`);
    let created;
    try { created = addToken(loaded.file, { name, scope, description: str("description"), projects, syncs }); }
    catch (e) { throw new SyncError("INPUT_INVALID", (e as Error).message); }
    const baseUrl = `http://${cfg.server.host === "0.0.0.0" ? "127.0.0.1" : cfg.server.host}:${cfg.server.port}`;
    const snippets = tokenSnippets({ value: created.value, scope, limited: !!(projects?.length || syncs?.length), baseUrl, exampleSync: syncs?.[0] ?? Object.keys(cfg.syncs)[0] });
    return print(() => [
      green(`✓ created token "${name}" (${scope}: ${SCOPE_HELP[scope]})`),
      "", bold("Token (shown once, copy it now):"), `  ${created.value}`,
      dim(`  saved in .env as ${created.envVar}; the config refers to it. Revoke with: framer-cms-sync tokens revoke ${name}`),
      ...snippets.flatMap((sn) => ["", bold(sn.title), sn.text.split("\n").map((l) => "  " + l).join("\n")]),
      "", dim(`Change the address if the service runs somewhere else (e.g. the host port of your Docker container). A running server picks up the token immediately.`),
    ].join("\n"), { ok: true, name, scope, token: created.value, envVar: created.envVar });
  }
  if (sub === "revoke") {
    need(rest[0], "tokens revoke <name>");
    try { revokeToken(loaded.file, rest[0]); } catch (e) { throw new SyncError("INPUT_INVALID", (e as Error).message); }
    return print(() => green(`✓ revoked "${rest[0]}"`) + dim("\n  anything using it is refused from now on, including a running server"), { ok: true, revoked: rest[0] });
  }
  throw new SyncError("INPUT_INVALID", `unknown tokens command "${sub}"`, { fix: "use list, add or revoke" });
}

async function redirects(args: string[]) {
  const [sub, ...rest] = args;
  const e = engine();
  const file = () => { need(rest[0], `redirects ${sub} <file>`); return readFileSync(rest[0] === "-" ? 0 : path.resolve(rest[0]), "utf8"); };
  if (sub === "list" || !sub) {
    const r = await e.redirects.list({ project: str("project") });
    return print(() => table(r.map((x) => ({ from: x.from, to: x.to ?? "" })), ["from", "to"]), r);
  }
  if (sub === "plan" || sub === "apply") {
    const r = sub === "plan" ? await e.redirects.plan(file(), { project: str("project") }) : await e.redirects.apply(file(), { project: str("project"), publish: !!flags.publish });
    const errors = r.issues.filter((i) => i.level === "error"), warnings = r.issues.filter((i) => i.level === "warning");
    process.exitCode = errors.length ? 1 : 0;
    return print(() => [
      `${r.requested} redirects: ${green(`${r.add.length} to add`)} · ${r.update.length} to update · ${r.unchanged.length} unchanged`,
      ...formatIssues({ errors, warnings }),
      ...("added" in r ? ["", green(`✓ ${(r as { added: number }).added} added, ${(r as unknown as { updated: number }).updated} updated`)] : sub === "apply" ? ["", red("  nothing written: fix the errors first")] : []),
    ].join("\n"), r);
  }
  if (sub === "remove") {
    need(rest.length, "redirects remove <from...>");
    const r = await e.redirects.remove(rest, { project: str("project") });
    return print(() => green(`✓ removed ${r.removed.length}`) + (r.notFound.length ? yellow(`  not found: ${r.notFound.join(", ")}`) : ""), r);
  }
  throw new SyncError("INPUT_INVALID", `unknown redirects command "${sub}"`, { fix: "use list, plan, apply or remove" });
}

function describeDelete(r: DeleteResult, what: string) {
  return [
    green(`✓ deleted ${what} from this program`) + dim("  (nothing in Framer was changed)"),
    ...(r.removedSyncs.length ? [dim(`  syncs removed: ${r.removedSyncs.join(", ")}`)] : []),
    ...(r.removedEnv.length ? [dim(`  saved secrets removed from .env: ${r.removedEnv.join(", ")}`)] : []),
    ...(r.tokensRevoked.length ? [dim(`  tokens revoked (they only had access to this): ${r.tokensRevoked.join(", ")}`)] : []),
    ...(r.tokensChanged.length ? [dim(`  tokens updated: ${r.tokensChanged.join(", ")}`)] : []),
    ...(r.deletedFiles.length ? [dim(`  source files deleted: ${r.deletedFiles.join(", ")}`)] : []),
    ...(r.keptFiles.length ? [dim(`  source files kept: ${r.keptFiles.join(", ")}`)] : []),
    ...(r.reset ? ["", "That was the only site, so the config and .env were removed. Run framer-cms-sync to set up again."] : []),
  ].join("\n");
}

function need(v: unknown, usage: string) { if (!v) throw new SyncError("INPUT_INVALID", `usage: framer-cms-sync ${usage}`); }
function num(k: string) { const v = str(k); return v ? Number(v) : undefined; }
function list(k: string) { const v = str(k); return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined; }

main().catch((e) => {
  if (e instanceof SyncError) {
    if (json) process.stdout.write(JSON.stringify(e.toJSON(), null, 2) + "\n");
    else {
      console.error(red(`✗ ${e.message}`));
      if (e.fix) console.error(dim(`  fix: ${e.fix}`));
      if (Array.isArray(e.details)) for (const d of e.details.slice(0, 10)) console.error(`  - ${(d as { message?: string }).message ?? JSON.stringify(d)}`);
    }
    process.exitCode = e.exitCode;
  } else {
    console.error(red(`✗ ${(e as Error)?.stack ?? e}`));
    process.exitCode = 4;
  }
});
