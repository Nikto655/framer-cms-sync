// Download CMS items into a file (so your local data starts identical to the CMS),
// and write starter templates for new collections.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import TurndownService from "turndown";
import { stringify as toYaml } from "yaml";
import type { ExistingItem, FieldDef } from "./types.ts";
import { toCsv, writeExcel } from "./formats.ts";
import { SyncError } from "./core/issues.ts";
import { norm } from "./core/identity.ts";
import { isMarkdownFile } from "./core/filetypes.ts";

export type FileFormat = "csv" | "excel" | "json" | "markdown";

export interface WriteResult {
  format: FileFormat;
  dest: string;
  files: number;
  rows: number;
  columns: string[];
  /** The column that identifies each row in the written file. */
  keyColumn: string;
  /** How the key column turns into a slug: "none" when the file carries exact slugs. */
  keyTransform: "none" | "slugify";
  /** Markdown: the collection field the post body goes to (for fields.map: { content: … }). */
  bodyField?: string;
}

const SETTABLE = new Set(["string", "formattedText", "number", "boolean", "date", "enum", "color", "link", "image", "file", "collectionReference", "multiCollectionReference"]);
const BODY_NAMES = ["contenthtml", "content", "body", "postbody", "article", "post"];

function ensureWritable(dest: string, format: FileFormat, overwrite?: boolean) {
  if (format === "markdown") {
    if (existsSync(dest) && readdirSync(dest).some(isMarkdownFile) && !overwrite)
      throw new SyncError("INPUT_INVALID", `${dest} already has Markdown files`, { fix: "choose an empty folder, or allow overwriting" });
    mkdirSync(dest, { recursive: true });
  } else {
    if (existsSync(dest) && !overwrite) throw new SyncError("INPUT_INVALID", `${dest} already exists`, { fix: "choose another file name, or allow overwriting" });
    mkdirSync(path.dirname(dest), { recursive: true });
  }
}

/** A plain value for a file: dates as YYYY-MM-DD (or ISO), options by name, images/files by URL. */
export function plainValue(entry: { type: string; value: unknown } | undefined, field: FieldDef): unknown {
  if (!entry) return "";
  const v = entry.value as unknown;
  if (v === null || v === undefined) return "";
  switch (field.type) {
    case "date": {
      const d = new Date(v as string);
      if (isNaN(d.getTime())) return "";
      const iso = d.toISOString();
      return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
    }
    case "enum": return field.cases?.find((c) => c.id === v)?.name ?? v;
    case "image": case "file": return typeof v === "object" ? ((v as { url?: string }).url ?? "") : v;
    case "color": return typeof v === "object" ? ((v as { light?: string }).light ?? JSON.stringify(v)) : v;
    case "multiCollectionReference": return Array.isArray(v) ? v.join(", ") : v;
    case "boolean": return v === true;
    default: return v;
  }
}

function bodyFieldOf(fields: FieldDef[]): FieldDef | undefined {
  const rich = fields.filter((f) => f.type === "formattedText");
  return rich.find((f) => BODY_NAMES.includes(norm(f.name))) ?? rich[0];
}

/**
 * Write a collection's items to a file or folder. Rows carry a `slug` column (exact slugs) so a later
 * sync matches every existing item instead of creating duplicates; drafts get `published: false`.
 */
export async function writeItems(o: { items: ExistingItem[]; fields: FieldDef[]; format: FileFormat; dest: string; overwrite?: boolean; sheetName?: string }): Promise<WriteResult> {
  const fields = o.fields.filter((f) => SETTABLE.has(f.type));
  const anyDraft = o.items.some((i) => i.draft);
  ensureWritable(o.dest, o.format, o.overwrite);
  const items = [...o.items].sort((a, b) => a.slug.localeCompare(b.slug));

  if (o.format === "markdown") {
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
    // Keep line breaks as <br> (Markdown passes HTML through), so a break inside a paragraph
    // doesn't come back as a new paragraph.
    td.addRule("lineBreak", { filter: "br", replacement: () => "<br>" });
    const body = bodyFieldOf(fields);
    for (const it of items) {
      const fm: Record<string, unknown> = { slug: it.slug };
      for (const f of fields) {
        if (f.id === body?.id) continue;
        const v = plainValue(it.fieldData[f.id], f);
        if (v !== "" && v !== null && v !== undefined) fm[f.name] = v;
      }
      if (it.draft) fm.published = false;
      const html = body ? String(plainValue(it.fieldData[body.id], body) ?? "") : "";
      // Tidy list markers ("-   item" → "- item") for readable files.
      const md = html ? td.turndown(html).replace(/^(\s*)([-*]|\d+\.)\s{2,}/gm, "$1$2 ") : "";
      writeFileSync(path.join(o.dest, `${it.slug}.md`), `---\n${toYaml(fm, { lineWidth: 0 }).trimEnd()}\n---\n\n${md}\n`);
    }
    return { format: "markdown", dest: o.dest, files: items.length, rows: items.length, columns: ["slug", ...fields.map((f) => f.name)], keyColumn: "slug", keyTransform: "none", bodyField: body?.name };
  }

  const columns = ["slug", ...fields.map((f) => f.name), ...(anyDraft ? ["published"] : [])];
  const rows = items.map((it) => {
    const r: Record<string, unknown> = { slug: it.slug };
    for (const f of fields) r[f.name] = plainValue(it.fieldData[f.id], f);
    if (anyDraft) r.published = !it.draft;
    return r;
  });
  if (o.format === "csv") writeFileSync(o.dest, toCsv(rows, columns));
  else if (o.format === "excel") await writeExcel(o.dest, rows, columns, o.sheetName ?? "Items");
  else writeFileSync(o.dest, JSON.stringify(rows, null, 2) + "\n");
  return { format: o.format, dest: o.dest, files: 1, rows: rows.length, columns, keyColumn: "slug", keyTransform: "none" };
}

