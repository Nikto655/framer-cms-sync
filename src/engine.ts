// The engine: one API used by every interface (library, CLI, terminal app, HTTP, MCP).

import type { Config, PublishMode, SyncConfig } from "./config/schema.ts";
import type { Connector, FramerClient } from "./framer/client.ts";
import type { CollectionInfo, FieldDef, Mode, PublishInfo, SourceRecord } from "./types.ts";
import { framerConnector } from "./framer/adapter.ts";
import { asKind, loadSource, type Loaded, type SourceInput } from "./sources/index.ts";
import { fieldMatcher, mapRecords, type MatchHow } from "./core/map.ts";
import { buildPlan, executePlan, type Plan } from "./core/plan.ts";
import { changedCount, PUBLISH_NOTE, toReport, type SyncReport } from "./core/report.ts";
import { fieldId, keyToSlug } from "./core/identity.ts";
import { inferFields } from "./core/infer.ts";
import { issue, SyncError, scrub, ISSUE_CODES, ERROR_CODES, type Issue } from "./core/issues.ts";
import { appendRunLog, createQueue, loadPlugins, readRunLog, withTimeout, type Plugin, type RunLogEntry } from "./core/runtime.ts";
import { applyRedirectPlan, parseRedirects, planRedirects, toPath } from "./redirects/index.ts";
import { editConfig, setIn } from "./config/write.ts";
import { inspectSource, type InspectTarget, type InspectReport } from "./inspect.ts";
import { writeItems, writeTemplate, type FileFormat, type WriteResult } from "./export.ts";
import nodePath from "node:path";
import { deletePost, postFolder, requireMarkdown, savePost, slugOf, type Post, type PostFile } from "./core/posts.ts";
import { isMarkdownFile } from "./core/filetypes.ts";
import { isGoogleSheet } from "./formats.ts";
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";

export interface EngineOptions {
  config: Config;
  configDir: string;
  /** Path of the config file; lets `setup` save a new collection id back. */
  configFile?: string;
  /** Override the Framer connection for every project (tests, custom transports). */
  connect?: Connector;
  /** Override the connection per project name. */
  connectors?: Record<string, Connector>;
  /** Site to use for site-wide operations when several exist and none is named (the "current" site). */
  defaultProject?: string;
  /** Share write queues between engine instances (the server rebuilds its engine when the config changes). */
  queues?: Map<string, ReturnType<typeof createQueue>>;
  /** Name recorded in the run log: "cli", "tui", a token name, "mcp". */
  actor?: string;
}

export interface PlanOptions {
  limit?: number;
  only?: string[];
  full?: boolean;
  /** Treat the data as only part of the full set: add and update, never remove. */
  partial?: boolean;
  /** Add new items only; leave existing items untouched; never remove. */
  createOnly?: boolean;
  /** Update existing items only; skip new ones; never remove. */
  updateOnly?: boolean;
  /** Replace all: make the collection match the data, removing items whose slug isn't in it. */
  replace?: boolean;
}
export interface ApplyOptions extends PlanOptions {
  /** true/false override the sync's publish setting; "on-change" publishes only if something changed. */
  publish?: boolean | "on-change";
  deploy?: boolean;
  /** Refuse unless this matches a fresh plan of the same input. */
  planId?: string;
  requirePlanId?: boolean;
  allowMassRemove?: boolean;
  /** Refuse (rather than skip) items an only-add run finds existing, or an only-update run finds missing. */
  strict?: boolean;
}

export interface PostOptions { publish?: boolean | "on-change"; deploy?: boolean }

/** Pass `project` to pick a site when the config has several; optional when there's one. */
export interface ProjectOption { project?: string }

export interface MappingChange { column: string; to: string }
export interface MappingColumn {
  column: string;
  field: { name: string; id: string; type: string } | null;
  how: MatchHow | "ignored";
  rows: number;
  sample?: unknown;
  inData: boolean;
  ambiguous?: string[];
  shadowedBy?: string;
  mappedTo?: string;
}
export interface MappingReport {
  sync: string;
  project: string;
  collection: { id: string; name: string };
  source: { from: string; records: number } | null;
  key?: string;
  columns: MappingColumn[];
  unusedFields: { name: string; id: string; type: string }[];
  fields: { name: string; id: string; type: string }[];
  note?: string;
}

export interface CollectionView extends CollectionInfo { writable: boolean; mode: Mode | null; note: string; short: string }

const OWNERSHIP_NOTE: Record<CollectionInfo["ownership"], string> = {
  this: "created by this API key (managed): full control, including fields",
  user: "built by hand in Framer (unmanaged): the tool can fill it; fields are managed in Framer",
  other: "owned by another plugin: Framer doesn't allow writes. Run `setup` with a new collection name to make your own copy",
};

const OWNERSHIP_SHORT: Record<CollectionInfo["ownership"], string> = {
  this: "managed by this tool · full control",
  user: "hand-built · the tool fills it as it is",
  other: "another plugin's · can't write; make a copy",
};

