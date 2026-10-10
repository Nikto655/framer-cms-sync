// Shared types. Everything Framer-shaped here is our own simplified view; the
// framer-api specifics stay inside src/framer/adapter.ts.

export type FieldType =
  | "string" | "formattedText" | "number" | "boolean" | "date" | "enum" | "color" | "link"
  | "image" | "file" | "collectionReference" | "multiCollectionReference" | "array" | "divider" | "unsupported";

export interface EnumCase { id: string; name: string }

export interface FieldDef {
  id: string;
  name: string;
  type: FieldType | string;
  cases?: EnumCase[];
  collectionId?: string;
  required?: boolean;
  userEditable?: boolean;
}

/** Who owns a collection, from the point of view of this API key. */
export type Ownership = "this" | "user" | "other";
export type Mode = "managed" | "unmanaged";

export interface CollectionInfo { id: string; name: string; ownership: Ownership }

export interface FieldEntry {
  type: string;
  value: unknown;
  alt?: string;
  contentType?: "html" | "markdown" | "auto";
}
export type FieldData = Record<string, FieldEntry>;

/** An item as read back from Framer. */
export interface ExistingItem {
  /** Framer's item id. For managed collections this is usually our own id. */
  id: string;
  /** Framer's node id; what unmanaged updates and removals need. */
  nodeId: string;
  slug: string;
  draft: boolean;
  fieldData: Record<string, { type: string; value: unknown }>;
}

/** An item we want to write. `id` is omitted when creating in an unmanaged collection. */
export interface ItemInput {
  id?: string;
  slug: string;
  draft?: boolean;
  fieldData: FieldData;
}

export interface RedirectInfo { id: string; from: string; to: string | null }
export interface RedirectWrite { id?: string; from?: string; to: string; expandToAllLocales?: boolean }

export interface PublishInfo { deploymentId: string; deployed: boolean; hostnames: string[] }

/** One raw record from a source, before mapping. */
export interface SourceRecord {
  data: Record<string, unknown>;
  /** Where it came from, for messages: "posts/hello.md", "row 12". */
  origin: string;
  /** Default slug if the record has no key value (Markdown filename). */
  slugHint?: string;
}
