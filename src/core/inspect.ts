// Inspect source data: what format it is, where the rows are, and what fields they have.
// Pure functions; nothing is fetched or stored here.

import { inferType } from "./infer.ts";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

/** Nested objects become dotted keys: { price: { amount: 21 } } → { "price.amount": 21 }. Arrays stay as they are. */
export function flatten(obj: Record<string, unknown>, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && Object.keys(v).length) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

/** Value at a dotted path ("data.items"). */
export function getPath(doc: unknown, p: string): unknown {
  let cur = doc;
  for (const part of p.split(".").filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(part) ? cur[Number(part)] : (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const TOP_LEVEL_KEYS = ["rows", "records", "data", "items"];

/** Lists of objects anywhere in the document (up to 4 levels deep), largest first. */
export function findLists(doc: unknown, maxDepth = 4): { path: string; count: number }[] {
  const out: { path: string; count: number }[] = [];
  const walk = (v: unknown, p: string, depth: number) => {
    if (Array.isArray(v)) {
      if (v.length && v.every(isPlainObject)) out.push({ path: p || "(top level)", count: v.length });
      return;
    }
    if (isPlainObject(v) && depth < maxDepth) for (const [k, child] of Object.entries(v)) walk(child, p ? `${p}.${k}` : k, depth + 1);
  };
  walk(doc, "", 0);
  return out.sort((a, b) => b.count - a.count);
}

/**
 * Find the rows in a parsed JSON document. With `rowsPath`, use exactly that; otherwise accept a
 * top-level list or { rows | records | data | items: [...] }. Returns null (plus candidates) if not found.
 */
export function locateRows(doc: unknown, rowsPath?: string): { rows: unknown[] | null; at: string | null; candidates: { path: string; count: number }[] } {
  if (rowsPath) {
    const v = getPath(doc, rowsPath);
    return Array.isArray(v) ? { rows: v, at: rowsPath, candidates: [] } : { rows: null, at: null, candidates: findLists(doc) };
  }
  if (Array.isArray(doc)) return { rows: doc, at: "(top level)", candidates: [] };
  if (isPlainObject(doc)) for (const k of TOP_LEVEL_KEYS) if (Array.isArray(doc[k])) return { rows: doc[k] as unknown[], at: k, candidates: [] };
  return { rows: null, at: null, candidates: findLists(doc) };
}

export interface FieldStat { path: string; type: string; filled: number; sample?: unknown; examples: unknown[] }

/** Field-by-field summary of records (already flattened). */
export function describeRecords(records: Record<string, unknown>[]): FieldStat[] {
  const order: string[] = [];
  const values = new Map<string, unknown[]>();
  for (const r of records) for (const [k, v] of Object.entries(r)) {
    if (k.startsWith("__")) continue;
    if (!values.has(k)) { values.set(k, []); order.push(k); }
    values.get(k)!.push(v);
  }
  const short = (v: unknown) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 60 ? s.slice(0, 60) + "…" : s; };
  return order.map((path) => {
    const vals = values.get(path)!;
    const filled = vals.filter((v) => v !== null && v !== undefined && v !== "");
    const type = filled.some(Array.isArray) ? "list" : filled.some(isPlainObject) ? "object" : inferType(path.split(".").pop()!, filled);
    const distinct = [...new Set(filled.map(short))];
    return { path, type, filled: filled.length, ...(filled.length ? { sample: filled[0] } : {}), examples: distinct.slice(0, 3) };
  });
}
