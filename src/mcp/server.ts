// MCP server: the engine's operations as tools for AI agents.
// apply_sync requires the planId from plan_sync, so an agent can't skip the preview.
// Tools are filtered by scope; publish_site is separate so a client can withhold or gate it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import type { LoadedConfig } from "../config/load.ts";
import { hasScope, type Scope } from "../config/schema.ts";
import { createSync, type Sync } from "../engine.ts";
import { SyncError } from "../core/issues.ts";
import type { Connector } from "../framer/client.ts";
import type { SourceInput } from "../sources/index.ts";
import { VERSION } from "../version.ts";


const WORKFLOW = `Workflow: 1) plan_sync to preview; read issues (each has a fix). 2) Fix errors in the source data, plan again. ` +
  `3) apply_sync with the planId from the latest plan. 4) Publish only if the person asked: publishing ships the whole site. ` +
  `Never pass allowMassRemove or force without asking the person first. ` +
  `For single Markdown posts, add_posts / update_posts / remove_item write straight away (no plan) and keep the sync's folder in step.`;

const runShape = {
  complete: z.boolean().optional().describe("Records/text you pass are treated as PARTIAL (add and update, never remove) unless complete is true. Only set it when you're passing the full data set and want items missing from it removed."),
  partial: z.boolean().optional().describe("With no records/text, the sync's own source is complete; set partial to never remove."),
  createOnly: z.boolean().optional().describe("Only add new items; existing items are left untouched; nothing is removed."),
  updateOnly: z.boolean().optional().describe("Only update existing items (matched by slug); new items are left out; nothing is removed."),
  replace: z.boolean().optional().describe("Replace all: make the collection match the data, removing items whose slug isn't in it. Needs complete data; only when the person asked for it."),
};
type RunArgs = { complete?: boolean; partial?: boolean; createOnly?: boolean; updateOnly?: boolean; replace?: boolean };
const runOpts = (a: InputArgs & RunArgs) => {
  const given = a.records !== undefined || a.text !== undefined;
  return { partial: given ? a.complete !== true && a.replace !== true : a.partial === true, createOnly: a.createOnly === true, updateOnly: a.updateOnly === true, replace: a.replace === true };
};

const inputShape = {
  sync: z.string().describe("Sync name from list_syncs"),
  records: z.unknown().optional().describe("JSON records: an array of objects, or {rows:[...]}. For Markdown syncs: {posts:[{slug, markdown}]}"),
  text: z.string().optional().describe("Raw CSV, JSON or Markdown text"),
  files: z.array(z.string()).optional().describe("Local files, folders or globs (relative to the config folder)"),
};

type InputArgs = { sync: string; records?: unknown; text?: string; files?: string[] };

function toInput(a: InputArgs, dir: string): SourceInput | undefined {
  if (a.records !== undefined) return { records: a.records };
  if (a.text !== undefined) return { text: a.text };
  if (a.files?.length) return { files: a.files.map((f) => path.resolve(dir, f)) };
  return undefined;
}