// ---------------------------------------------------------------------------
// Templates

const EXAMPLE: Record<string, unknown> = {
  string: "Example", formattedText: "<p>Some <strong>rich</strong> text.</p>", number: 42, boolean: true,
  date: "2026-01-31", color: "#3366FF", link: "https://example.com", image: "https://picsum.photos/seed/example/1200/630",
  file: "https://example.com/file.pdf", collectionReference: "", multiCollectionReference: "",
};

const BASIC_COLUMNS: { name: string; example: unknown }[] = [
  { name: "Name", example: "First item" },
  { name: "Description", example: "A short description." },
  { name: "Price", example: 19.99 },
  { name: "Image", example: "https://picsum.photos/seed/first-item/1200/630" },
  { name: "Link", example: "https://example.com" },
  { name: "Featured", example: true },
  { name: "Date", example: "2026-01-31" },
];

/**
 * A starter file with one example row. With `fields` (copying another collection) the columns are its
 * field names; otherwise a general-purpose set. The example row lets field types be worked out.
 */
export async function writeTemplate(o: { format: FileFormat; dest: string; fields?: FieldDef[]; overwrite?: boolean }): Promise<WriteResult> {
  ensureWritable(o.dest, o.format, o.overwrite);
  const fields = o.fields?.filter((f) => SETTABLE.has(f.type));

  if (o.format === "markdown") {
    const body = fields ? bodyFieldOf(fields) : undefined;
    const fm: Record<string, unknown> = { slug: "hello-world" };
    if (fields?.length) {
      for (const f of fields) if (f.id !== body?.id) fm[f.name] = f.type === "string" && /title|name/i.test(f.name) ? "Hello, world" : f.type === "enum" ? f.cases?.[0]?.name ?? "" : EXAMPLE[f.type];
    } else Object.assign(fm, { title: "Hello, world", date: "2026-01-31", author: "Your name", thumbnail: "https://picsum.photos/seed/hello/1200/630", meta_description: "A one-line summary for search results." });
    writeFileSync(path.join(o.dest, "hello-world.md"), `---\n${toYaml(fm, { lineWidth: 0 }).trimEnd()}\n---\n\nThis is the post body, written in **Markdown**.\n\nAdd one file per post. The file name (or \`slug:\`) becomes the page address.\n`);
    return { format: "markdown", dest: o.dest, files: 1, rows: 1, columns: Object.keys(fm), keyColumn: "slug", keyTransform: "none", bodyField: body?.name };
  }

  const cols = fields?.length
    ? fields.map((f) => ({ name: f.name, example: f.type === "string" && /title|name/i.test(f.name) ? "First item" : f.type === "enum" ? f.cases?.[0]?.name ?? "" : EXAMPLE[f.type] }))
    : BASIC_COLUMNS;
  const columns = cols.map((c) => c.name);
  const row = Object.fromEntries(cols.map((c) => [c.name, c.example]));
  const key = cols.find((c) => /^(title|name)$/i.test(c.name))?.name ?? fields?.find((f) => f.type === "string")?.name ?? columns[0];
  if (o.format === "csv") writeFileSync(o.dest, toCsv([row], columns));
  else if (o.format === "excel") await writeExcel(o.dest, [row], columns);
  else writeFileSync(o.dest, JSON.stringify([row], null, 2) + "\n");
  return { format: o.format, dest: o.dest, files: 1, rows: 1, columns, keyColumn: key, keyTransform: "slugify" };
}
