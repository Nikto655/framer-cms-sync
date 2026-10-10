// Dates in spreadsheets: ISO (2026-08-10), or day/month/year vs month/day/year (10/08/2026),
// which can't be told apart when both numbers are 12 or less. Never guess silently.

export type DateOrder = "DMY" | "MDY";

const SLASH = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/;

export const isSlashDate = (v: unknown) => typeof v === "string" && SLASH.test(v);

/** Which order a set of slash dates must be in, if the values settle it (a part above 12). */
export function detectOrder(values: unknown[]): DateOrder | "ambiguous" | null {
  let dmy = false, mdy = false, any = false;
  for (const v of values) {
    const m = typeof v === "string" ? v.match(SLASH) : null;
    if (!m) continue;
    any = true;
    if (Number(m[1]) > 12) dmy = true;
    if (Number(m[2]) > 12) mdy = true;
  }
  if (!any) return null;
  if (dmy && !mdy) return "DMY";
  if (mdy && !dmy) return "MDY";
  return "ambiguous";
}

/** Parse a date. Returns null when unparseable; "ambiguous" for a slash date with no order given. */
export function parseDate(v: unknown, order?: DateOrder): Date | null | "ambiguous" {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") { const d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  const s = String(v).trim();
  const m = s.match(SLASH);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    let o = order;
    if (!o) o = a > 12 ? "DMY" : b > 12 ? "MDY" : undefined;
    if (!o) return a === b ? new Date(Date.UTC(y, a - 1, b)) : "ambiguous";
    const [day, month] = o === "DMY" ? [a, b] : [b, a];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const d = new Date(Date.UTC(y, month - 1, day, Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
