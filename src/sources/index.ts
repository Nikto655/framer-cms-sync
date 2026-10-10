// Load records for a sync from: the request body, files/folders, or the configured source.
//
// "complete" says whether the records are the WHOLE data set. Only complete loads may prune:
//   JSON/CSV body, JSON/CSV file, a URL, a Markdown folder or glob  -> complete
//   a single Markdown post (body or file)                           -> not complete

import { glob, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import type { SyncConfig } from "../config/schema.ts";
import type { SourceRecord } from "../types.ts";
import { SyncError, type Issue } from "../core/issues.ts";
import type { LintRule } from "../lint/rules.ts";
import { parsePost } from "./markdown.ts";
import { flatten, locateRows } from "../core/inspect.ts";
import { googleSheetCsvUrl, isGoogleSheet, readExcel } from "../formats.ts";
import { formatFromPath, isMarkdownFile } from "../core/filetypes.ts";

export interface SourceInput {
  /** Already-parsed records: an array, or { rows | records | data | items | posts }. */
  records?: unknown;
  /** Raw text: JSON, CSV or Markdown. */
  text?: string;
  /** Hint for raw text: "application/json", "text/csv", "text/markdown". */
  contentType?: string;
  /** Files, folders or globs. */
  files?: string[];
}

export interface Loaded {
  records: SourceRecord[];
  issues: Issue[];
  complete: boolean;
  from: string;
  /** For a sync with no source of its own ("none"): what the data sent in turned out to be. */
  as?: Exclude<SyncConfig["source"]["type"], "none">;
}

type DataKind = Exclude<SyncConfig["source"]["type"], "none">;

/** A pass-through sync seen as the kind of data that was sent: posts behave like a Markdown sync,
 *  rows like a JSON one keyed by the exact `slug` (unless the sync sets a key). */
export function asKind(sync: SyncConfig, kind: DataKind): SyncConfig {
  return { ...sync, source: { ...sync.source, type: kind }, key: sync.key ?? (kind === "markdown" ? undefined : { field: "slug", transform: "none" }) };
}

const looksLikePosts = (b: unknown): boolean => {
  if (typeof b === "string") return true;
  const o = b as Record<string, unknown>;
  if (Array.isArray(b)) return b.length > 0 && (typeof b[0] === "string" || typeof (b[0] as Record<string, unknown>)?.markdown === "string");
  return !!o && (typeof o.markdown === "string" || Array.isArray(o.posts));
};

function kindOf(input: SourceInput): DataKind {
  if (input.records !== undefined && input.records !== null) return looksLikePosts(input.records) ? "markdown" : "json";
  if (input.text !== undefined && input.text.trim()) {
    const t = sniff(input.text, input.contentType, "json");
    if (t !== "json") return t;
    try { return looksLikePosts(JSON.parse(input.text)) ? "markdown" : "json"; } catch { return "json"; }
  }
  const files = input.files ?? [];
  if (files.length && files.every((f) => isMarkdownFile(f) || !path.extname(f))) return "markdown";
  const k = formatFromPath(files[0] ?? "");
  return k === "excel" || k === "csv" ? k : "json";
}

export interface LoadContext {
  baseDir: string;
  lintRules?: Record<string, LintRule>;
  fetchTimeoutMs?: number;
}

export const unwrapN8n = (r: unknown): Record<string, unknown> => {
  if (r && typeof r === "object" && "json" in r && (r as { json: unknown }).json && typeof (r as { json: unknown }).json === "object")
    return (r as { json: Record<string, unknown> }).json;
  return (r ?? {}) as Record<string, unknown>;
};

export function rowsFromJson(b: unknown, rowsPath?: string): unknown[] {
  const found = locateRows(b, rowsPath);
  if (found.rows) return found.rows;
  const best = found.candidates[0];
  throw new SyncError("INPUT_INVALID",
    rowsPath ? `no list of records at "${rowsPath}"` : "couldn't find the list of records in this JSON",
    { fix: best ? `the records look like they're at "${best.path}" (${best.count} items): set source.rows: ${best.path}` : 'send [ {...}, {...} ] or { "rows": [ ... ] }, or set source.rows to where the list is (run `inspect` to see the shape)' });
}

/** n8n items are unwrapped; nested objects become dotted keys ("price.amount"). */
const toRecord = (r: unknown): Record<string, unknown> => flatten(unwrapN8n(r));
const toRecords = (rows: unknown[], label: string): SourceRecord[] =>
  rows.map((r, i) => ({ data: toRecord(r), origin: `${label} ${i + 1}` }));

export function parseCsvText(text: string): unknown[] {
  try {
    return parseCsv(text, { columns: true, bom: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch (e) {
    throw new SyncError("INPUT_INVALID", `CSV couldn't be parsed: ${(e as Error).message}`, { fix: "check the file has a header row and consistent quoting" });
  }
}

export function parseJsonText(text: string): unknown {
  try { return JSON.parse(text); } catch (e) {
    throw new SyncError("INPUT_INVALID", `invalid JSON: ${(e as Error).message}`, { fix: "validate the JSON (e.g. a missing comma or quote)" });
  }
}

export function sniff(text: string, hint: string | undefined, fallback: SyncConfig["source"]["type"]): "json" | "csv" | "markdown" {
  if (fallback === "excel") fallback = "csv";
  if (fallback === "none") fallback = "json";
  const h = (hint || "").toLowerCase();
  if (h.includes("json")) return "json";
  if (h.includes("csv")) return "csv";
  if (h.includes("markdown")) return "markdown";
  const t = text.trimStart();
  if (t.startsWith("[") || t.startsWith("{")) return "json";
  if (t.startsWith("---")) return "markdown";
  return fallback;
}

function markdownFromParsed(b: unknown, sync: SyncConfig, ctx: LoadContext): Loaded {
  // {markdown} | {posts:[markdown | {markdown, slug}]} | [markdown...]
  const posts: { markdown: string; slug?: string }[] = [];
  const obj = b as Record<string, unknown>;
  if (typeof b === "string") posts.push({ markdown: b });
  else if (obj && typeof obj.markdown === "string") posts.push({ markdown: obj.markdown, slug: obj.slug as string | undefined });
  else if (Array.isArray(obj?.posts) || Array.isArray(b)) {
    for (const p of (Array.isArray(b) ? b : (obj.posts as unknown[]))) posts.push(typeof p === "string" ? { markdown: p } : (p as { markdown: string; slug?: string }));
  } else throw new SyncError("INPUT_INVALID", "for a Markdown sync, send Markdown text, {markdown}, or {posts:[...]}");
  const records: SourceRecord[] = [], issues: Issue[] = [];
  posts.forEach((p, i) => {
    const label = p.slug ? `${p.slug}.md` : `post ${i + 1}`;
    const r = parsePost(String(p.markdown ?? ""), label, sync, ctx.lintRules);
    issues.push(...r.issues);
    if (r.record) { if (p.slug) r.record.slugHint = p.slug; records.push(r.record); }
  });
  return { records, issues, complete: false, from: "body" };
}

async function expand(p: string, baseDir: string): Promise<{ files: string[]; folder: boolean }> {
  const abs = path.resolve(baseDir, p);
  if (/[*?[\]{}]/.test(p)) {
    const files: string[] = [];
    for await (const f of glob(p, { cwd: baseDir })) files.push(path.resolve(baseDir, f as string));
    return { files: files.sort(), folder: true };
  }
  let s;
  try { s = await stat(abs); } catch { throw new SyncError("INPUT_INVALID", `no such file or folder: ${p}`, { fix: "check the path (relative paths start from the config file's folder)" }); }
  if (s.isDirectory()) {
    const entries = await readdir(abs, { recursive: true });
    return { files: entries.filter(isMarkdownFile).map((f) => path.join(abs, f)).sort(), folder: true };
  }
  return { files: [abs], folder: false };
}

async function loadFiles(paths: string[], sync: SyncConfig, ctx: LoadContext): Promise<Loaded> {
  const records: SourceRecord[] = [], issues: Issue[] = [];
  let complete = true, anyFolder = false;
  for (const p of paths) {
    const { files, folder } = await expand(p, ctx.baseDir);
    anyFolder ||= folder;
    for (const f of files) {
      const rel = path.relative(ctx.baseDir, f) || f;
      if (formatFromPath(f) === "excel" || (sync.source.type === "excel" && !formatFromPath(f))) {
        const rows = await readExcel(f, sync.source.sheet);
        records.push(...rows.map((r, i) => ({ data: r, origin: `${rel} row ${i + 2}` })));
        continue;
      }
      const text = await readFile(f, "utf8");
      const type = formatFromPath(f) ?? sync.source.type;
      if (type === "markdown") {
        const r = parsePost(text, rel, sync, ctx.lintRules);
        issues.push(...r.issues);
        if (r.record) records.push(r.record);
      } else {
        const rows = type === "csv" ? parseCsvText(text) : rowsFromJson(parseJsonText(text), sync.source.rows);
        records.push(...rows.map((r, i) => ({ data: toRecord(r), origin: `${rel} row ${i + 1}` })));
      }
    }
  }
  if (sync.source.type === "markdown" && !anyFolder) complete = false;
  const shown = paths.map((p) => { const r = path.relative(ctx.baseDir, path.resolve(ctx.baseDir, p)); return r && !r.startsWith("..") ? r : p; });
  return { records, issues, complete, from: shown.join(", ") };
}

/**
 * GET a source URL. Google Sheets share links are fetched as their CSV export (and reported as CSV).
 * `label` is how errors name the URL: a configured URL may carry a secret, so syncs don't print it.
 */
export async function fetchSourceText(url: string, o: { label: string; authFix: string; headers?: Record<string, string>; timeoutMs?: number }): Promise<{ text: string; contentType?: string }> {
  const sheet = isGoogleSheet(url);
  let res: Response;
  try {
    res = await fetch(googleSheetCsvUrl(url), { headers: o.headers ?? {}, signal: AbortSignal.timeout(o.timeoutMs ?? 60_000) });
  } catch (e) {
    throw new SyncError("SOURCE_FAILED", `couldn't reach ${o.label}: ${(e as Error).message}`, { fix: "check the URL and that the server is up" });
  }
  if (!res.ok) throw new SyncError("SOURCE_FAILED", `${o.label} answered HTTP ${res.status}`, { fix: res.status === 401 || res.status === 403 ? o.authFix : "check the URL" });
  const contentType = res.headers.get("content-type") ?? undefined;
  if (sheet && /text\/html/i.test(contentType ?? "")) {
    throw new SyncError("SOURCE_FAILED", "the Google Sheet isn't shared, so it can't be read",
      { fix: "in Google Sheets: Share → General access → Anyone with the link → Viewer (or File → Share → Publish to web → CSV)" });
  }
  return { text: await res.text(), contentType: sheet ? "text/csv" : contentType };
}

async function loadUrl(sync: SyncConfig, ctx: LoadContext): Promise<Loaded> {
  const { text, contentType } = await fetchSourceText(sync.source.url!, {
    label: "the source URL", authFix: "check source.headers (auth)", headers: sync.source.headers, timeoutMs: ctx.fetchTimeoutMs,
  });
  const type = sniff(text, contentType, sync.source.type === "excel" ? "csv" : sync.source.type);
  if (type === "markdown") return { ...markdownFromParsed(text, sync, ctx), from: "url" };
  const rows = type === "csv" ? parseCsvText(text) : rowsFromJson(parseJsonText(text), sync.source.rows);
  return { records: toRecords(rows, "row"), issues: [], complete: true, from: "url" };
}

export async function loadSource(sync: SyncConfig, input: SourceInput | undefined, ctx: LoadContext): Promise<Loaded> {
  if (sync.source.type === "none") {
    const has = !!input && ((input.records !== undefined && input.records !== null) || !!input.text?.trim() || !!input.files?.length);
    if (!has) throw new SyncError("NO_INPUT", "this sync has no source of its own: its data is sent in",
      { fix: "send posts or rows: `add` / `update` for Markdown posts, `apply <sync> <file>` (or - for stdin), POST /syncs/<sync>/apply or /items, or the MCP tools" });
    const kind = kindOf(input!);
    return { ...(await loadSource(asKind(sync, kind), input, ctx)), as: kind };
  }
  const hasText = input?.text !== undefined && input.text.trim() !== "";
  if (input?.records !== undefined && input.records !== null) {
    if (sync.source.type === "markdown") return markdownFromParsed(input.records, sync, ctx);
    return { records: toRecords(rowsFromJson(input.records, sync.source.rows), "row"), issues: [], complete: true, from: "body" };
  }
  if (hasText) {
    const type = sniff(input!.text!, input!.contentType, sync.source.type);
    if (type === "markdown") return markdownFromParsed(input!.text!, sync, ctx);
    if (sync.source.type === "markdown" && type === "json") return markdownFromParsed(parseJsonText(input!.text!), sync, ctx);
    const rows = type === "csv" ? parseCsvText(input!.text!) : rowsFromJson(parseJsonText(input!.text!), sync.source.rows);
    return { records: toRecords(rows, "row"), issues: [], complete: true, from: "body" };
  }
  if (input?.files?.length) return loadFiles(input.files, sync, ctx);
  if (sync.source.path) return loadFiles([sync.source.path], sync, ctx);
  if (sync.source.url) return loadUrl(sync, ctx);
  throw new SyncError("NO_INPUT", "no data: nothing was sent and the sync has no source.path or source.url",
    { fix: "pass a file (e.g. `plan mysync ./data.csv`), send a body, or set source.path / source.url" });
}
