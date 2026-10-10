// In-memory FramerClient for tests and dry experiments. It enforces the Framer rules
// the engine depends on, so tests fail the way the real API would:
//   - only "this" collections accept managed calls; "other" collections reject every write
//   - managed items need our id (<= 64 chars); unmanaged creates must omit the id
//   - number fields reject non-numbers; string fields reject non-strings; enum values must be case ids
//   - unknown field ids and type mismatches are rejected

import type { CollectionInfo, ExistingItem, FieldDef, ItemInput, Ownership, RedirectInfo, RedirectWrite } from "../types.ts";
import type { Connector, FramerClient } from "./client.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface MemoryCollection {
  id: string;
  name: string;
  ownership: Ownership;
  fields: FieldDef[];
  items?: ExistingItem[];
}

export interface MemoryState {
  projectName: string;
  collections: Map<string, { info: CollectionInfo; fields: FieldDef[]; items: Map<string, ExistingItem> }>;
  redirects: RedirectInfo[];
  published: string[];
  deployed: string[];
  log: string[];
  active: number;
  overlap: boolean;
  failNextWrite?: number; // fail the Nth upcoming write call (1 = next)
}

let seq = Date.now() % 100000;
const nid = () => `node${++seq}`;

export function createMemoryFramer(opts: { projectName?: string; collections?: MemoryCollection[]; redirects?: RedirectInfo[]; published?: string[] } = {}) {
  const state: MemoryState = {
    projectName: opts.projectName ?? "Test Site",
    collections: new Map(),
    redirects: (opts.redirects ?? []).map((r) => ({ ...r })),
    published: [...(opts.published ?? [])], deployed: [], log: [], active: 0, overlap: false,
  };
  for (const c of opts.collections ?? []) {
    const items = new Map<string, ExistingItem>();
    for (const it of c.items ?? []) items.set(it.nodeId, { ...it, fieldData: { ...it.fieldData } });
    state.collections.set(c.id, { info: { id: c.id, name: c.name, ownership: c.ownership }, fields: c.fields.map((f) => ({ ...f })), items });
  }

  const col = (id: string) => {
    const c = state.collections.get(id);
    if (!c) throw new Error(`collection ${id} not found`);
    return c;
  };
  const writable = (id: string, kind: "managed" | "unmanaged") => {
    const c = col(id);
    if (c.info.ownership === "other") throw new Error("Expected the collection to be unmanaged");
    if (kind === "managed" && c.info.ownership !== "this") throw new Error("not a managed collection of this plugin");
    if (kind === "unmanaged" && c.info.ownership === "this") throw new Error("use the managed collection API");
    return c;
  };
  const write = async <T>(label: string, fn: () => T): Promise<T> => {
    state.active++; if (state.active > 1) state.overlap = true;
    try {
      await new Promise((r) => setTimeout(r, 2));
      if (state.failNextWrite !== undefined && --state.failNextWrite <= 0) { state.failNextWrite = undefined; throw new Error(`simulated failure in ${label}`); }
      const out = fn(); state.log.push(label); return out;
    } finally { state.active--; }
  };
  const validate = (c: ReturnType<typeof col>, it: ItemInput) => {
    for (const [k, v] of Object.entries(it.fieldData)) {
      const f = c.fields.find((x) => x.id === k);
      if (!f) throw new Error(`unknown field ${k}`);
      if (f.type !== v.type) throw new Error(`type mismatch on ${k}: ${v.type} vs ${f.type}`);
      if (f.type === "number" && typeof v.value !== "number") throw new Error(`number expected for ${k}`);
      if ((f.type === "string" || f.type === "formattedText") && typeof v.value !== "string") throw new Error(`string expected for ${k}`);
      if (f.type === "enum" && !(f.cases || []).some((cs) => cs.id === v.value)) throw new Error(`invalid enum case for ${k}`);
    }
    const slugTaken = (slug: string, except?: string) => [...c.items.values()].some((x) => x.slug === slug && x.nodeId !== except);
    return slugTaken;
  };
  const store = (entry: { type: string; value: unknown }) => ({ type: entry.type, value: entry.type === "image" && entry.value ? { url: entry.value, id: "img_" + entry.value } : entry.value });

  const client: FramerClient = {
    async projectName() { return state.projectName; },
    async listCollections() { return [...state.collections.values()].map((c) => ({ ...c.info })); },
    async getFields(id) { return col(id).fields.map((f) => ({ ...f, cases: f.cases?.map((x) => ({ ...x })) })); },
    async getItems(id) { return [...col(id).items.values()].map((i) => JSON.parse(JSON.stringify(i))); },
    async getManagedItemIds(id) { return [...writable(id, "managed").items.values()].map((i) => i.id); },
    async upsertManaged(id, items) {
      const c = writable(id, "managed");
      await write(`upsertManaged:${items.length}`, () => {
        for (const it of items) {
          if (!it.id) throw new Error("id required");
          if (it.id.length > 64) throw new Error("Invalid id of collection item, maximum length is 64 characters");
          validate(c, it);
        }
        for (const it of items) {
          const prev = [...c.items.values()].find((x) => x.id === it.id);
          const nodeId = prev?.nodeId ?? nid();
          const fd: ExistingItem["fieldData"] = { ...(prev?.fieldData ?? {}) };
          for (const [k, v] of Object.entries(it.fieldData)) fd[k] = store(v);
          c.items.set(nodeId, { id: it.id!, nodeId, slug: it.slug, draft: it.draft ?? false /* observed: Framer publishes items when draft is omitted */, fieldData: fd });
        }
      });
    },
    async removeManaged(id, ids) {
      const c = writable(id, "managed");
      await write(`removeManaged:${ids.length}`, () => { for (const [k, v] of c.items) if (ids.includes(v.id)) c.items.delete(k); });
    },
    async setManagedFields(id, fields) {
      const c = writable(id, "managed");
      await write("setManagedFields", () => { c.fields = fields.map((f) => ({ ...f })); });
    },
    async createManagedCollection(name) {
      const info: CollectionInfo = { id: "new" + (++seq), name, ownership: "this" };
      state.collections.set(info.id, { info, fields: [], items: new Map() });
      return { ...info };
    },
    async createCollection(name) {
      const info: CollectionInfo = { id: "col" + (++seq), name, ownership: "user" };
      state.collections.set(info.id, { info, fields: [], items: new Map() });
      return { ...info };
    },
    async addUnmanagedFields(id, fields) {
      const c = writable(id, "unmanaged");
      return write(`addUnmanagedFields:${fields.length}`, () => {
        const created = fields.map((f) => ({ ...f, id: "fld" + (++seq), ...(f.cases ? { cases: f.cases.map((x) => ({ id: "case" + (++seq), name: x.name })) } : {}) }));
        c.fields.push(...created);
        return created.map((f) => ({ ...f }));
      });
    },
    async writeUnmanaged(id, items) {
      const c = writable(id, "unmanaged");
      await write(`writeUnmanaged:${items.length}`, () => {
        for (const it of items) {
          const taken = validate(c, it);
          if (it.id && !c.items.has(it.id)) throw new Error(`No item found with ID ${it.id}`);
          if (!it.id && taken(it.slug)) throw new Error(`slug ${it.slug} already exists`);
        }
        for (const it of items) {
          const nodeId = it.id ?? nid();
          const prev = c.items.get(nodeId);
          const fd: ExistingItem["fieldData"] = { ...(prev?.fieldData ?? {}) };
          for (const [k, v] of Object.entries(it.fieldData)) fd[k] = store(v);
          c.items.set(nodeId, { id: nodeId, nodeId, slug: it.slug ?? prev?.slug, draft: it.draft ?? false /* observed: Framer publishes items when draft is omitted */, fieldData: fd });
        }
      });
    },
    async removeUnmanaged(id, nodeIds) {
      const c = writable(id, "unmanaged");
      await write(`removeUnmanaged:${nodeIds.length}`, () => { for (const n of nodeIds) c.items.delete(n); });
    },
    async getRedirects() { return state.redirects.map((r) => ({ ...r })); },
    async addRedirects(inputs: RedirectWrite[]) {
      await write(`addRedirects:${inputs.length}`, () => {
        for (const r of inputs) {
          if (r.id) { const ex = state.redirects.find((x) => x.id === r.id); if (!ex) throw new Error("no redirect " + r.id); ex.to = r.to; }
          else state.redirects.push({ id: "r" + (++seq), from: r.from!, to: r.to });
        }
      });
    },
    async removeRedirects(ids) {
      await write(`removeRedirects:${ids.length}`, () => { state.redirects = state.redirects.filter((r) => !ids.includes(r.id)); });
    },
    async publish() {
      return write("publish", () => { const id = "dep" + (state.published.length + 1); state.published.push(id); return { deploymentId: id, hostnames: ["preview.example.framer.app"] }; });
    },
    async deploy(deploymentId) {
      return write("deploy", () => { state.deployed.push(deploymentId); return ["www.example.com"]; });
    },
    async disconnect() {},
  };

  const connector: Connector = async () => client;
  return { client, connector, state };
}

/**
 * A memory client backed by a JSON file, for demos and end-to-end tests of the CLI and terminal app.
 * Enabled by FRAMER_CMS_SYNC_DEMO=<file>. Changes are saved back to the file on disconnect.
 */
export function fileBackedConnector(file: string, project?: string): Connector {
  // The file holds one fake project, or several under { projects: { name: {...} } }.
  return async () => {
    const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { collections: [] };
    const multi = !!all.projects;
    const key = multi ? (project && all.projects[project] ? project : Object.keys(all.projects)[0]) : null;
    const data = multi ? all.projects[key!] : all;
    const mem = createMemoryFramer(data);
    const disconnect = mem.client.disconnect;
    mem.client.disconnect = async () => {
      await disconnect();
      const snapshot = {
        projectName: mem.state.projectName,
        collections: [...mem.state.collections.values()].map((c) => ({ ...c.info, fields: c.fields, items: [...c.items.values()] })),
        redirects: mem.state.redirects,
        published: mem.state.published,
      };
      const fresh = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      writeFileSync(file, JSON.stringify(multi ? { ...fresh, projects: { ...fresh.projects, [key!]: snapshot } } : snapshot, null, 2));
    };
    return mem.client;
  };
}
