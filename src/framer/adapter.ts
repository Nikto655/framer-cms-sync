// The only file that imports framer-api. If Framer's API changes, this is the file to edit.
//
// Behaviour this relies on (verified against framer-api 5.1.0 types and the original
// framer-sync deployment):
//   - collection.managedBy: "user" | "thisPlugin" | "anotherPlugin"
//   - ManagedCollection: getItemIds, getFields, setFields, addItems (upsert by our id), removeItems.
//     It has no getItems(), so content is read through the generic Collection with the same id.
//   - Collection (generic): getFields, getItems, addItems (update by node id / create without id), removeItems.
//   - publish() -> { deployment: { id }, hostnames }; deploy(id) -> Hostname[]. Publishing ships the whole site.

import { connect } from "framer-api";
import type { CollectionInfo, ExistingItem, FieldDef, ItemInput, Ownership, RedirectWrite } from "../types.ts";
import type { Connector, FramerClient } from "./client.ts";
import { SyncError, scrub } from "../core/issues.ts";

// framer-api's types are rich; we only touch a small, loosely-typed surface here.
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const ownership = (managedBy: string | undefined): Ownership =>
  managedBy === "thisPlugin" ? "this" : managedBy === "anotherPlugin" ? "other" : "user";

function toFieldDef(f: Any): FieldDef {
  const def: FieldDef = { id: f.id, name: f.name, type: f.type };
  if (f.type === "enum") def.cases = (f.cases || []).map((c: Any) => ({ id: c.id, name: c.name }));
  if (f.collectionId) def.collectionId = f.collectionId;
  if (typeof f.required === "boolean") def.required = f.required;
  if (typeof f.userEditable === "boolean") def.userEditable = f.userEditable;
  return def;
}

function toFieldInput(f: FieldDef): Any {
  const out: Any = { id: f.id, name: f.name, type: f.type };
  if (f.type === "enum") out.cases = (f.cases || []).map((c) => ({ id: c.id, name: c.name }));
  if (f.collectionId) out.collectionId = f.collectionId;
  return out;
}

function toFramerItem(it: ItemInput): Any {
  const out: Any = { slug: it.slug, fieldData: it.fieldData };
  if (it.id !== undefined) out.id = it.id;
  if (it.draft !== undefined) out.draft = it.draft;
  return out;
}

export function framerConnector(projectUrl: string, apiKey: string, projectName?: string): Connector {
  const demo = process.env.FRAMER_CMS_SYNC_DEMO;
  if (demo) return async () => (await import("./memory.ts")).fileBackedConnector(demo, projectName)();
  return async () => {
    let framer: Any;
    try {
      framer = await connect(projectUrl, apiKey);
    } catch (e) {
      throw new SyncError("FRAMER_ERROR", `couldn't connect to Framer: ${scrub(String((e as Error).message || e), [apiKey])}`,
        { fix: "check project.url and the API key (Framer → Site Settings → API)" });
    }
    return new FramerApiClient(framer, apiKey);
  };
}

class FramerApiClient implements FramerClient {
  private framer: Any;
  private apiKey: string;
  constructor(framer: Any, apiKey: string) { this.framer = framer; this.apiKey = apiKey; }

