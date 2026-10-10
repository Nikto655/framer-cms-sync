// Convert one record value to a Framer field entry, by field type.
// Returns an entry, a "skip" (leave Framer's value alone, with a warning), or an error.

import type { FieldDef, FieldEntry } from "../types.ts";
import { norm } from "./identity.ts";
import type { IssueCode } from "./issues.ts";
import { parseDate, type DateOrder } from "./dates.ts";

export type Coerced =
  | { ok: true; entry: FieldEntry }
  | { ok: false; skip: true; code: IssueCode; message: string; fix?: string; silent?: boolean }
  | { ok: false; skip: false; code: IssueCode; message: string; fix?: string };

export interface CoerceOptions {
  nulls: "clear" | "skip";
  dateOrder?: DateOrder;
  formattedText: "html" | "markdown" | "auto";
  alt?: string;
}

const skip = (code: IssueCode, message: string, fix?: string): Coerced => ({ ok: false, skip: true, code, message, fix });
const fail = (code: IssueCode, message: string, fix?: string): Coerced => ({ ok: false, skip: false, code, message, fix });
const ok = (entry: FieldEntry): Coerced => ({ ok: true, entry });

const isAbsoluteUrl = (s: string) => /^https?:\/\//i.test(s);
const isEmpty = (v: unknown) => v === undefined || v === null;

/** The value written to clear a field when the record has null. undefined = can't be cleared. */
function emptyEntry(field: FieldDef): FieldEntry | undefined {
  switch (field.type) {
    case "string": return { type: "string", value: "" };
    case "formattedText": return { type: "formattedText", value: "" };
    case "boolean": return { type: "boolean", value: false };
    case "date": case "link": case "color": case "image": case "file": case "collectionReference":
      return { type: field.type, value: null };
    case "multiCollectionReference": return { type: field.type, value: [] };
    default: return undefined; // number, enum: Framer has no empty value
  }
}

export function coerce(field: FieldDef, v: unknown, opts: CoerceOptions): Coerced {
  const type = field.type;
  if (type === "array" || type === "divider" || type === "unsupported")
    return skip("FIELD_NOT_SETTABLE", `"${field.name}" is a ${type} field, which the sync can't set`);

  // An empty cell (common in CSVs) means "no value" for every type except plain text.
  if (isEmpty(v) || (v === "" && type !== "string" && type !== "formattedText")) {
    if (type === "number") return skip("NUMBER_EMPTY", `"${field.name}" is empty; Framer can't store an empty number, so the current value is kept`, "give it a number, or leave the column out to stop syncing it");
    if (type === "enum") return skip("ENUM_EMPTY", `"${field.name}" is empty; option fields can't be cleared, so the current value is kept`);
    if (opts.nulls === "skip") return { ok: false, skip: true, silent: true, code: "NUMBER_EMPTY", message: "" }; // keep Framer's value, no warning
    const e = emptyEntry(field);
    return e ? ok(e) : skip("FIELD_NOT_SETTABLE", `"${field.name}" can't be cleared`);
  }

  switch (type) {
    case "string":
      return ok({ type, value: Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v) });
    case "formattedText":
      return ok({ type, value: String(v), contentType: opts.formattedText });
    case "number": {
      if (typeof v === "number" && Number.isFinite(v)) return ok({ type, value: v });
      const n = Number(String(v).trim());
      if (String(v).trim() !== "" && Number.isFinite(n)) return ok({ type, value: n });
      return fail("NUMBER_INVALID", `"${field.name}": "${v}" isn't a number`, "use digits only, e.g. 4.99 (no currency symbols)");
    }
    case "boolean": {
      if (typeof v === "boolean") return ok({ type, value: v });
      const s = String(v).trim().toLowerCase();
      if (["true", "yes", "1", "y", "on"].includes(s)) return ok({ type, value: true });
      if (["false", "no", "0", "n", "off"].includes(s)) return ok({ type, value: false });
      return fail("BOOLEAN_INVALID", `"${field.name}": "${v}" isn't true or false`, "use true/false, yes/no or 1/0");
    }
    case "date": {
      const d = parseDate(v, opts.dateOrder);
      if (d === "ambiguous") return fail("DATE_AMBIGUOUS", `"${field.name}": "${v}" could be day/month or month/day`, 'set fields.dateOrder: DMY (10/08 = 10 August) or MDY (10/08 = October 8) for this sync');
      if (!d) return fail("DATE_INVALID", `"${field.name}": "${v}" isn't a date`, "use a date like 2026-10-10 or 10/08/2026");
      return ok({ type, value: d.toISOString() });
    }
    case "enum": {
      const raw = Array.isArray(v) ? v[0] : v;
      const cases = field.cases || [];
      const hit = cases.find((c) => c.id === String(raw)) || cases.find((c) => norm(c.name) === norm(raw));
      if (!hit) return fail("ENUM_NO_MATCH", `"${field.name}": "${raw}" isn't an option`, `use one of: ${cases.map((c) => c.name).join(", ") || "(the field has no options)"}`);
      return ok({ type, value: hit.id });
    }
    case "image": case "file": {
      const s = String(v).trim();
      if (!isAbsoluteUrl(s)) return fail("IMAGE_NOT_ABSOLUTE", `"${field.name}": "${s}" isn't a full URL`, "upload the file somewhere public and use its https:// address");
      return ok(type === "image" && opts.alt ? { type, value: s, alt: opts.alt } : { type, value: s });
    }
    case "link": case "color":
      return ok({ type, value: String(v) });
    case "collectionReference":
      return ok({ type, value: String(Array.isArray(v) ? v[0] : v) });
    case "multiCollectionReference": {
      const list = Array.isArray(v) ? v.map(String) : String(v).split(",").map((s) => s.trim()).filter(Boolean);
      return ok({ type, value: list });
    }
    default:
      return skip("FIELD_NOT_SETTABLE", `"${field.name}" has an unknown field type "${type}"`);
  }
}

/** Comparable plain value of an entry (ours or Framer's). undefined = not comparable. */
export const COMPARABLE = new Set(["string", "number", "boolean", "enum", "date", "link", "color", "collectionReference", "multiCollectionReference"]);

export function comparable(entry: { type: string; value: unknown } | undefined): unknown {
  if (!entry) return null;
  const v = entry.value;
  if (v === undefined || v === null) return null;
  if (entry.type === "date") { const d = new Date(v as string); return isNaN(d.getTime()) ? null : d.toISOString(); }
  if (entry.type === "multiCollectionReference") return Array.isArray(v) ? [...v].map(String).sort().join("|") : null;
  if (typeof v === "object") return (v as { id?: unknown }).id ?? JSON.stringify(v);
  return v;
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null || a === "") && (b === null || b === "")) return true;
  if (a === false && b === null) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  return false;
}
