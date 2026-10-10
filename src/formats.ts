// File formats: Excel read/write, CSV write, Google Sheets links.

import ExcelJS from "exceljs";
import { SyncError } from "./core/issues.ts";

// ---------------------------------------------------------------------------
// Excel

type Cell = ExcelJS.CellValue;

/** A plain value from an Excel cell: dates as ISO strings, links as their address, formulas as their result. */
function cellValue(v: Cell): unknown {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("result" in o) return cellValue(o.result as Cell);
    if ("richText" in o) return (o.richText as { text: string }[]).map((r) => r.text).join("");
    if ("hyperlink" in o) return /^https?:\/\//i.test(String(o.text ?? "")) ? o.text : o.hyperlink;
    if ("text" in o) return o.text;
    if ("error" in o) return "";
  }
  return v;
}

export async function excelSheets(file: string): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb.worksheets.map((w) => w.name);
}

/** Rows of an Excel sheet as objects, using the first row as column names. */
export async function readExcel(file: string, sheet?: string): Promise<Record<string, unknown>[]> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.readFile(file); }
  catch (e) { throw new SyncError("INPUT_INVALID", `couldn't read the Excel file: ${(e as Error).message}`, { fix: "save it as .xlsx (Excel 2007 or later)" }); }
  const ws = sheet ? wb.getWorksheet(sheet) : wb.worksheets[0];
  if (!ws) throw new SyncError("INPUT_INVALID", `no sheet named "${sheet}"`, { fix: `use one of: ${wb.worksheets.map((w) => w.name).join(", ")}` });
  const header: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => { header[col] = String(cellValue(cell.value)).trim(); });
  const rows: Record<string, unknown>[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const rec: Record<string, unknown> = {};
    let any = false;
    header.forEach((h, col) => { if (!h) return; const v = cellValue(row.getCell(col).value); rec[h] = v; if (v !== "" && v !== null) any = true; });
    if (any) rows.push(rec);
  });
  return rows;
}

export async function writeExcel(file: string, rows: Record<string, unknown>[], columns: string[], sheetName = "Items") {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31).replace(/[\\/?*[\]:]/g, " "));
  ws.columns = columns.map((c) => ({ header: c, key: c, width: Math.min(60, Math.max(12, c.length + 2)) }));
  for (const r of rows) ws.addRow(Object.fromEntries(columns.map((c) => [c, r[c] ?? ""])));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  await wb.xlsx.writeFile(file);
}

// ---------------------------------------------------------------------------
// CSV

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  return [columns.map(csvCell).join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Google Sheets

/**
 * Turn a Google Sheets link into its CSV export address. Accepts the normal editor link
 * (…/spreadsheets/d/<id>/edit#gid=<tab>) and "Publish to web" links. Other URLs pass through.
 */
export function googleSheetCsvUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  if (!/(^|\.)docs\.google\.com$/.test(u.hostname) || !u.pathname.includes("/spreadsheets/")) return url;
  const pub = u.pathname.match(/\/spreadsheets\/d\/e\/([^/]+)/);
  if (pub) {
    const out = new URL(`https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub`);
    out.searchParams.set("output", "csv");
    const gid = u.searchParams.get("gid"); if (gid) out.searchParams.set("gid", gid);
    return out.toString();
  }
  const id = u.pathname.match(/\/spreadsheets\/d\/([^/]+)/)?.[1];
  if (!id) return url;
  const gid = u.hash.match(/gid=(\d+)/)?.[1] ?? u.searchParams.get("gid") ?? "0";
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

export const isGoogleSheet = (url: string) => /docs\.google\.com\/spreadsheets\//.test(url);
