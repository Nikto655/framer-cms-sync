// Records -> items. Works out each record's slug and id, matches record keys to
// collection fields, converts values, and collects issues.
//
// Missing vs empty (kept from the original framer-sync):
//   key absent from the record      -> field untouched in Framer
//   key present with null/undefined -> field cleared (fields.nulls: clear) or kept (skip)

import type { FieldDef, FieldData, SourceRecord } from "../types.ts";
import type { SyncConfig } from "../config/schema.ts";
import { coerce } from "./coerce.ts";
import { itemId, keyToSlug, norm, SLUG_RE } from "./identity.ts";
import { issue, type Issue } from "./issues.ts";

export interface MappedItem {
  slug: string;
  id: string;
  draft?: boolean;
  fieldData: FieldData;
  origin: string;
}

/** Frontmatter key -> candidate field names (normalised). First match wins. */
export const DEFAULT_ALIASES: Record<string, string[]> = {
  title: ["title", "name", "posttitle"],
  date: ["publishdate", "date", "publisheddate", "publishedat", "publishedon"],
  updated: ["updateddate", "updated", "lastupdated", "modifieddate", "modified"],
  author: ["author", "authorname"],
  category: ["categories", "category"],
  tags: ["tags", "tag"],
  thumbnail: ["thumbnail", "image", "coverimage", "heroimage", "featuredimage"],
  meta_description: ["metadescription", "description", "excerpt", "summary"],
  description: ["metadescription", "description", "excerpt", "summary"],
  featured: ["featured", "isfeatured"],
  published: ["published", "ispublished"],
  content: ["contenthtml", "content", "body", "postbody"],
  title_tag: ["seotitle", "titletag", "metatitle", "pagetitle"],
  seo_title: ["seotitle", "titletag", "metatitle", "pagetitle"],
  thumbnail_alt: ["thumbnailalt", "imagealt", "alt"],
};

const TRUTHY = /^(true|yes|1|y|on)$/i;

export type MatchHow = "map" | "alias" | "exact" | "loose" | "id" | "none" | "map-missing";

/**
 * How a source column is matched to a collection field, in order:
 * explicit fields.map → Markdown aliases → exact name → loose name (case/punctuation ignored) → field id.
 * Shared by syncing and by the mapping view, so both always agree.
 */
export function fieldMatcher(fields: FieldDef[], sync: SyncConfig) {
  const isMarkdown = sync.source.type === "markdown";
  const aliases: Record<string, string[]> =
    typeof sync.markdown.aliases === "object" ? sync.markdown.aliases
      : sync.markdown.aliases === "default" && isMarkdown ? DEFAULT_ALIASES : {};
  const byName = new Map(fields.map((f) => [f.name, f]));
  const byNorm = new Map<string, FieldDef[]>();
  for (const f of fields) byNorm.set(norm(f.name), [...(byNorm.get(norm(f.name)) ?? []), f]);
  const byId = new Map(fields.map((f) => [f.id, f]));
  const resolve = (name: string) => byName.get(name) ?? byNorm.get(norm(name))?.[0] ?? byId.get(name);
  const match = (k: string): { field?: FieldDef; how: MatchHow; ambiguous?: string[] } => {
    const mapped = sync.fields.map[k];
    if (mapped) { const f = resolve(mapped); return f ? { field: f, how: "map" } : { how: "map-missing" }; }
    for (const a of aliases[k] || []) if (byNorm.has(a)) return { field: byNorm.get(a)![0], how: "alias" };
    if (byName.has(k)) return { field: byName.get(k)!, how: "exact" };
    const loose = byNorm.get(norm(k));
    if (loose?.length) return { field: loose[0], how: "loose", ...(loose.length > 1 ? { ambiguous: loose.map((f) => f.name) } : {}) };
    if (byId.has(k)) return { field: byId.get(k)!, how: "id" };
    return { how: "none" };
  };
  return { match, resolve, aliases };
}

