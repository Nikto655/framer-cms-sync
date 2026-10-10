// Bulk redirects (Framer Site Settings > Redirects): parse, plan, apply, remove.

import { parse as parseCsv } from "csv-parse/sync";
import type { FramerClient } from "../framer/client.ts";
import type { RedirectInfo, RedirectWrite } from "../types.ts";
import { issue, SyncError, type Issue } from "../core/issues.ts";

export interface RedirectRow { from: string; to: string }

/** Full URLs or paths -> "/path" without a trailing slash. */
export const toPath = (v: unknown): string => {
  let s = String(v ?? "").trim().replace(/^"|"$/g, "").trim();
  if (!s) return "";
  s = s.replace(/^https?:\/\/[^/]+/i, "");
  if (!s.startsWith("/")) s = "/" + s;
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
};

export function parseRedirects(input: unknown): RedirectRow[] {
  let rows: unknown[];
  if (typeof input === "string") {
    const t = input.trim();
    if (!t) return [];
    if (t.startsWith("[") || t.startsWith("{")) {
      let b: unknown;
      try { b = JSON.parse(t); } catch (e) { throw new SyncError("INPUT_INVALID", `invalid JSON: ${(e as Error).message}`); }
      rows = Array.isArray(b) ? b : ((b as { redirects?: unknown[] }).redirects ?? []);
    } else {
      let parsed: Record<string, string>[];
      try { parsed = parseCsv(t, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase().replace(/[_ ]?url$/, "")), bom: true, skip_empty_lines: true, trim: true, relax_column_count: true }); }
      catch (e) { throw new SyncError("INPUT_INVALID", `CSV couldn't be parsed: ${(e as Error).message}`); }
      if (parsed.length && (!("from" in parsed[0]) || !("to" in parsed[0])))
        throw new SyncError("INPUT_INVALID", 'the CSV needs a header row with "from" and "to" columns', { fix: "first line: from,to" });
      rows = parsed;
    }
  } else rows = Array.isArray(input) ? input : ((input as { redirects?: unknown[] })?.redirects ?? []);
  if (!Array.isArray(rows)) throw new SyncError("INPUT_INVALID", "send CSV (from,to), a JSON array [{from,to}], or {redirects:[...]}");
  return rows.map((r) => ({ from: toPath((r as RedirectRow).from), to: toPath((r as RedirectRow).to) }));
}

export interface RedirectPlan {
  existing: number;
  add: RedirectRow[];
  update: { id: string; from: string; to: string; was: string | null }[];
  unchanged: string[];
  issues: Issue[];
}

export function planRedirects(wanted: RedirectRow[], existing: RedirectInfo[], opts: { livePaths?: Set<string>; protectedPrefixes?: string[]; allowChains: boolean }): RedirectPlan {
  const byFrom = new Map(existing.map((r) => [toPath(r.from), r]));
  const wantedFrom = new Set(wanted.map((w) => w.from));
  const plan: RedirectPlan = { existing: existing.length, add: [], update: [], unchanged: [], issues: [] };
  const seen = new Set<string>();
  for (const w of wanted) {
    if (!w.from || !w.to) { plan.issues.push(issue("error", "LINT", `missing from or to: ${JSON.stringify(w)}`, { fix: "every row needs both from and to" })); continue; }
    if (w.from === w.to) { plan.issues.push(issue("error", "LINT", `${w.from} redirects to itself`)); continue; }
    if (seen.has(w.from)) { plan.issues.push(issue("error", "LINT", `${w.from} appears twice`, { fix: "keep one row per from" })); continue; }
    seen.add(w.from);
    if (opts.livePaths?.has(w.from)) { plan.issues.push(issue("error", "LINT", `${w.from} is a live page; a redirect would hide it`, { fix: "remove or unpublish the page first, or drop this row" })); continue; }
    const target = wantedFrom.has(w.to) || byFrom.has(w.to);
    if (target) plan.issues.push(issue(opts.allowChains ? "warning" : "error", "LINT", `chain: ${w.from} -> ${w.to} -> …`, { fix: `point ${w.from} straight at the final page` }));
    if (opts.livePaths && opts.protectedPrefixes?.some((p) => w.to.startsWith(p)) && !opts.livePaths.has(w.to))
      plan.issues.push(issue("warning", "LINT", `target isn't a live page: ${w.to}`));
    const ex = byFrom.get(w.from);
    if (!ex) plan.add.push(w);
    else if (toPath(ex.to) !== w.to) plan.update.push({ id: ex.id, from: w.from, to: w.to, was: ex.to });
    else plan.unchanged.push(w.from);
  }
  return plan;
}

export async function applyRedirectPlan(client: FramerClient, plan: RedirectPlan) {
  const errors = plan.issues.filter((i) => i.level === "error");
  if (errors.length) throw new SyncError("VALIDATION_FAILED", `${errors.length} redirect problem(s) must be fixed first; nothing was written`, { details: errors });
  const inputs: RedirectWrite[] = [
    ...plan.add.map((r) => ({ from: r.from, to: r.to, expandToAllLocales: false })),
    ...plan.update.map((r) => ({ id: r.id, to: r.to })),
  ];
  for (let i = 0; i < inputs.length; i += 50) await client.addRedirects(inputs.slice(i, i + 50));
  return { added: plan.add.length, updated: plan.update.length };
}