  private async call<T = Any>(what: string, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) {
      if (e instanceof SyncError) throw e;
      const msg = scrub(String((e as Error)?.message ?? e), [this.apiKey]);
      if (/plan does not include|upgrade your plan|not available on (your|the current) plan/i.test(msg))
        throw new SyncError("FORBIDDEN", `Framer refused ${what}: ${msg}`, { fix: "this feature isn't included in your Framer site plan (Site Settings → Plans). Nothing was changed" });
      throw new SyncError("FRAMER_ERROR", `Framer ${what} failed: ${msg}`);
    }
  }

  private async generic(id: string): Promise<Any> {
    const col = await this.call("getCollection", async () =>
      typeof this.framer.getCollection === "function" ? this.framer.getCollection(id) : (await this.framer.getCollections()).find((c: Any) => c.id === id));
    if (!col) throw new SyncError("COLLECTION_NOT_FOUND", `collection ${id} not found`);
    return col;
  }

  private async managed(id: string): Promise<Any> {
    const col = (await this.call("getManagedCollections", () => this.framer.getManagedCollections())).find((c: Any) => c.id === id);
    if (!col) throw new SyncError("COLLECTION_NOT_MANAGED", `collection ${id} isn't managed by this API key`,
      { fix: "use mode: unmanaged for hand-built collections, or the API key that created it" });
    return col;
  }

  async projectName() {
    const info: Any = await this.call<Any>("getProjectInfo", () => this.framer.getProjectInfo()).catch(() => null);
    return info?.name ?? "Framer project";
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const cols: Any[] = await this.call("getCollections", () => this.framer.getCollections());
    return cols.map((c) => ({ id: c.id, name: c.name, ownership: ownership(c.managedBy) }));
  }

  async getFields(collectionId: string) {
    const col = await this.generic(collectionId);
    return (await this.call("getFields", () => col.getFields()) as Any[]).map(toFieldDef);
  }

  async getItems(collectionId: string): Promise<ExistingItem[]> {
    const col = await this.generic(collectionId);
    const items: Any[] = await this.call("getItems", () => col.getItems());
    return items.map((i) => ({ id: i.id, nodeId: i.nodeId ?? i.id, slug: i.slug, draft: !!i.draft, fieldData: { ...(i.fieldData || {}) } }));
  }

  async getManagedItemIds(collectionId: string) {
    const col = await this.managed(collectionId);
    return this.call<string[]>("getItemIds", () => col.getItemIds());
  }

  async upsertManaged(collectionId: string, items: ItemInput[]) {
    const col = await this.managed(collectionId);
    await this.call("addItems", () => col.addItems(items.map(toFramerItem)));
  }

  async removeManaged(collectionId: string, ids: string[]) {
    const col = await this.managed(collectionId);
    await this.call("removeItems", () => col.removeItems(ids));
  }

  async setManagedFields(collectionId: string, fields: FieldDef[]) {
    const col = await this.managed(collectionId);
    await this.call("setFields", () => col.setFields(fields.map(toFieldInput)));
  }

  async createManagedCollection(name: string): Promise<CollectionInfo> {
    const col: Any = await this.call("createManagedCollection", () => this.framer.createManagedCollection(name)); // string arg only
    return { id: col.id, name: col.name, ownership: "this" };
  }

  async createCollection(name: string): Promise<CollectionInfo> {
    const col: Any = await this.call("createCollection", () => this.framer.createCollection(name));
    return { id: col.id, name: col.name, ownership: "user" };
  }

  async addUnmanagedFields(collectionId: string, fields: Omit<FieldDef, "id">[]) {
    const col = await this.generic(collectionId);
    const created: Any[] = await this.call("addFields", () => col.addFields(fields.map((f) => {
      const out: Any = { name: f.name, type: f.type };
      if (f.type === "enum") out.cases = (f.cases || []).map((c) => ({ name: c.name }));
      if (f.collectionId) out.collectionId = f.collectionId;
      return out;
    })));
    return (created || []).map(toFieldDef);
  }

  async writeUnmanaged(collectionId: string, items: ItemInput[]) {
    const col = await this.generic(collectionId);
    await this.call("addItems", () => col.addItems(items.map(toFramerItem)));
  }

  async removeUnmanaged(collectionId: string, nodeIds: string[]) {
    const col = await this.generic(collectionId);
    await this.call("removeItems", () => col.removeItems(nodeIds));
  }

  async getRedirects() {
    const list: Any[] = await this.call("getRedirects", () => this.framer.getRedirects());
    return list.map((r) => ({ id: r.id, from: r.from, to: r.to ?? null }));
  }

  async addRedirects(inputs: RedirectWrite[]) {
    await this.call("addRedirects", () => this.framer.addRedirects(inputs.map((r) =>
      r.id ? { id: r.id, to: r.to } : { from: r.from, to: r.to, expandToAllLocales: r.expandToAllLocales ?? false })));
  }

  async removeRedirects(ids: string[]) {
    await this.call("removeRedirects", () => this.framer.removeRedirects(ids));
  }

  async publish() {
    const res: Any = await this.call("publish", () => this.framer.publish());
    return { deploymentId: res.deployment.id, hostnames: (res.hostnames || []).map((h: Any) => h.hostname ?? String(h)) };
  }

  async deploy(deploymentId: string) {
    const hosts: Any[] = await this.call("deploy", () => this.framer.deploy(deploymentId));
    return (hosts || []).map((h) => h.hostname ?? String(h));
  }

  async disconnect() {
    await this.framer.disconnect?.().catch(() => {});
  }
}
