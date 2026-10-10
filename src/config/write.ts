// Edit the config file and .env without losing comments or ordering.
// Used by `init` and the terminal app.

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { isMap, parseDocument, type Document } from "yaml";
import { NAME_RE, type Scope } from "./schema.ts";
import { CONFIG_NAMES } from "./load.ts";

export function editConfig(file: string, mutate: (doc: Document) => void) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const doc = parseDocument(text);
  if (!doc.contents) doc.contents = doc.createNode({}) as never;
  mutate(doc);
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
}

/** Set (or with value undefined, delete) a path like ["syncs", "blog", "source", "path"]. */
export function setIn(doc: Document, keys: (string | number)[], value: unknown) {
  if (value === undefined) {
    // yaml throws when a parent on the path doesn't exist; there's nothing to delete then.
    if (doc.hasIn(keys)) doc.deleteIn(keys);
    return;
  }
  doc.setIn(keys, value);
  // A starter `syncs: {}` is a flow map; switch parents to block style so additions stay readable.
  for (let i = 1; i < keys.length; i++) {
    const node = doc.getIn(keys.slice(0, i), true);
    if (isMap(node)) node.flow = false;
  }
}

/** Upsert KEY=VALUE lines in .env (created with 600 permissions). */
export function setEnv(dir: string, values: Record<string, string>) {
  const p = path.join(dir, ".env");
  const lines = existsSync(p) ? readFileSync(p, "utf8").split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(values)) {
    const safe = /[\s#"']/.test(v) ? JSON.stringify(v) : v;
    const i = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${k}\\s*=`).test(l));
    if (i >= 0) lines[i] = `${k}=${safe}`; else lines.push(`${k}=${safe}`);
    process.env[k] = v;
  }
  writeFileSync(p, lines.filter((l, i, a) => !(l === "" && i === a.length - 1)).join("\n") + "\n", { mode: 0o600 });
}

/** Store a path relative to the config file's folder, so moved/cloned projects keep working. */
export const relPath = (configDir: string, p: string) => {
  const r = path.relative(configDir, path.resolve(configDir, p));
  return r.startsWith("..") || path.isAbsolute(r) ? path.resolve(configDir, p) : r.startsWith(".") ? r : `./${r}`;
};

/**
 * First-time setup in a folder: the project URL and key go to .env, a starter config is written
 * (unless one exists), and .env plus local state are git-ignored. Returns the config file's path.
 */
export function initConfig(dir: string, o: { url: string; key: string; keyEnv?: string; siteName?: string; label?: string; file?: string }): string {
  const keyEnv = o.keyEnv ?? "FRAMER_API_KEY";
  setEnv(dir, { FRAMER_PROJECT_URL: o.url, [keyEnv]: o.key });
  const file = o.file ?? path.join(dir, CONFIG_NAMES[0]);
  if (!existsSync(file)) writeFileSync(file, starterConfig({ keyEnv, siteName: o.siteName, label: o.label }));
  const gi = path.join(dir, ".gitignore");
  const text = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!/^\.env$/m.test(text)) appendFileSync(gi, `${text && !text.endsWith("\n") ? "\n" : ""}.env\n.framer-cms-sync/\n`);
  return file;
}

export function starterConfig(opts: { projectEnv?: string; keyEnv?: string; tokenEnv?: string; siteName?: string; label?: string } = {}): string {
  const project = opts.projectEnv ?? "FRAMER_PROJECT_URL";
  const key = opts.keyEnv ?? "FRAMER_API_KEY";
  const site = opts.siteName
    ? `# Your sites (Framer projects), by short name. Add more with \`framer-cms-sync init --name …\` or the terminal app.
projects:
  ${opts.siteName}:
    url: \${${project}}
    apiKey: \${${key}}${opts.label ? `\n    label: ${JSON.stringify(opts.label)}` : ""}
`
    : `project:
  url: \${${project}}
  apiKey: \${${key}}
`;
  return `# framer-cms-sync configuration
# Secrets live in .env next to this file. Values like \${NAME} are read from it.

${site}
defaults:
  publish: never        # never | always | on-change
  deploy: true          # after publishing, promote the preview to production

# One entry per collection you want to keep in sync.
syncs: {}
  # pricing:
  #   collection: { name: Pricing }        # mode: auto (default) | managed | unmanaged
  #   source: { type: csv, path: ./pricing.csv }
  #   key: { field: Plan Name }            # makes each row unique; becomes the URL slug
  #   fields: { ignore: [Internal notes] }
  #   prune: { minItems: 10, maxRemove: "20%" }
  #
  # blog:
  #   collection: { name: Blog }
  #   source: { type: markdown, path: ./posts }
  #   path: /blog/                         # used by redirects
  #   lint: { max-length: { meta_description: 160 } }

# server:
#   token: \${${opts.tokenEnv ?? "SYNC_TOKEN"}}     # required for \`serve\`; at least 16 characters
`;
}

export const envPrefix = (projectName: string) => `FRAMER_${projectName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

/**
 * Add a project (site) to the config, storing its URL and key in .env.
 * A config with a single `project:` is converted to `projects:` first: the existing project
 * gets `firstName` and every sync without a project is assigned to it, so nothing breaks.
 */
export function addProject(file: string, opts: { name: string; url: string; apiKey: string; label?: string; firstName?: string; firstLabel?: string }) {
  const dir = path.dirname(file);
  let converted: string | null = null;
  const prefix = envPrefix(opts.name);
  setEnv(dir, { [`${prefix}_URL`]: opts.url, [`${prefix}_API_KEY`]: opts.apiKey });
  editConfig(file, (doc) => {
    const single = doc.get("project", true);
    if (single) {
      const first = opts.firstName ?? "main";
      doc.delete("project");
      setIn(doc, ["projects", first], single);
      if (opts.firstLabel && !doc.getIn(["projects", first, "label"])) setIn(doc, ["projects", first, "label"], opts.firstLabel);
      const syncs = doc.get("syncs", true) as { items?: { key: unknown; value: unknown }[] } | undefined;
      for (const pair of syncs?.items ?? []) {
        const syncName = String((pair.key as { value?: unknown })?.value ?? pair.key);
        if (!doc.getIn(["syncs", syncName, "project"])) setIn(doc, ["syncs", syncName, "project"], first);
      }
      converted = first;
    }
    setIn(doc, ["projects", opts.name], { url: `\${${prefix}_URL}`, apiKey: `\${${prefix}_API_KEY}`, ...(opts.label ? { label: opts.label } : {}) });
  });
  return { converted, envVars: [`${prefix}_URL`, `${prefix}_API_KEY`] };
}

function projectKeys(doc: Document): string[] {
  if (doc.get("project", true)) return ["default"];
  const map = doc.get("projects", true) as { items?: { key: unknown }[] } | undefined;
  return (map?.items ?? []).map((p) => String((p.key as { value?: unknown })?.value ?? p.key));
}

/**
 * Rename a site's short name. Updates every sync and server token that refers to it.
 * The .env variable names stay as they are (the config still points at them).
 * A single `project:` is converted to `projects: { <newName>: … }`.
 */
export function renameProject(file: string, from: string, to: string) {
  if (!NAME_RE.test(to)) throw new Error("site names: letters, digits, - and _");
  editConfig(file, (doc) => {
    const names = projectKeys(doc);
    if (!names.includes(from)) throw new Error(`no site named "${from}"`);
    if (names.includes(to) && to !== from) throw new Error(`a site named "${to}" already exists`);
    const single = doc.get("project", true);
    if (single) {
      doc.delete("project");
      setIn(doc, ["projects", to], single);
    } else {
      const map = doc.get("projects", true) as { items: { key: { value?: unknown } | unknown }[] };
      const pair = map.items.find((p) => String((p.key as { value?: unknown })?.value ?? p.key) === from)!;
      pair.key = doc.createNode(to);
    }
    const syncs = doc.get("syncs", true) as { items?: { key: unknown }[] } | undefined;
    for (const pair of syncs?.items ?? []) {
      const name = String((pair.key as { value?: unknown })?.value ?? pair.key);
      if (doc.getIn(["syncs", name, "project"]) === from) setIn(doc, ["syncs", name, "project"], to);
    }
    const tokens = doc.getIn(["server", "tokens"], true) as { items?: unknown[] } | undefined;
    (tokens?.items ?? []).forEach((_t, i) => {
      const list = doc.getIn(["server", "tokens", i, "projects"]) as { toJSON?: () => string[] } | undefined;
      const arr = list?.toJSON?.();
      if (Array.isArray(arr) && arr.includes(from)) setIn(doc, ["server", "tokens", i, "projects"], arr.map((x) => (x === from ? to : x)));
    });
  });
}

/** Set (or clear, with an empty label) a site's display name. */
export function setProjectLabel(file: string, name: string, label: string) {
  editConfig(file, (doc) => {
    const base = doc.get("project", true) ? ["project"] : ["projects", name];
    if (!doc.getIn(base, true)) throw new Error(`no site named "${name}"`);
    setIn(doc, [...base, "label"], label.trim() || undefined);
  });
}

/** Remove a site from the config. Refuses while syncs still belong to it. Its .env values are left alone. */
export function removeProject(file: string, name: string, syncNames: string[]) {
  if (syncNames.length) throw new Error(`"${name}" still has syncs (${syncNames.join(", ")}); remove or move them first`);
  editConfig(file, (doc) => {
    const names = projectKeys(doc);
    if (!names.includes(name)) throw new Error(`no site named "${name}"`);
    if (names.length === 1) throw new Error("that's the only site; a config needs at least one");
    doc.deleteIn(["projects", name]);
  });
}

// ---------------------------------------------------------------------------
// Access tokens (server.tokens). Values live in .env as SYNC_TOKEN_<NAME>; the config refers to them.

export const tokenEnvVar = (name: string) => `SYNC_TOKEN_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

/** Remove KEY lines from .env. */
export function unsetEnv(dir: string, keys: string[]) {
  const p = path.join(dir, ".env");
  if (!existsSync(p)) return;
  const lines = readFileSync(p, "utf8").split(/\r?\n/).filter((l) => !keys.some((k) => new RegExp(`^\\s*(export\\s+)?${k}\\s*=`).test(l)));
  writeFileSync(p, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  for (const k of keys) delete process.env[k];
}

function tokenNames(doc: Document): string[] {
  const list = doc.getIn(["server", "tokens"]) as { toJSON?: () => { name: string }[] } | undefined;
  return (list?.toJSON?.() ?? []).map((t) => t.name);
}

/**
 * Create a token: a random value saved to .env, and an entry in server.tokens.
 * Returns the value, which is shown to the person once.
 */
export function addToken(file: string, opts: { name: string; scope: Scope; description?: string; projects?: string[]; syncs?: string[] }) {
  if (!NAME_RE.test(opts.name)) throw new Error("token names: letters, digits, - and _");
  const value = `fcs_${randomBytes(24).toString("hex")}`;
  const envVar = tokenEnvVar(opts.name);
  editConfig(file, (doc) => {
    if (tokenNames(doc).includes(opts.name)) throw new Error(`a token named "${opts.name}" already exists`);
    const entry = {
      name: opts.name, token: `\${${envVar}}`, scope: opts.scope,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.projects?.length ? { projects: opts.projects } : {}),
      ...(opts.syncs?.length ? { syncs: opts.syncs } : {}),
      created: new Date().toISOString().slice(0, 10),
    };
    if (doc.getIn(["server", "tokens"], true)) doc.addIn(["server", "tokens"], doc.createNode(entry));
    else setIn(doc, ["server", "tokens"], [entry]);
  });
  setEnv(path.dirname(file), { [envVar]: value });
  return { value, envVar };
}

/** Revoke a token: remove it from the config and its value from .env. Takes effect immediately on a running server. */
export function revokeToken(file: string, name: string) {
  let envVar: string | null = null;
  editConfig(file, (doc) => {
    const list = (doc.getIn(["server", "tokens"]) as { toJSON?: () => { name: string; token: string }[] } | undefined)?.toJSON?.() ?? [];
    const i = list.findIndex((t) => t.name === name);
    if (i < 0) throw new Error(`no token named "${name}"`);
    envVar = String(list[i].token).match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? null;
    doc.deleteIn(["server", "tokens", i]);
  });
  if (envVar) unsetEnv(path.dirname(file), [envVar]);
}

// ---------------------------------------------------------------------------
// Deleting syncs and sites from the program (never touches Framer).

const envRefs = (v: unknown): string[] => [...String(v ?? "").matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);

export interface DeleteResult {
  removedSyncs: string[];
  removedEnv: string[];
  tokensRevoked: string[];
  tokensChanged: string[];
  deletedFiles: string[];
  keptFiles: string[];
  /** The last site was deleted: config and .env are gone, so setup starts again. */
  reset?: boolean;
}

/** Variables still referenced anywhere in the config (so they mustn't be removed from .env). */
function referencedVars(doc: Document): Set<string> {
  return new Set(envRefs(doc.toString()));
}

function sourcePathOf(doc: Document, sync: string): string | null {
  const p = doc.getIn(["syncs", sync, "source", "path"]);
  return typeof p === "string" && !p.includes("${") ? p : null;
}

function deleteSourceFiles(dir: string, paths: string[], res: DeleteResult) {
  for (const p of paths) {
    const abs = path.resolve(dir, p);
    const rel = path.relative(dir, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) { res.keptFiles.push(`${p} (outside the project folder, left alone)`); continue; }
    if (!existsSync(abs)) continue;
    rmSync(abs, { recursive: true, force: true });
    res.deletedFiles.push(p);
  }
}

/** Remove syncs (by name) from the config document, collecting what else should go. */
function dropSyncs(doc: Document, names: string[], res: DeleteResult) {
  for (const name of names) {
    if (!doc.getIn(["syncs", name], true)) throw new Error(`no sync named "${name}"`);
    const source = doc.getIn(["syncs", name, "source"]) as { toJSON?: () => unknown } | undefined;
    res.removedEnv.push(...envRefs(JSON.stringify(source?.toJSON?.() ?? source ?? {})));
    doc.deleteIn(["syncs", name]);
    res.removedSyncs.push(name);
  }
  // Tokens limited to these syncs: drop them from the list; a token left with none is revoked.
  const tokens = (doc.getIn(["server", "tokens"]) as { toJSON?: () => { name: string; token: string; syncs?: string[] }[] } | undefined)?.toJSON?.() ?? [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (!t.syncs?.some((s) => names.includes(s))) continue;
    const left = t.syncs.filter((s) => !names.includes(s));
    if (left.length) { setIn(doc, ["server", "tokens", i, "syncs"], left); res.tokensChanged.push(t.name); }
    else { res.removedEnv.push(...envRefs(t.token)); doc.deleteIn(["server", "tokens", i]); res.tokensRevoked.push(t.name); }
  }
}

function finishEnv(file: string, doc: Document, res: DeleteResult) {
  const still = referencedVars(doc);
  res.removedEnv = [...new Set(res.removedEnv)].filter((v) => !still.has(v));
  if (res.removedEnv.length) unsetEnv(path.dirname(file), res.removedEnv);
}

/** Delete a sync from the program: its settings, saved secrets and token access. Framer isn't touched. */
export function deleteSync(file: string, name: string, opts: { deleteFiles?: boolean } = {}): DeleteResult {
  const res: DeleteResult = { removedSyncs: [], removedEnv: [], tokensRevoked: [], tokensChanged: [], deletedFiles: [], keptFiles: [] };
  let files: string[] = [];
  editConfig(file, (doc) => {
    const p = sourcePathOf(doc, name);
    if (p) files.push(p);
    dropSyncs(doc, [name], res);
    finishEnv(file, doc, res);
  });
  if (opts.deleteFiles) deleteSourceFiles(path.dirname(file), files, res);
  else res.keptFiles.push(...files);
  return res;
}

/**
 * Delete a site from the program, with all its syncs, saved URL/key and token access. Framer isn't touched.
 * Deleting the only site removes the config and .env, so the app starts at first-time setup.
 */
export function deleteSite(file: string, site: string, opts: { deleteFiles?: boolean } = {}): DeleteResult {
  const res: DeleteResult = { removedSyncs: [], removedEnv: [], tokensRevoked: [], tokensChanged: [], deletedFiles: [], keptFiles: [] };
  const dir = path.dirname(file);
  const doc0 = parseDocument(readFileSync(file, "utf8"));
  const sites = projectKeys(doc0);
  if (!sites.includes(site)) throw new Error(`no site named "${site}"`);
  const syncsOf = (doc: Document) => {
    const all = (doc.get("syncs", true) as { items?: { key: unknown }[] } | undefined)?.items ?? [];
    return all.map((p) => String((p.key as { value?: unknown })?.value ?? p.key))
      .filter((n) => sites.length === 1 || doc.getIn(["syncs", n, "project"]) === site);
  };
  const files = syncsOf(doc0).map((n) => sourcePathOf(doc0, n)).filter((p): p is string => !!p);

  if (sites.length === 1) {
    // The last site: reset everything local.
    res.removedSyncs.push(...syncsOf(doc0));
    rmSync(file, { force: true });
    rmSync(path.join(dir, ".env"), { force: true });
    rmSync(path.join(dir, ".framer-cms-sync", "state.json"), { force: true });
    res.reset = true;
  } else {
    editConfig(file, (doc) => {
      dropSyncs(doc, syncsOf(doc), res);
      const proj = doc.getIn(["projects", site]) as { toJSON?: () => unknown } | undefined;
      res.removedEnv.push(...envRefs(JSON.stringify(proj?.toJSON?.() ?? {})));
      doc.deleteIn(["projects", site]);
      // Tokens limited to this site.
      const tokens = (doc.getIn(["server", "tokens"]) as { toJSON?: () => { name: string; token: string; projects?: string[] }[] } | undefined)?.toJSON?.() ?? [];
      for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i];
        if (!t.projects?.includes(site)) continue;
        const left = t.projects.filter((x) => x !== site);
        if (left.length) { setIn(doc, ["server", "tokens", i, "projects"], left); res.tokensChanged.push(t.name); }
        else { res.removedEnv.push(...envRefs(t.token)); doc.deleteIn(["server", "tokens", i]); res.tokensRevoked.push(t.name); }
      }
      finishEnv(file, doc, res);
    });
  }
  if (opts.deleteFiles) deleteSourceFiles(dir, files, res);
  else res.keptFiles.push(...files);
  return res;
}
