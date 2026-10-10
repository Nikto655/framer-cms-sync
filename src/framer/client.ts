// The narrow interface the engine needs from Framer. The real implementation wraps
// framer-api (adapter.ts); tests use an in-memory one (memory.ts).

import type { CollectionInfo, ExistingItem, FieldDef, ItemInput, RedirectInfo, RedirectWrite } from "../types.ts";

export interface FramerClient {
  projectName(): Promise<string>;
  listCollections(): Promise<CollectionInfo[]>;
  getFields(collectionId: string): Promise<FieldDef[]>;
  /** Items with content. Works for every collection kind. */
  getItems(collectionId: string): Promise<ExistingItem[]>;

  // Managed collections (owned by this key)
  getManagedItemIds(collectionId: string): Promise<string[]>;
  upsertManaged(collectionId: string, items: ItemInput[]): Promise<void>;
  removeManaged(collectionId: string, ids: string[]): Promise<void>;
  setManagedFields(collectionId: string, fields: FieldDef[]): Promise<void>;
  createManagedCollection(name: string): Promise<CollectionInfo>;

  // Unmanaged (hand-built) collections
  /** Create a regular (unmanaged) collection. */
  createCollection(name: string): Promise<CollectionInfo>;
  /** Add fields to an unmanaged collection. Framer assigns the ids; returns the created fields. */
  addUnmanagedFields(collectionId: string, fields: Omit<FieldDef, "id">[]): Promise<FieldDef[]>;
  /** Items with `id` (Framer node id) are updated; items without are created. */
  writeUnmanaged(collectionId: string, items: ItemInput[]): Promise<void>;
  removeUnmanaged(collectionId: string, nodeIds: string[]): Promise<void>;

  // Redirects
  getRedirects(): Promise<RedirectInfo[]>;
  addRedirects(inputs: RedirectWrite[]): Promise<void>;
  removeRedirects(ids: string[]): Promise<void>;

  // Publishing
  publish(): Promise<{ deploymentId: string; hostnames: string[] }>;
  deploy(deploymentId: string): Promise<string[]>;

  disconnect(): Promise<void>;
}

export type Connector = () => Promise<FramerClient>;