export function mapRecords(records: SourceRecord[], fields: FieldDef[], sync: SyncConfig): { items: MappedItem[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const isMarkdown = sync.source.type === "markdown";
  const key = sync.key ?? (isMarkdown ? { field: "slug", transform: "none" as const } : undefined);
  if (!key) throw new Error("key.field is required for json/csv syncs"); // config validation catches this first

  const matcher = fieldMatcher(fields, sync);
  const aliases = matcher.aliases;
  const ignore = new Set(sync.fields.ignore);
  const altFor = new Map(Object.entries(sync.fields.alt)); // field name -> record key
  const findField = (k: string): FieldDef | undefined => matcher.match(k).field;

  const unknown = new Map<string, number>();
  const skippedCounts = new Map<string, { n: number; message: string; code: Issue["code"]; fix?: string }>();
  const usedFields = new Set<string>();
  const bySlug = new Map<string, MappedItem>();

  for (const rec of records) {
    const data = rec.data;
    const rawKey = data[key.field] ?? (key.field === "slug" ? rec.slugHint : undefined);
    const slug = keyToSlug(rawKey, key.transform);
    if (!slug) {
      issues.push(issue("error", "KEY_MISSING", `${rec.origin} has no "${key.field}"`, { record: rec.origin, field: key.field, fix: `add a "${key.field}" value` }));
      continue;
    }
    if (!SLUG_RE.test(slug)) {
      issues.push(issue("error", "SLUG_INVALID", `${rec.origin}: slug "${slug}" must be lowercase words joined by single hyphens`, { record: rec.origin, fix: `e.g. "${keyToSlug(slug, "slugify")}"` }));
      continue;
    }

    const fieldData: FieldData = {};
    const setBy = new Map<string, string>();
    for (const [k, v] of Object.entries(data)) {
      if (ignore.has(k) || k.startsWith("__")) continue;
      const field = findField(k);
      if (!field) {
        // The key column, "slug" and the draft column are used by the sync itself; never warn about them.
        if (!(k in aliases) && k !== "slug" && k !== key.field && k !== sync.markdown.draftField && k !== "draft") unknown.set(k, (unknown.get(k) || 0) + 1);
        continue;
      }
      if (setBy.has(field.id)) continue; // first key wins (explicit map / alias order)
      setBy.set(field.id, k);
      const altKey = altFor.get(field.name) ?? (isMarkdown ? `${k}_alt` : undefined);
      const alt = altKey && data[altKey] != null ? String(data[altKey]) : isMarkdown && data.title ? String(data.title) : undefined;
      const r = coerce(field, v, { nulls: sync.fields.nulls, formattedText: sync.fields.formattedText, alt, dateOrder: sync.fields.dateOrder });
      if (r.ok) { fieldData[field.id] = r.entry; usedFields.add(field.id); continue; }
      if (r.skip) {
        if ("silent" in r && r.silent) continue;
        const s = skippedCounts.get(`${r.code}:${field.name}`) || { n: 0, message: r.message, code: r.code, fix: r.fix };
        s.n++; skippedCounts.set(`${r.code}:${field.name}`, s);
        continue;
      }
      issues.push(issue("error", r.code, `${rec.origin}: ${r.message}`, { record: rec.origin, field: field.name, fix: r.fix }));
    }

    let draft: boolean | undefined;
    const dk = sync.markdown.draftField;
    if (dk && dk in data && data[dk] !== undefined && data[dk] !== null) draft = !(data[dk] === true || TRUTHY.test(String(data[dk])));
    if (data.draft !== undefined && data.draft !== null && !findField("draft")) draft = data.draft === true || TRUTHY.test(String(data.draft));

    const item: MappedItem = { slug, id: itemId(slug), fieldData, origin: rec.origin, ...(draft !== undefined ? { draft } : {}) };
    const prev = bySlug.get(slug);
    if (prev) {
      issues.push(issue(isMarkdown ? "error" : "warning", "DUPLICATE_KEY",
        isMarkdown ? `${prev.origin} and ${rec.origin} have the same slug "${slug}"` : `${prev.origin} and ${rec.origin} both have slug "${slug}"; the later one wins`,
        { record: rec.origin, fix: isMarkdown ? "give one of them a different slug" : undefined }));
    }
    bySlug.set(slug, item);
  }

  if (unknown.size && sync.fields.unknown !== "ignore") {
    for (const [k, n] of unknown) {
      issues.push(issue(sync.fields.unknown === "error" ? "error" : "warning", "UNKNOWN_KEY",
        `"${k}" doesn't match any field in the collection (${n} record${n === 1 ? "" : "s"})`,
        { field: k, fix: `add "${k}" to fields.ignore, or map it with fields.map: { "${k}": "<field name>" }` }));
    }
  }
  for (const s of skippedCounts.values()) {
    issues.push(issue("warning", s.code, `${s.message}${s.n > 1 ? ` (${s.n} records)` : ""}`, { fix: s.fix }));
  }
  if (isMarkdown && records.length) {
    const hasType = (t: string) => fields.some((f) => f.type === t && usedFields.has(f.id));
    const anyBody = records.some((r) => typeof r.data.content === "string" && r.data.content.trim() !== "");
    if (anyBody && !hasType("formattedText") && fields.length)
      issues.push(issue("error", "REQUIRED_FIELD_UNMAPPED", "the posts have a body, but no rich-text field in the collection receives it", { fix: 'map it: fields.map: { content: "<your body field name>" }' }));
  }
  return { items: [...bySlug.values()], issues };
}

/** Plain-words label for how a column was matched (used by the CLI and the terminal app). */
export const HOW_LABEL: Record<MatchHow | "ignored", string> = {
  map: "your mapping",
  alias: "standard name",
  exact: "same name",
  loose: "similar name",
  id: "field id",
  none: "no match",
  "map-missing": "mapped to a field that doesn't exist",
  ignored: "ignored",
};
