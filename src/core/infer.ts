// Work out a collection's fields from source records, for brand-new managed collections
// that have no schemaFrom to copy. Conservative: when in doubt, a field is a string.

import type { FieldDef, SourceRecord } from "../types.ts";
import type { SyncConfig } from "../config/schema.ts";
import { fieldId } from "./identity.ts";
import { isSlashDate } from "./dates.ts";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i;
const IMAGE_NAME = /(image|thumbnail|photo|picture|logo|flag|avatar|cover|hero|icon)/i;
const BODY_KEYS = new Set(["content", "body", "html", "postbody", "contenthtml", "bodyhtml", "article", "richtext"]);
const DATE_NAME = /(date|time|published ?at|updated ?at|created ?at)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const BOOL_RE = /^(true|false|yes|no)$/i;
const URL_RE = /^https?:\/\/\S+$/i;

/** Nicer field names for common frontmatter keys. */
const PRETTY: Record<string, string> = {
  title: "Title", date: "Date", updated: "Updated", author: "Author", content: "Content",
  thumbnail: "Thumbnail", thumbnail_alt: "Thumbnail Alt", meta_description: "Meta Description",
  description: "Description", category: "Category", tags: "Tags", featured: "Featured",
};
// Field names for new collections: Markdown keys and nested paths ("address.city") get readable names
// ("Address City"), which still match their column automatically (names are compared loosely).
const ACRONYMS: Record<string, string> = { Html: "HTML", Url: "URL", Id: "ID", Seo: "SEO", Sku: "SKU", Api: "API" };
const titleCase = (k: string) => k.replace(/[._-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, (c) => c.toUpperCase()).trim()
  .split(" ").map((w) => ACRONYMS[w] ?? w).join(" ");
// Readable names ("publish-date" → "Publish Date"); they still match their column, as names are compared loosely.
// Names that already look written for people (spaces or capitals) are kept as they are.
const pretty = (k: string, markdown: boolean) =>
  markdown && PRETTY[k] ? PRETTY[k] : /[A-Z ]/.test(k) && !k.includes(".") ? k : titleCase(k);

export function inferType(key: string, values: unknown[]): FieldDef["type"] {
  const vals = values.filter((v) => v !== null && v !== undefined && v !== "");
  const loose = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!vals.length) {
    // No values yet: go by the column's name.
    if (IMAGE_NAME.test(key)) return "image";
    if (DATE_NAME.test(key.replace(/[_-]+/g, " "))) return "date";
    if (BODY_KEYS.has(loose)) return "formattedText";
    return "string";
  }
  if (vals.every((v) => typeof v === "boolean" || BOOL_RE.test(String(v)))) return "boolean";
  if (vals.every((v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) && !/^0\d/.test(v.trim()))))
    return "number";
  if (vals.every((v) => (DATE_RE.test(String(v)) && !isNaN(new Date(String(v)).getTime())) || isSlashDate(v))) return "date";
  if (vals.every((v) => URL_RE.test(String(v)))) return vals.every((v) => IMAGE_EXT.test(String(v))) || IMAGE_NAME.test(key) ? "image" : "link";
  if (BODY_KEYS.has(loose) || vals.some((v) => /<\/?(p|h[1-6]|ul|ol|li|a|strong|em|br|img|table)\b/i.test(String(v)))) return "formattedText";
  return "string";
}

export function inferFields(records: SourceRecord[], sync: SyncConfig): { fields: FieldDef[]; skipped: string[] } {
  const markdown = sync.source.type === "markdown";
  const ignore = new Set(sync.fields.ignore);
  const skip = new Set(["slug", ...(markdown ? [sync.markdown.draftField, "draft"] : [])]);
  const order: string[] = [];
  const values = new Map<string, unknown[]>();
  for (const r of records) {
    for (const [k, v] of Object.entries(r.data)) {
      if (k.startsWith("__") || ignore.has(k) || skip.has(k)) continue;
      if (!values.has(k)) { values.set(k, []); order.push(k); }
      values.get(k)!.push(v);
    }
  }
  const fields: FieldDef[] = [], skipped: string[] = [];
  const used = new Set<string>();
  for (const k of order) {
    const vals = values.get(k)!;
    if (vals.some((v) => v !== null && typeof v === "object" && !(v instanceof Date))) { skipped.push(`${k} (lists and objects aren't supported)`); continue; }
    const name = pretty(k, markdown);
    let id = fieldId(name);
    while (used.has(id)) id = `${id}_2`.slice(0, 64);
    used.add(id);
    fields.push({ id, name, type: markdown && k === "content" ? "formattedText" : inferType(k, vals) });
  }
  if (fields.length > 30) skipped.push(...fields.splice(30).map((f) => `${f.name} (Framer allows 30 fields)`));
  return { fields, skipped };
}
