// `inspect`: look at source data before (or without) setting up a sync. Fetches a URL live
// (GET only) or reads a file; nothing is stored. Works without a config.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { syncSchema } from "./config/schema.ts";
import { loadSource, parseCsvText, parseJsonText, sniff, unwrapN8n, fetchSourceText } from "./sources/index.ts";
import { describeRecords, flatten, locateRows, type FieldStat } from "./core/inspect.ts";
import { SyncError } from "./core/issues.ts";
import { excelSheets, readExcel } from "./formats.ts";
import { formatFromPath } from "./core/filetypes.ts";

export interface InspectTarget {
  url?: string;
  file?: string;
  /** Data that was sent in (pushed): parsed records/document, or raw text. */
  records?: unknown;
  text?: string;
  contentType?: string;
  /** Where the rows are in a JSON document (dotted path). */
  rows?: string;
  /** Excel: which sheet to read. */
  sheet?: string;
  headers?: Record<string, string>;
  baseDir?: string;
  fetchTimeoutMs?: number;
}

export interface InspectReport {
  ok: boolean;
  from: string;
  format: "json" | "csv" | "excel" | "markdown";
  /** Excel: the sheets (tabs) in the file. */
  sheets?: string[];
  rowsAt: string | null;
  records: number;
  fields: FieldStat[];
  candidates?: { path: string; count: number }[];
  suggestedKey?: string;
  suggestedSource?: Record<string, unknown>;
  note?: string;
}

function suggestKey(fields: FieldStat[], records: Record<string, unknown>[]): string | undefined {
  const preferred = ["slug", "id", "name", "title", "handle", "sku", "key"];
  const unique = fields.filter((f) => f.filled === records.length && f.type !== "list" && f.type !== "object" && new Set(records.map((r) => String(r[f.path]))).size === records.length);
  const byName = (f: FieldStat) => { const i = preferred.indexOf(f.path.split(".").pop()!.toLowerCase()); return i < 0 ? 99 : i; };
  return unique.sort((a, b) => byName(a) - byName(b))[0]?.path;
}

function fromJson(doc: unknown, rowsPath: string | undefined, from: string): InspectReport {
  const found = locateRows(doc, rowsPath);
  if (!found.rows) {
    const best = found.candidates[0];
    return {
      ok: false, from, format: "json", rowsAt: null, records: 0, fields: [], candidates: found.candidates,
      note: rowsPath ? `no list of records at "${rowsPath}"` : best ? "the records aren't at the top level of this JSON" : "no list of records found in this JSON",
    };
  }
  const records = found.rows.map((r) => flatten(unwrapN8n(r)));
  const fields = describeRecords(records);
  return { ok: true, from, format: "json", rowsAt: found.at, records: records.length, fields, suggestedKey: suggestKey(fields, records) };
}

export async function inspectSource(t: InspectTarget): Promise<InspectReport> {
  const baseDir = t.baseDir ?? process.cwd();
  let text: string | undefined, contentType = t.contentType, from: string;

  if (t.records !== undefined) {
    return fromJson(t.records, t.rows, "sent data");
  } else if (t.text !== undefined) {
    text = t.text; from = "sent data";
  } else if (t.url) {
    if (!/^https?:\/\//i.test(t.url)) throw new SyncError("INPUT_INVALID", "the URL must start with http:// or https://");
    ({ text, contentType } = await fetchSourceText(t.url, {
      label: t.url, authFix: 'it needs authentication: add a header (e.g. --header "Authorization: Bearer …")', headers: t.headers, timeoutMs: t.fetchTimeoutMs ?? 30_000,
    }));
    from = t.url;
  } else if (t.file) {
    const abs = path.resolve(baseDir, t.file);
    let st;
    try { st = await stat(abs); } catch { throw new SyncError("INPUT_INVALID", `no such file or folder: ${t.file}`); }
    if (st.isDirectory()) {
      const probe = syncSchema.parse({ collection: { name: "inspect" }, source: { type: "markdown", path: abs } });
      const loaded = await loadSource(probe, undefined, { baseDir });
      const records = loaded.records.map((r) => r.data);
      const fields = describeRecords(records);
      return { ok: true, from: t.file, format: "markdown", rowsAt: null, records: records.length, fields, suggestedKey: "slug",
        suggestedSource: { type: "markdown", path: t.file }, note: "one record per .md file: frontmatter keys plus content (the rendered body); the slug comes from slug: or the filename" };
    }
    if (formatFromPath(abs) === "excel") {
      const records = await readExcel(abs, t.sheet);
      const fields = describeRecords(records);
      const sheets = await excelSheets(abs);
      return { ok: true, from: t.file, format: "excel", rowsAt: null, records: records.length, fields, suggestedKey: suggestKey(fields, records),
        suggestedSource: { type: "excel", path: t.file, ...(t.sheet ? { sheet: t.sheet } : {}) }, sheets };
    }
    text = await readFile(abs, "utf8"); from = t.file;
    contentType ??= ({ csv: "text/csv", json: "application/json", markdown: "text/markdown" } as Record<string, string>)[formatFromPath(abs) ?? ""];
  } else {
    throw new SyncError("NO_INPUT", "nothing to inspect", { fix: "give a URL, a file or folder, a sync name, or send the data" });
  }

  const format = sniff(text!, contentType, "json");
  let report: InspectReport;
  if (format === "json") report = fromJson(parseJsonText(text!), t.rows, from!);
  else if (format === "csv") {
    const records = (parseCsvText(text!) as Record<string, unknown>[]);
    const fields = describeRecords(records);
    report = { ok: true, from: from!, format: "csv", rowsAt: null, records: records.length, fields, suggestedKey: suggestKey(fields, records) };
  } else {
    const probe = syncSchema.parse({ collection: { name: "inspect" }, source: { type: "markdown" } });
    const loaded = await loadSource(probe, { text: text! }, { baseDir });
    const records = loaded.records.map((r) => r.data);
    report = { ok: true, from: from!, format: "markdown", rowsAt: null, records: records.length, fields: describeRecords(records), suggestedKey: "slug" };
  }
  if (report.ok && !report.suggestedSource) {
    report.suggestedSource = {
      type: report.format,
      ...(t.url ? { url: t.url } : t.file ? { path: t.file } : {}),
      ...(report.format === "json" && report.rowsAt && report.rowsAt !== "(top level)" && !["rows", "records", "data", "items"].includes(report.rowsAt) ? { rows: report.rowsAt } : {}),
      ...(t.rows ? { rows: t.rows } : {}),
    };
  }
  return report;
}