const result = (data: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

async function run(fn: () => Promise<unknown>) {
  try {
    const out = await fn();
    const failed = !!out && typeof out === "object" && (out as { ok?: boolean }).ok === false;
    return result(out, failed);
  } catch (e) {
    if (e instanceof SyncError) return result(e.toJSON(), true);
    return result({ ok: false, error: { message: String((e as Error)?.message ?? e) } }, true);
  }
}

export function createMcpServer(loaded: LoadedConfig, opts: { scope: Scope; connect?: Connector; connectors?: Record<string, Connector>; engine?: Sync }) {
  const sync = opts.engine ?? createSync({ config: loaded.config, configDir: loaded.dir, configFile: loaded.file, connect: opts.connect, connectors: opts.connectors, actor: "mcp" });
  const server = new McpServer({ name: "framer-cms-sync", version: VERSION }, { instructions: `Keeps Framer CMS collections in sync with data. ${WORKFLOW}` });
  const can = (s: Scope) => hasScope(opts.scope, s);
  const tool = (name: string, cfg: Record<string, unknown>, cb: (a: any) => Promise<unknown>) => // eslint-disable-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(name, cfg, cb); // eslint-disable-line @typescript-eslint/no-explicit-any
  const readOnly = { readOnlyHint: true, openWorldHint: true };
  const writes = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

  const projectArg = { project: z.string().optional().describe("Project (site) name from list_projects; needed when there are several") };
  tool("list_projects", { title: "List projects", description: "The Framer projects (sites) in the config and the syncs that belong to each.", inputSchema: {}, annotations: readOnly },
    () => run(async () => (await sync.projects()).map(({ url: _u, ...p }) => p)));
  tool("list_collections", { title: "List Framer collections", description: "Every CMS collection in a project, with who owns it and whether this tool can write to it.", inputSchema: projectArg, annotations: readOnly },
    (a) => run(() => sync.collections({ project: a.project })));
  tool("get_fields", { title: "Get collection fields", description: "A collection's fields (name, id, type, enum options).", inputSchema: { collection: z.string().describe("Collection name or id"), ...projectArg }, annotations: readOnly },
    (a) => run(() => sync.fields(a.collection, { project: a.project })));
  tool("list_syncs", { title: "List syncs", description: "The configured syncs: source, target collection, publish and prune settings.", inputSchema: {}, annotations: readOnly },
    async () => run(async () => sync.syncs()));
  tool("check_sync", { title: "Check a sync", description: "Compare source data with the collection: unmatched keys, fields nothing writes, slug check against schemaFrom.", inputSchema: inputShape, annotations: readOnly },
    (a) => run(() => sync.check(a.sync, toInput(a, loaded.dir))));
  tool("get_mappings", {
    title: "Get field mappings", description: "How each column of the sync's data is matched to a collection field: the field, how it matched (your mapping, standard name, same name, similar name, ignored, no match), rows and a sample value; plus fields nothing writes to. Use it when a preview warns that a column doesn't match.",
    inputSchema: { sync: z.string() }, annotations: readOnly,
  }, (a) => run(() => sync.mappings(a.sync)));
  tool("inspect_source", {
    title: "Inspect source data",
    description: "See what data looks like before setting up or fixing a sync: its format, where the records are (for nested JSON), and every field with its type and sample values (nested values as paths like price.amount). Give a sync (its configured source is fetched live, GET only), or the records/text you'd send to apply. A url can be inspected only with admin scope. Nothing is stored.",
    inputSchema: {
      sync: z.string().optional(), records: z.unknown().optional(), text: z.string().optional(),
      url: z.string().optional().describe("Admin scope only"), rows: z.string().optional().describe("Dotted path to the list of records in a JSON document, e.g. data.items"),
    },
    annotations: readOnly,
  }, (a) => run(async () => {
    if (a.url && !can("admin")) throw new SyncError("FORBIDDEN", "inspecting an arbitrary URL needs admin scope", { fix: "inspect a sync's configured source, or pass the data itself" });
    return sync.inspect({ sync: a.sync, records: a.records, text: a.text, url: a.url, rows: a.rows });
  }));
  tool("list_items", { title: "List items", description: "Items currently in a sync's collection (slug, draft).", inputSchema: { sync: z.string() }, annotations: readOnly },
    (a) => run(() => sync.items(a.sync)));
  tool("plan_sync", {
    title: "Preview a sync", description: `Dry run: what would be created, updated and removed, plus problems with fixes. Writes nothing. Returns a planId for apply_sync. ${WORKFLOW}`,
    inputSchema: { ...inputShape, ...runShape }, annotations: readOnly,
  }, (a) => run(() => sync.plan(a.sync, toInput(a, loaded.dir), runOpts(a))));
  tool("plan_redirects", { title: "Preview redirects", description: "Dry run for a list of redirects: add/update/unchanged, plus errors (live pages, chains).", inputSchema: { redirects: z.string().describe("CSV with from,to header, or JSON [{from,to}]"), ...projectArg }, annotations: readOnly },
    (a) => run(() => sync.redirects.plan(a.redirects, { project: a.project })));
  tool("describe", { title: "Describe the tool", description: "Config keys, field types, issue codes and the recommended workflow.", inputSchema: {}, annotations: readOnly },
    async () => run(async () => sync.describe()));

  if (can("write")) {
    tool("apply_sync", {
      title: "Apply a sync", description: "Write the changes from a plan. Requires planId from plan_sync on the same input; refuses if the data or collection changed. Does not publish unless publish is set (needs publish scope).",
      inputSchema: { ...inputShape, ...runShape, planId: z.string().describe("planId from plan_sync (made with the same complete/partial/createOnly settings)"), publish: z.union([z.boolean(), z.literal("on-change")]).optional(), allowMassRemove: z.boolean().optional().describe("Only with the person's explicit approval") },
      annotations: writes,
    }, (a) => run(async () => {
      if (a.publish && !can("publish")) throw new SyncError("FORBIDDEN", "this MCP server can't publish (scope " + opts.scope + ")", { fix: "apply without publish, and ask the person to publish" });
      if (a.allowMassRemove && !can("admin")) throw new SyncError("FORBIDDEN", "allowMassRemove needs admin scope");
      return sync.apply(a.sync, toInput(a, loaded.dir), { ...runOpts(a), planId: a.planId, requirePlanId: true, publish: a.publish ?? false, allowMassRemove: a.allowMassRemove });
    }));
    tool("set_mappings", {
      title: "Change field mappings", description: 'Change which collection field a column goes to. Each change: { column, to } where to is a field name, "ignore" (never send this column) or "auto" (back to automatic matching). Saved to the config; preview again afterwards to see the effect.',
      inputSchema: { sync: z.string(), changes: z.array(z.object({ column: z.string(), to: z.string() })).min(1) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, (a) => run(() => sync.setMappings(a.sync, a.changes)));
    const postsShape = {
      sync: z.string(),
      posts: z.array(z.object({ markdown: z.string().describe("The whole post: --- frontmatter --- then the body"), slug: z.string().optional().describe("Only needed if the frontmatter has no slug") })).min(1),
      publish: z.union([z.boolean(), z.literal("on-change")]).optional().describe("Needs publish scope; only when the person asked"),
    };
    const postsRun = (kind: "add" | "update") => (a: { sync: string; posts: { markdown: string; slug?: string }[]; publish?: boolean | "on-change" }) => run(async () => {
      if (a.publish && !can("publish")) throw new SyncError("FORBIDDEN", "this MCP server can't publish (scope " + opts.scope + ")", { fix: "leave publish out, and ask the person to publish" });
      return kind === "add" ? sync.addPosts(a.sync, a.posts, { publish: a.publish ?? false }) : sync.updatePosts(a.sync, a.posts, { publish: a.publish ?? false });
    });
    tool("add_posts", {
      title: "Add Markdown posts", description: "Markdown syncs only. Add new posts to the collection straight away (no plan needed) and save them into the sync's folder. Refuses slugs that already exist (use update_posts). Never touches other items.",
      inputSchema: postsShape, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, postsRun("add"));
    tool("update_posts", {
      title: "Update Markdown posts", description: "Markdown syncs only. Update existing posts, matched by slug, straight away and in the sync's folder. Refuses slugs that don't exist yet (use add_posts). Never touches other items.",
      inputSchema: postsShape, annotations: writes,
    }, postsRun("update"));
    tool("remove_item", {
      title: "Remove an item", description: "Delete one item by slug. For Markdown syncs its file is deleted from the sync's folder too (keepFile to keep it). With redirectTo, also adds a redirect from its page to another item's page and re-points redirects that pointed at it.",
      inputSchema: { sync: z.string(), slug: z.string(), redirectTo: z.string().optional(), keepFile: z.boolean().optional() }, annotations: writes,
    }, (a) => run(() => sync.remove(a.sync, a.slug, { redirectTo: a.redirectTo, keepFile: a.keepFile })));
    tool("apply_redirects", { title: "Apply redirects", description: "Add or update redirects. Nothing is written if plan_redirects would report errors.", inputSchema: { redirects: z.string(), ...projectArg }, annotations: writes },
      (a) => run(() => sync.redirects.apply(a.redirects, { project: a.project })));
  }
  if (can("publish")) {
    tool("publish_site", { title: "Publish the site", description: "Publish and deploy the WHOLE site as it is now (not just CMS changes). Only when the person asked.", inputSchema: { deploy: z.boolean().optional().describe("false = preview deployment only"), ...projectArg }, annotations: writes },
      (a) => run(() => sync.publish({ deploy: a.deploy, project: a.project })));
  }
  if (can("admin")) {
    tool("setup_collection", { title: "Set up a managed collection", description: "Create the sync's managed collection and copy fields from schemaFrom. Never overwrites existing fields.", inputSchema: { sync: z.string() }, annotations: writes },
      (a) => run(() => sync.setup(a.sync, { force: false })));
  }

  server.registerResource("describe", "framer-cms-sync://describe", { title: "framer-cms-sync reference", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(sync.describe(), null, 2) }] }));

  return server;
}

export async function runMcpStdio(loaded: LoadedConfig, opts: { scope: Scope }) {
  const server = createMcpServer(loaded, opts);
  await server.connect(new StdioServerTransport());
}