export function createSync(opts: EngineOptions) {
  const { config, configDir } = opts;
  const projectNames = Object.keys(config.projects);
  const queues = opts.queues ?? new Map<string, ReturnType<typeof createQueue>>();
  /** One write queue per project: writes to the same site never overlap; different sites can run in parallel. */
  const queueFor = (project: string) => { if (!queues.has(project)) queues.set(project, createQueue()); return queues.get(project)!; };
  const connectors = new Map<string, Connector>();
  const connectorFor = (project: string): Connector => {
    if (!connectors.has(project)) {
      const p = config.projects[project];
      connectors.set(project, opts.connectors?.[project] ?? opts.connect ?? framerConnector(p.url, p.apiKey, project));
    }
    return connectors.get(project)!;
  };
  const secrets = [...Object.values(config.projects).map((p) => p.apiKey), ...config.server.tokens.map((t) => t.token)];

  /** Resolve a project name: the given one, or the only one. */
  function projectFor(name?: string): string {
    if (name) {
      if (!config.projects[name]) throw new SyncError("NOT_FOUND", `no project named "${name}"`, { fix: `use one of: ${projectNames.join(", ")}` });
      return name;
    }
    if (projectNames.length === 1) return projectNames[0];
    if (opts.defaultProject && config.projects[opts.defaultProject]) return opts.defaultProject;
    throw new SyncError("INPUT_INVALID", "this config has several sites; say which one", { fix: `pass a site: ${projectNames.join(", ")} (CLI: --project <name>, or set the current site with \`projects use <name>\`)` });
  }
  let pluginsP: Promise<Required<Plugin>> | null = null;
  const plugins = () => (pluginsP ??= loadPlugins(config.plugins, configDir));

  async function withClient<T>(project: string, fn: (c: FramerClient) => Promise<T>): Promise<T> {
    const client = await connectorFor(project)();
    try {
      return await withTimeout(fn(client), config.defaults.timeoutSeconds, "the operation");
    } catch (e) {
      if (e instanceof SyncError) { e.message = scrub(e.message, secrets); throw e; }
      // Framer's own failures are already FRAMER_ERROR (see the adapter); anything else is ours.
      throw new SyncError("INTERNAL_ERROR", scrub(String((e as Error)?.message ?? e), secrets), { fix: "this is a bug in framer-cms-sync; please report it with the command you ran" });
    } finally {
      await client.disconnect();
    }
  }

  async function log(entry: Omit<RunLogEntry, "at" | "actor">) {
    if (!config.runLog) return;
    await appendRunLog(configDir, { at: new Date().toISOString(), actor: opts.actor ?? "library", ...entry }).catch(() => {});
  }

  function getSync(name: string): SyncConfig {
    const s = config.syncs[name];
    if (!s) {
      const names = Object.keys(config.syncs);
      throw new SyncError("SYNC_NOT_FOUND", `no sync named "${name}"`, { fix: names.length ? `use one of: ${names.join(", ")}` : "add one under syncs: in the config" });
    }
    return s;
  }

  function findCollection(list: CollectionInfo[], ref: { id?: string; name?: string } | string): CollectionInfo | undefined {
    const r = typeof ref === "string" ? { id: ref, name: ref } : ref;
    return (r.id ? list.find((c) => c.id === r.id) : undefined)
      ?? (r.name ? list.find((c) => c.name === r.name) ?? list.find((c) => c.name.toLowerCase() === r.name!.toLowerCase()) : undefined);
  }

  async function resolveTarget(client: FramerClient, name: string, sync: SyncConfig): Promise<{ info: CollectionInfo; mode: Mode }> {
    const list = await client.listCollections();
    const info = findCollection(list, sync.collection);
    const label = sync.collection.name ?? sync.collection.id;
    if (!info) {
      throw new SyncError("COLLECTION_NOT_FOUND", `collection "${label}" not found in this project`,
        { fix: sync.collection.create ? `run \`setup ${name}\` to create it` : `check the name (see \`collections\`), or set collection.create: true and run \`setup ${name}\`` });
    }
    if (info.ownership === "other")
      throw new SyncError("COLLECTION_FOREIGN_PLUGIN", `"${info.name}" is owned by another plugin, and Framer doesn't allow anyone else to write to it`,
        { fix: `make your own copy: set collection: { name: "${info.name} Synced", create: true }, schemaFrom: "${info.name}", run \`setup ${name}\`, then point your page template at the new collection in Framer` });
    const wanted = sync.collection.mode;
    if (wanted === "managed" && info.ownership !== "this")
      throw new SyncError("COLLECTION_NOT_MANAGED", `"${info.name}" was built by hand, so it isn't managed by this key`,
        { fix: "use mode: unmanaged (or auto) to fill it as it is, or create a managed copy with `setup`" });
    return { info, mode: info.ownership === "this" ? "managed" : "unmanaged" };
  }

  async function applyTransform(name: string, sync: SyncConfig, records: SourceRecord[], issues: Issue[]): Promise<SourceRecord[]> {
    if (!sync.transform) return records;
    const fn = (await plugins()).transforms[sync.transform];
    if (!fn) throw new SyncError("CONFIG_INVALID", `transform "${sync.transform}" not found in any plugin`, { fix: "check plugins: and the transform name" });
    const out: SourceRecord[] = [];
    for (const r of records) {
      try {
        const data = await fn({ ...r.data }, { sync: name, origin: r.origin });
        if (data) out.push({ ...r, data });
      } catch (e) {
        issues.push(issue("error", "TRANSFORM_FAILED", `${r.origin}: transform failed: ${(e as Error).message}`, { record: r.origin }));
      }
    }
    return out;
  }

  async function preparePlan(client: FramerClient, name: string, input: SourceInput | undefined, po: PlanOptions): Promise<Plan> {
    const sync = getSync(name);
    if ([po.createOnly, po.updateOnly, po.replace].filter(Boolean).length > 1)
      throw new SyncError("INPUT_INVALID", "choose one of: only add new, only update existing, or replace all");
    const { info, mode } = await resolveTarget(client, name, sync);
    const fields = await client.getFields(info.id);
    const loaded = await load(sync, input);
    const issues = [...loaded.issues];
    const s = shaped(sync, loaded);
    const records = await applyTransform(name, s, loaded.records, issues);
    const mapped = mapRecords(records, fields, s);
    return buildPlan(client, {
      syncName: name, sync: s, collection: info, mode, fields, items: mapped.items, issues: [...issues, ...mapped.issues],
      source: { from: loaded.from, records: loaded.records.length, complete: loaded.complete && !po.partial }, limit: po.limit, only: po.only, createOnly: po.createOnly, updateOnly: po.updateOnly, replace: po.replace,
    });
  }

  async function writePosts(name: string, posts: Post[], kind: "add" | "update", o: PostOptions): Promise<SyncReport & { files: PostFile[] }> {
    const sync = getSync(name);
    requireMarkdown(name, sync);
    if (!posts.length) throw new SyncError("NO_INPUT", `nothing to ${kind}: give one or more Markdown posts`);
    const report = await api.apply(name, { records: { posts: posts.map((p) => ({ markdown: p.markdown, slug: p.slug })) } },
      { partial: true, createOnly: kind === "add", updateOnly: kind === "update", strict: true, publish: o.publish, deploy: o.deploy });
    const files: PostFile[] = [];
    const folder = postFolder(sync, configDir);
    if (report.ok && report.applied && folder) {
      for (const p of posts) { const slug = slugOf(p, sync); if (slug) { const f = savePost(folder, slug, p, sync); files.push({ ...f, file: f.file && nodePath.relative(configDir, f.file) }); } }
    }
    return { ...report, files };
  }

  /** Read a sync's data: what was sent, or its own source. */
  const load = async (sync: SyncConfig, input?: SourceInput) => loadSource(sync, input, { baseDir: configDir, lintRules: (await plugins()).lintRules });

  /** A pass-through sync takes on the shape of whatever was sent (posts or rows). */
  const shaped = (sync: SyncConfig, loaded: Loaded): SyncConfig => (loaded.as ? asKind(sync, loaded.as) : sync);

  async function doPublish(client: FramerClient, deploy: boolean): Promise<PublishInfo> {
    const { deploymentId, hostnames } = await client.publish();
    if (!deploy) return { deploymentId, deployed: false, hostnames };
    return { deploymentId, deployed: true, hostnames: await client.deploy(deploymentId) };
  }

  function publishMode(sync: SyncConfig | null, o: boolean | "on-change" | undefined): PublishMode {
    if (o === true) return "always";
    if (o === false) return "never";
    if (o === "on-change") return "on-change";
    return sync?.publish ?? config.defaults.publish;
  }

  const projectOf = (syncName: string) => getSync(syncName).project!;

  async function getMappings(name: string, input?: SourceInput): Promise<MappingReport> {
    return withClient(projectOf(name), async (c) => {
      const sync = getSync(name);
      const { info } = await resolveTarget(c, name, sync);
      const fields = await c.getFields(info.id);
      const matcher = fieldMatcher(fields, sync);
      const ignore = new Set(sync.fields.ignore);
      const cols = new Map<string, { rows: number; sample: unknown }>();
      let source: MappingReport["source"] = null, note: string | undefined;
      try {
        const loaded = await load(sync, input);
        source = { from: loaded.from, records: loaded.records.length };
        for (const r of loaded.records) for (const [k, v] of Object.entries(r.data)) {
          if (k.startsWith("__")) continue;
          const e = cols.get(k) ?? { rows: 0, sample: undefined };
          e.rows++;
          if (e.sample === undefined && v !== null && v !== undefined && v !== "") e.sample = typeof v === "string" && v.length > 60 ? v.slice(0, 60) + "…" : v;
          cols.set(k, e);
        }
      } catch (e) {
        if (!(e instanceof SyncError && e.code === "NO_INPUT")) throw e;
        note = "the sync has no source.path or source.url, so only the saved mappings are shown";
      }
      // Saved mappings and ignores for columns not in the data still show, so they can be cleaned up.
      for (const k of [...Object.keys(sync.fields.map), ...sync.fields.ignore]) if (!cols.has(k)) cols.set(k, { rows: 0, sample: undefined });
      const claimed = new Map<string, string>();
      const columns = [...cols.entries()].map(([column, e]) => {
        const base = { column, rows: e.rows, sample: e.sample, inData: e.rows > 0 };
        if (ignore.has(column)) return { ...base, field: null, how: "ignored" as const };
        const m = matcher.match(column);
        const field = m.field ? { name: m.field.name, id: m.field.id, type: m.field.type } : null;
        let shadowedBy: string | undefined;
        if (m.field) { if (claimed.has(m.field.id)) shadowedBy = claimed.get(m.field.id); else claimed.set(m.field.id, column); }
        return { ...base, field, how: m.how, ...(m.ambiguous ? { ambiguous: m.ambiguous } : {}), ...(shadowedBy ? { shadowedBy } : {}),
          ...(m.how === "map-missing" ? { mappedTo: sync.fields.map[column] } : {}) };
      });
      const used = new Set(columns.filter((c) => c.field && !("shadowedBy" in c && c.shadowedBy)).map((c) => c.field!.id));
      return {
        sync: name, project: sync.project!, collection: { id: info.id, name: info.name }, source, key: sync.key?.field ?? (sync.source.type === "markdown" ? "slug" : undefined),
        columns, unusedFields: fields.filter((f) => !used.has(f.id) && f.type !== "divider").map((f) => ({ name: f.name, id: f.id, type: f.type })),
        fields: fields.filter((f) => f.type !== "divider").map((f) => ({ name: f.name, id: f.id, type: f.type })),
        ...(note ? { note } : {}),
      };
    });
  }

  async function setMappings(name: string, changes: MappingChange[]): Promise<MappingReport> {
    const sync = getSync(name);
    if (!opts.configFile) throw new SyncError("CONFIG_INVALID", "mappings can only be changed when the config was loaded from a file");
    if (!Array.isArray(changes) || !changes.length) throw new SyncError("INPUT_INVALID", "no changes given", { fix: 'send changes: [{ column, to }] where to is a field name, "ignore" or "auto"' });
    const resolved = await withClient(projectOf(name), async (c) => {
      const { info } = await resolveTarget(c, name, sync);
      const fields = await c.getFields(info.id);
      const matcher = fieldMatcher(fields, sync);
      return changes.map((ch) => {
        if (!ch || typeof ch.column !== "string" || !ch.column) throw new SyncError("INPUT_INVALID", "each change needs a column");
        const to = String(ch.to ?? "");
        if (to === "ignore" || to === "auto") return { column: ch.column, to };
        const f = matcher.resolve(to);
        if (!f || f.type === "divider") throw new SyncError("INPUT_INVALID", `"${info.name}" has no field "${to}"`, { fix: `use one of: ${fields.filter((x) => x.type !== "divider").map((x) => x.name).join(", ")}, or "ignore" / "auto"` });
        return { column: ch.column, to: f.name };
      });
    });
    const map = { ...sync.fields.map };
    const ignore = new Set(sync.fields.ignore);
    for (const r of resolved) {
      if (r.to === "ignore") { delete map[r.column]; ignore.add(r.column); }
      else if (r.to === "auto") { delete map[r.column]; ignore.delete(r.column); }
      else { map[r.column] = r.to; ignore.delete(r.column); }
    }
    editConfig(opts.configFile, (doc) => {
      setIn(doc, ["syncs", name, "fields", "map"], Object.keys(map).length ? map : undefined);
      setIn(doc, ["syncs", name, "fields", "ignore"], ignore.size ? [...ignore] : undefined);
    });
    sync.fields.map = map;
    sync.fields.ignore = [...ignore];
    await log({ op: "mappings", project: sync.project, sync: name, ok: true, counts: { changed: resolved.length } });
    return getMappings(name);
  }

  const listSyncs = () =>
    Object.entries(config.syncs).map(([name, s]) => ({
      name, project: s.project!, description: s.description, collection: s.collection.name ?? s.collection.id!, mode: s.collection.mode,
      source: s.source.type === "none" ? "(sent in: agents, HTTP, CLI)" : s.source.path ?? s.source.url ?? `(${s.source.type} body)`, sourceType: s.source.type,
      publish: s.publish ?? config.defaults.publish, prune: !!s.prune, path: s.path,
    }));

  const api = {
    config,
    configDir,

    projectNames,
    /** The site used when none is named: the only one, or the current one. */
    currentProject: projectNames.length === 1 ? projectNames[0] : (opts.defaultProject && config.projects[opts.defaultProject] ? opts.defaultProject : null),

    /** The configured projects, with their syncs. `check: true` connects to each one. */
    async projects(po: { check?: boolean } = {}) {
      return Promise.all(projectNames.map(async (name) => {
        const p = config.projects[name];
        const base = { name, label: p.label, url: p.url, syncs: listSyncs().filter((s) => s.project === name).map((s) => s.name) };
        if (!po.check) return base;
        try {
          return { ...base, ok: true, ...(await withClient(name, async (c) => ({ framerName: await c.projectName(), collections: (await c.listCollections()).length }))) };
        } catch (e) { return { ...base, ok: false, error: (e as Error).message, fix: (e as SyncError).fix }; }
      }));
    },

    async project(po: ProjectOption = {}) {
      const p = projectFor(po.project);
      return withClient(p, async (c) => ({ project: p, name: await c.projectName(), collections: (await c.listCollections()).length }));
    },

    async collections(po: ProjectOption = {}): Promise<CollectionView[]> {
      return withClient(projectFor(po.project), async (c) => (await c.listCollections()).map((col) => ({
        ...col, writable: col.ownership !== "other", mode: col.ownership === "this" ? "managed" : col.ownership === "user" ? "unmanaged" : null,
        note: OWNERSHIP_NOTE[col.ownership], short: OWNERSHIP_SHORT[col.ownership],
      })));
    },

    async fields(ref: string, po: ProjectOption = {}): Promise<{ collection: CollectionInfo; fields: FieldDef[] }> {
      return withClient(projectFor(po.project), async (c) => {
        const col = findCollection(await c.listCollections(), ref);
        if (!col) throw new SyncError("COLLECTION_NOT_FOUND", `collection "${ref}" not found`, { fix: "see `collections` for names and ids" });
        return { collection: col, fields: await c.getFields(col.id) };
      });
    },

    syncs: listSyncs,
    /** A sync's settings (with defaults filled in). */
    syncConfig: (name: string) => getSync(name),

    async plan(name: string, input?: SourceInput, po: PlanOptions = {}): Promise<SyncReport> {
      const startedAt = Date.now();
      return withClient(projectOf(name), async (c) => toReport(await preparePlan(c, name, input, po), { operation: "plan", startedAt, full: po.full }));
    },

    async apply(name: string, input?: SourceInput, ao: ApplyOptions = {}): Promise<SyncReport> {
      const startedAt = Date.now();
      const project = projectOf(name);
      return queueFor(project)(() => withClient(project, async (c) => {
        const sync = getSync(name);
        const plan = await preparePlan(c, name, input, ao);
        if (ao.requirePlanId && !ao.planId)
          throw new SyncError("PLAN_REQUIRED", "apply needs the planId from a plan of the same data", { fix: "run plan first and pass its planId" });
        if (ao.planId && ao.planId !== plan.planId)
          throw new SyncError("PLAN_STALE", "the data or the collection changed since that plan", { fix: "run plan again, review it, and apply with the new planId" });
        if (ao.strict) {
          const skipped = plan.items.filter((i) => i.status === "skipped");
          if (skipped.length && ao.createOnly)
            throw new SyncError("ITEM_EXISTS", `already in "${plan.collection.name}": ${skipped.map((i) => i.slug).join(", ")}`, { fix: `use \`update ${name}\` to change ${skipped.length === 1 ? "it" : "them"}` });
          if (skipped.length && ao.updateOnly)
            throw new SyncError("ITEM_NOT_FOUND", `not in "${plan.collection.name}" yet: ${skipped.map((i) => i.slug).join(", ")}`, { fix: `use \`add ${name}\` to add ${skipped.length === 1 ? "it" : "them"}` });
        }
        let applied;
        try {
          applied = await executePlan(c, plan, { chunkSize: config.defaults.chunkSize, allowMassRemove: ao.allowMassRemove });
        } catch (e) {
          if (e instanceof SyncError && e.code === "VALIDATION_FAILED") {
            await log({ op: "apply", project, sync: name, ok: false, error: e.message });
            return toReport(plan, { operation: "apply", applied: null, startedAt, full: ao.full });
          }
          await log({ op: "apply", project, sync: name, ok: false, error: (e as Error).message });
          throw e;
        }
        if (ao.allowMassRemove) for (const i of plan.issues) if (i.code === "PRUNE_GUARD" && i.level === "error") {
          i.level = "warning"; i.message += " (allowed with --allow-mass-remove)"; delete i.fix;
        }
        const mode = publishMode(sync, ao.publish);
        const shouldPublish = mode === "always" || (mode === "on-change" && changedCount(applied, plan) > 0);
        const pub = shouldPublish ? await doPublish(c, ao.deploy ?? config.defaults.deploy) : null;
        await log({ op: "apply", project, sync: name, ok: true, counts: { written: applied.upserted, removed: applied.removed, drafted: applied.drafted }, deploymentId: pub?.deploymentId });
        return toReport(plan, { operation: "apply", applied, publish: pub, startedAt, full: ao.full });
      }));
    },

    /** Add new Markdown posts: written to Framer straight away and saved into the sync's folder. */
    async addPosts(name: string, posts: Post[], o: PostOptions = {}) { return writePosts(name, posts, "add", o); },
    /** Update existing Markdown posts (matched by slug), in Framer and in the sync's folder. */
    async updatePosts(name: string, posts: Post[], o: PostOptions = {}) { return writePosts(name, posts, "update", o); },

    /**
     * Make sure the sync's collection exists and has fields.
     * - Missing + collection.create: creates it. mode: unmanaged creates a regular Framer collection;
     *   otherwise a managed one (owned by this tool).
     * - Fields: copied from schemaFrom, or worked out from the source data.
     * - Never overwrites existing fields, except a managed collection with force.
     */
    async setup(name: string, so: { force?: boolean } = {}) {
      const project = projectOf(name);
      return queueFor(project)(() => withClient(project, async (c) => {
        const sync = getSync(name);
        const list = await c.listCollections();
        let target = findCollection(list, sync.collection);
        let created = false;
        const kind: Mode = target ? (target.ownership === "this" ? "managed" : "unmanaged") : sync.collection.mode === "unmanaged" ? "unmanaged" : "managed";
        if (!target) {
          if (!sync.collection.create || !sync.collection.name)
            throw new SyncError("COLLECTION_NOT_FOUND", `collection "${sync.collection.name ?? sync.collection.id}" not found`,
              { fix: "check the name with `collections`, or set collection: { name: \"…\", create: true } to have setup create it" });
          target = kind === "unmanaged" ? await c.createCollection(sync.collection.name) : await c.createManagedCollection(sync.collection.name);
          created = true;
          if (opts.configFile) editConfig(opts.configFile, (doc) => setIn(doc, ["syncs", name, "collection", "id"], target!.id));
        } else if (target.ownership === "other") {
          throw new SyncError("COLLECTION_FOREIGN_PLUGIN", `"${target.name}" is owned by another plugin, so nothing can be added to it`,
            { fix: `give the sync a new collection name with create: true, and set schemaFrom: "${target.name}" to copy its fields` });
        }
        const have = await c.getFields(target.id);
        const canOverwrite = kind === "managed" && so.force;
        if (have.length && !canOverwrite) {
          return { ok: true, created, unchanged: true, mode: kind, collection: { id: target.id, name: target.name }, fieldCount: have.length,
            note: kind === "managed"
              ? "the collection already has fields, so they were left alone. Use force to replace them from schemaFrom (this can break page bindings)"
              : "the collection already has fields, so nothing was changed. Fields of regular collections are managed in the Framer editor" };
        }
        let fields: FieldDef[] = [], skipped: string[] = [], fieldsFrom: string;
        if (sync.schemaFrom) {
          const src = findCollection(list, sync.schemaFrom);
          if (!src) throw new SyncError("COLLECTION_NOT_FOUND", `schemaFrom collection "${sync.schemaFrom}" not found`);
          for (const f of await c.getFields(src.id)) {
            if (f.type === "array" || f.type === "divider" || f.type === "unsupported") { skipped.push(`${f.name} (${f.type})`); continue; }
            const id = sync.schemaIds === "keep" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(f.id) ? f.id : fieldId(f.name);
            fields.push({ id, name: f.name, type: f.type, ...(f.cases ? { cases: f.cases } : {}), ...(f.collectionId ? { collectionId: f.collectionId } : {}) });
          }
          fieldsFrom = `copied from "${src.name}"`;
        } else if (sync.source.type === "none") {
          fields = BASIC_FIELDS.map((f) => ({ ...f }));
          fieldsFrom = "a basic set (Title, Date, Image, Description, Content)";
        } else {
          let loaded;
          try { loaded = await load(sync); }
          catch (e) {
            if (e instanceof SyncError && e.code === "NO_INPUT")
              throw new SyncError("CONFIG_INVALID", `nothing to take fields from: syncs.${name} has no schemaFrom and no source.path / source.url`,
                { fix: "set source.path (or url) so fields can be worked out from your data, or set schemaFrom to copy another collection" });
            throw e;
          }
          if (!loaded.records.length) throw new SyncError("INPUT_INVALID", "the source has no records to work out fields from");
          ({ fields, skipped } = inferFields(loaded.records, sync));
          fieldsFrom = `worked out from ${loaded.records.length} record${loaded.records.length === 1 ? "" : "s"} in your data`;
        }
        if (kind === "managed") await c.setManagedFields(target.id, fields);
        else fields = await c.addUnmanagedFields(target.id, fields.map(({ id: _id, ...f }) => f));
        await log({ op: "setup", project, sync: name, ok: true, counts: { fields: fields.length } });
        const copyOfForeign = !!sync.schemaFrom && list.find((x) => x.name === sync.schemaFrom || x.id === sync.schemaFrom)?.ownership === "other";
        return { ok: true, created, mode: kind, collection: { id: target.id, name: target.name }, fieldCount: fields.length, fields, skipped, fieldsFrom,
          savedToConfig: created && !!opts.configFile,
          next: copyOfForeign
            ? `in the Framer editor, switch your page template from "${sync.schemaFrom}" to "${target.name}", then run \`plan ${name}\``
            : `run \`plan ${name}\` to fill it, then in Framer add a CMS page for "${target.name}" and bind its fields` };
      }));
    },

    async check(name: string, input?: SourceInput) {
      return withClient(projectOf(name), async (c) => {
        const sync = getSync(name);
        const { info, mode } = await resolveTarget(c, name, sync);
        const fields = await c.getFields(info.id);
        const result: Record<string, unknown> = { ok: true, sync: name, collection: { id: info.id, name: info.name }, mode, ownership: OWNERSHIP_NOTE[info.ownership], fieldCount: fields.length };
        let issues: Issue[] = [];
        try {
          const loaded = await load(sync, input);
          const mapped = mapRecords(loaded.records, fields, shaped(sync, loaded));
          issues = [...loaded.issues, ...mapped.issues];
          const used = new Set(mapped.items.flatMap((i) => Object.keys(i.fieldData)));
          result.records = loaded.records.length;
          result.unusedFields = fields.filter((f) => !used.has(f.id) && f.type !== "divider").map((f) => f.name);
          const slugs = new Set(mapped.items.map((i) => i.slug));
          const compareTo = sync.schemaFrom ? findCollection(await c.listCollections(), sync.schemaFrom) : null;
          if (compareTo && compareTo.id !== info.id) {
            const live = new Set((await c.getItems(compareTo.id)).map((i) => i.slug));
            result.slugCheck = {
              against: compareTo.name,
              matching: [...slugs].filter((s) => live.has(s)).length,
              total: slugs.size,
              newSlugs: [...slugs].filter((s) => !live.has(s)).slice(0, 50),
              missingFromSource: [...live].filter((s) => !slugs.has(s)).slice(0, 50),
              note: "slugs that differ from the current collection change page URLs when you switch the template over",
            };
          }
        } catch (e) {
          if (!(e instanceof SyncError && e.code === "NO_INPUT")) throw e;
          result.records = null;
          result.note = "no source data available, so only the collection was checked";
        }
        result.issues = { errors: issues.filter((i) => i.level === "error"), warnings: issues.filter((i) => i.level === "warning") };
        result.ok = !issues.some((i) => i.level === "error");
        return result;
      });
    },

    /** How each column of the source is matched to the collection's fields. */
    mappings: getMappings,
    /** Change mappings: to = a field name, "ignore" (never send this column) or "auto" (back to automatic matching). */
    setMappings,

    /**
     * Look at source data: format, where the rows are, fields with types and samples.
     * With `sync`, its configured source (URL fetched live, GET only) unless data is given. Nothing is stored.
     */
    async inspect(t: InspectTarget & { sync?: string }): Promise<InspectReport & { sync?: string }> {
      if (!t.sync) return inspectSource({ baseDir: configDir, ...t });
      const s = getSync(t.sync);
      const given = t.records !== undefined || t.text !== undefined || t.url || t.file;
      if (!given && !s.source.url && !s.source.path)
        throw new SyncError("NO_INPUT", `sync "${t.sync}" has no source.url or source.path to fetch`, { fix: "send the data you'd send to apply, and inspect that" });
      const r = await inspectSource({
        baseDir: configDir, rows: t.rows ?? s.source.rows,
        ...(given ? t : s.source.url ? { url: s.source.url, headers: s.source.headers } : { file: s.source.path }),
      });
      return { sync: t.sync, ...r };
    },

    /**
     * Download every item of a collection into a file or folder (CSV, Excel, JSON or Markdown), with exact
     * slugs, so local data starts identical to the CMS. Works for any collection you can read, including
     * one owned by another plugin (to seed your own managed copy).
     */
    async download(o: ProjectOption & { collection: string; format: FileFormat; dest: string; overwrite?: boolean }): Promise<WriteResult & { collection: { id: string; name: string } }> {
      return withClient(projectFor(o.project), async (c) => {
        const col = findCollection(await c.listCollections(), o.collection);
        if (!col) throw new SyncError("COLLECTION_NOT_FOUND", `collection "${o.collection}" not found`, { fix: "see `collections`" });
        const [items, fields] = await Promise.all([c.getItems(col.id), c.getFields(col.id)]);
        const r = await writeItems({ items, fields, format: o.format, dest: nodePath.resolve(configDir, o.dest), overwrite: o.overwrite, sheetName: col.name });
        await log({ op: "download", project: projectFor(o.project), ok: true, counts: { items: r.rows } });
        return { ...r, collection: { id: col.id, name: col.name } };
      });
    },

    /**
     * Download from Framer into the sync's own file or folder: replaces it with every item in the collection
     * (same format), after saving a backup copy next to it. The sync's key becomes the exact slug so the
     * next preview matches. Not possible for URL sources (Google Sheets, endpoints).
     */
    async pull(name: string): Promise<WriteResult & { backup: string | null; collection: { id: string; name: string }; configUpdated: string[] }> {
      const sync = getSync(name);
      if (sync.source.url)
        throw new SyncError("INPUT_INVALID", "this sync reads from a URL, which the tool can't write to",
          { fix: isGoogleSheet(sync.source.url) ? `download a CSV (framer-cms-sync download "${sync.collection.name ?? sync.collection.id}" ./data/${sync.project}/${name}.csv) and use File → Import in Google Sheets` : "download to a file with `framer-cms-sync download` instead" });
      if (sync.source.type === "none")
        throw new SyncError("INPUT_INVALID", "this sync has no source of its own, so there's nothing to download into", { fix: `save a copy with \`framer-cms-sync download "${sync.collection.name ?? sync.collection.id}" <file|folder>\`` });
      if (!sync.source.path) throw new SyncError("INPUT_INVALID", "this sync has no file or folder to download into", { fix: "set source.path first" });
      if (!opts.configFile) throw new SyncError("CONFIG_INVALID", "downloading into a sync needs the config file (to update its key)");
      const format: FileFormat = sync.source.type === "markdown" ? "markdown" : sync.source.type === "excel" ? "excel" : sync.source.type === "json" ? "json" : "csv";
      const dest = nodePath.resolve(configDir, sync.source.path);
      const project = projectOf(name);
      return queueFor(project)(() => withClient(project, async (c) => {
        const { info } = await resolveTarget(c, name, sync);
        const [items, fields] = await Promise.all([c.getItems(info.id), c.getFields(info.id)]);
        // Back up what's there, then clear old posts so deleted items don't linger.
        let backup: string | null = null;
        if (existsSync(dest)) {
          const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
          const ext = statSync(dest).isDirectory() ? "" : nodePath.extname(dest);
          backup = `${dest.slice(0, dest.length - ext.length)}.before-download-${stamp}${ext}`;
          cpSync(dest, backup, { recursive: true });
          if (format === "markdown") for (const f of readdirSync(dest)) if (isMarkdownFile(f)) rmSync(nodePath.join(dest, f));
        }
        const r = await writeItems({ items, fields, format, dest, overwrite: true, sheetName: info.name });
        const configUpdated: string[] = [];
        editConfig(opts.configFile!, (doc) => {
          if (format !== "markdown") { setIn(doc, ["syncs", name, "key"], { field: r.keyColumn, transform: r.keyTransform }); configUpdated.push(`key: ${r.keyColumn}`); }
          if (sync.source.sheet) { setIn(doc, ["syncs", name, "source", "sheet"], undefined); configUpdated.push("sheet: first sheet"); }
          if (r.bodyField) { setIn(doc, ["syncs", name, "fields", "map", "content"], r.bodyField); configUpdated.push(`content → ${r.bodyField}`); }
          if (sync.fields.dateOrder) { setIn(doc, ["syncs", name, "fields", "dateOrder"], undefined); configUpdated.push("dates now written as YYYY-MM-DD"); }
        });
        if (format !== "markdown") sync.key = { field: r.keyColumn, transform: r.keyTransform };
        sync.source.sheet = undefined;
        if (r.bodyField) sync.fields.map = { ...sync.fields.map, content: r.bodyField };
        sync.fields.dateOrder = undefined;
        await log({ op: "pull", project, sync: name, ok: true, counts: { items: r.rows } });
        return { ...r, dest: sync.source.path!, backup: backup ? nodePath.relative(configDir, backup) : null, collection: { id: info.id, name: info.name }, configUpdated };
      }));
    },

    /** A starter file with one example row; with `from`, columns copy that collection's fields. */
    async template(o: ProjectOption & { format: FileFormat; dest: string; from?: string; overwrite?: boolean }): Promise<WriteResult> {
      const fields = o.from ? (await this.fields(o.from, { project: o.project })).fields : undefined;
      return writeTemplate({ format: o.format, dest: nodePath.resolve(configDir, o.dest), fields, overwrite: o.overwrite });
    },

    async items(name: string) {
      return withClient(projectOf(name), async (c) => {
        const sync = getSync(name);
        const { info } = await resolveTarget(c, name, sync);
        const items = await c.getItems(info.id);
        return { collection: { id: info.id, name: info.name }, count: items.length, items: items.map((i) => ({ slug: i.slug, draft: i.draft })).sort((a, b) => a.slug.localeCompare(b.slug)) };
      });
    },

    async remove(name: string, key: string, ro: { redirectTo?: string; publish?: boolean; deploy?: boolean; keepFile?: boolean } = {}) {
      const project = projectOf(name);
      return queueFor(project)(() => withClient(project, async (c) => {
        const sync = getSync(name);
        const { info, mode } = await resolveTarget(c, name, sync);
        const items = await c.getItems(info.id);
        const slug = keyToSlug(key, "none");
        const item = items.find((i) => i.slug === slug) ?? items.find((i) => i.slug === keyToSlug(key, "slugify"));
        if (!item) throw new SyncError("ITEM_NOT_FOUND", `no item with slug "${key}" in "${info.name}"`, { fix: `see \`items ${name}\`` });
        let redirect: { from: string; to: string } | undefined, repointed = 0;
        if (ro.redirectTo) {
          if (!sync.path) throw new SyncError("CONFIG_INVALID", `syncs.${name}.path isn't set, so page URLs are unknown`, { fix: 'set path: "/blog/" (the URL prefix of these pages)' });
          const target = items.find((i) => i.slug === ro.redirectTo);
          if (!target || target.draft) throw new SyncError("ITEM_NOT_FOUND", `redirect target "${ro.redirectTo}" isn't a live item`, { fix: "redirect to a published item's slug" });
        }
        if (mode === "managed") {
          const ids = new Set(await c.getManagedItemIds(info.id));
          await c.removeManaged(info.id, [ids.has(item.id) ? item.id : [...ids].find((id) => id === item.slug) ?? item.id]);
        } else await c.removeUnmanaged(info.id, [item.nodeId]);
        if (ro.redirectTo) {
          const prefix = sync.path!.endsWith("/") ? sync.path! : sync.path! + "/";
          redirect = { from: toPath(prefix + item.slug), to: toPath(prefix + ro.redirectTo) };
          const existing = await c.getRedirects();
          const writes = existing.filter((r) => r.to && toPath(r.to) === redirect!.from).map((r) => ({ id: r.id, to: redirect!.to }));
          repointed = writes.length;
          const same = existing.find((r) => toPath(r.from) === redirect!.from);
          await c.addRedirects([...writes, same ? { id: same.id, to: redirect.to } : { from: redirect.from, to: redirect.to }]);
        }
        const pub = ro.publish ? await doPublish(c, ro.deploy ?? config.defaults.deploy) : null;
        // Markdown: delete the post's file too, so the next full sync doesn't add it back.
        const folder = sync.source.type === "markdown" && !ro.keepFile ? postFolder(sync, configDir) : null;
        const file = folder ? deletePost(folder, item.slug, sync) : null;
        await log({ op: "remove", project, sync: name, ok: true, counts: { removed: 1, repointed }, deploymentId: pub?.deploymentId });
        return { ok: true, removed: item.slug, file: file?.file ? nodePath.relative(configDir, file.file) : null, redirect: redirect ?? null, repointed, publish: pub ? { ...pub, note: PUBLISH_NOTE } : null,
          ...(redirect || !sync.path ? {} : { reminder: `consider a redirect for ${sync.path}${item.slug} (--redirect-to on the CLI, redirectTo over HTTP/MCP)` }) };
      }));
    },

    redirects: {
      async list(po: ProjectOption = {}) {
        return withClient(projectFor(po.project), async (c) => (await c.getRedirects()).map((r) => ({ id: r.id, from: r.from, to: r.to })));
      },
      async plan(input: unknown, po: ProjectOption = {}) {
        const project = projectFor(po.project);
        return withClient(project, async (c) => planWith(c, project, input));
      },
      async apply(input: unknown, ro: ProjectOption & { publish?: boolean; deploy?: boolean } = {}) {
        const project = projectFor(ro.project);
        return queueFor(project)(() => withClient(project, async (c) => {
          const plan = await planWith(c, project, input);
          if (plan.issues.some((i) => i.level === "error")) return { ok: false, ...plan, note: "nothing written: fix the errors first" };
          const r = await applyRedirectPlan(c, plan);
          const pub = ro.publish ? await doPublish(c, ro.deploy ?? config.defaults.deploy) : null;
          await log({ op: "redirects.apply", project, ok: true, counts: r, deploymentId: pub?.deploymentId });
          return { ok: true, ...plan, ...r, publish: pub ? { ...pub, note: PUBLISH_NOTE } : null };
        }));
      },
      async remove(froms: string[], ro: ProjectOption & { publish?: boolean } = {}) {
        const project = projectFor(ro.project);
        return queueFor(project)(() => withClient(project, async (c) => {
          const want = new Set(froms.map(toPath));
          const hits = (await c.getRedirects()).filter((r) => want.has(toPath(r.from)));
          if (hits.length) await c.removeRedirects(hits.map((r) => r.id));
          const pub = ro.publish ? await doPublish(c, config.defaults.deploy) : null;
          await log({ op: "redirects.remove", project, ok: true, counts: { removed: hits.length } });
          return { ok: true, removed: hits.map((r) => r.from), notFound: [...want].filter((f) => !hits.some((h) => toPath(h.from) === f)), publish: pub };
        }));
      },
    },

    async publish(po: ProjectOption & { deploy?: boolean } = {}) {
      const project = projectFor(po.project);
      return queueFor(project)(() => withClient(project, async (c) => {
        const pub = await doPublish(c, po.deploy ?? config.defaults.deploy);
        await log({ op: "publish", project, ok: true, deploymentId: pub.deploymentId });
        return { ok: true, ...pub, note: PUBLISH_NOTE };
      }));
    },

    history: (limit?: number) => readRunLog(configDir, limit),

    describe() {
      return {
        projects: projectNames,
        syncs: listSyncs(),
        sourceTypes: ["csv", "excel", "json", "markdown", "none (pass-through: data only sent in)"],
        fieldTypes: ["string", "formattedText", "number", "boolean", "date", "enum", "color", "link", "image", "file", "collectionReference", "multiCollectionReference"],
        issueCodes: ISSUE_CODES,
        errorCodes: Object.keys(ERROR_CODES),
        guides: "framer-cms-sync skills [name] — full guides for every topic (also the skills/ folder)",
        workflow: [
          "plan first: it shows what will change and lists problems with fixes",
          "fix every error, then plan again",
          "apply with the planId from the plan",
          "publish only when asked; publishing ships the whole site",
          "never use force or allowMassRemove without asking the person",
        ],
        configKeys: {
          "syncs.<name>.project": "which site, when the config has several",
          "syncs.<name>.collection": "{ id | name, mode: auto|managed|unmanaged, create }",
          "syncs.<name>.schemaFrom": "collection to copy fields from when setting up a new one",
          "syncs.<name>.source": "{ type: csv|excel|json|markdown|none, path?, url?, headers?, rows?, sheet? }",
          "syncs.<name>.key": "{ field, transform: slugify|none } (markdown and none: the exact slug)",
          "syncs.<name>.fields": "{ map, ignore, unknown: warn|error|ignore, nulls: clear|skip, alt, formattedText, dateOrder: DMY|MDY }",
          "syncs.<name>.markdown": "{ stripLeadingH1, dedupeThumbnail, draftField, aliases, typographer, linkify }",
          "syncs.<name>.transform": "name of a transform from a plugin",
          "syncs.<name>.prune": "false | { minItems, maxRemove: number|'20%', mode: delete|draft }",
          "syncs.<name>.publish": "never | always | on-change",
          "syncs.<name>.path": "page URL prefix, e.g. /blog/ (used by redirects)",
          "syncs.<name>.lint": "{ rule: off|warn|error | { level, ...options } }",
        },
      };
    },
  };
  return api;

  async function planWith(c: FramerClient, project: string, input: unknown) {
    const wanted = parseRedirects(input);
    const existing = await c.getRedirects();
    const livePaths = new Set<string>();
    const prefixes: string[] = [];
    const list = await c.listCollections();
    for (const [, s] of Object.entries(config.syncs)) {
      if (!s.path || s.project !== project) continue;
      const col = findCollection(list, s.collection);
      if (!col) continue;
      const prefix = s.path.endsWith("/") ? s.path : s.path + "/";
      prefixes.push(prefix);
      for (const i of await c.getItems(col.id)) if (!i.draft) livePaths.add(toPath(prefix + i.slug));
    }
    const plan = planRedirects(wanted, existing, { livePaths: prefixes.length ? livePaths : undefined, protectedPrefixes: prefixes, allowChains: config.redirects.allowChains });
    return { requested: wanted.length, ...plan, add: plan.add, update: plan.update };
  }
}

export type Sync = ReturnType<typeof createSync>;

/** Fields for a new collection of a pass-through sync with nothing to copy from. */
const BASIC_FIELDS: FieldDef[] = [
  { id: "title", name: "Title", type: "string" },
  { id: "date", name: "Date", type: "date" },
  { id: "image", name: "Image", type: "image" },
  { id: "description", name: "Description", type: "string" },
  { id: "content", name: "Content", type: "formattedText" },
];
