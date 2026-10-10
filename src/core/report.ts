// The one report shape every interface returns (library, CLI --json, HTTP, MCP).

import type { Issue } from "./issues.ts";
import type { ApplyResult, Plan, PlanChange } from "./plan.ts";
import type { Mode, PublishInfo } from "../types.ts";

export interface SyncReport {
  ok: boolean;
  operation: "plan" | "apply";
  sync: string;
  mode: Mode;
  collection: { id: string; name: string };
  planId: string;
  source: { from: string; records: number; complete: boolean };
  items: {
    total: number;
    create: string[];
    update: { slug: string; changes: PlanChange[] }[];
    unverified: string[];
    unchanged: number;
    remove: string[];
    /** Existing items left alone in an add-only run. */
    skipped: string[];
    /** New items left out of an update-only run. */
    skippedNew: string[];
    /** In Framer but not in the data: what "replace all" would remove. */
    missing: string[];
    notCompared: string[];
  };
  /** What kind of run this is, in plain words. */
  run: { complete: boolean; createOnly: boolean; updateOnly: boolean; replace: boolean; removes: boolean; description: string };
  prune: Plan["prune"];
  issues: { errors: Issue[]; warnings: Issue[] };
  applied: ApplyResult | null;
  publish: (PublishInfo & { note: string }) | null;
  durationMs: number;
  truncated?: boolean;
}

export const PUBLISH_NOTE = "publishing ships your whole site as it is now, not just this collection";

export function toReport(plan: Plan, extra: { operation: "plan" | "apply"; applied?: ApplyResult | null; publish?: PublishInfo | null; startedAt: number; full?: boolean }): SyncReport {
  const cap = extra.full ? Infinity : 100;
  const by = (s: string) => plan.items.filter((i) => i.status === s);
  const create = by("create").map((i) => i.slug);
  const update = by("update").map((i) => ({ slug: i.slug, changes: (i.changes ?? []).slice(0, extra.full ? undefined : 10) }));
  const unverified = by("unverified").map((i) => i.slug);
  const remove = plan.remove.map((r) => r.slug);
  const skipped = plan.items.filter((i) => i.skipped === "existing").map((i) => i.slug);
  const skippedNew = plan.items.filter((i) => i.skipped === "new").map((i) => i.slug);
  const { createOnly, updateOnly, replace } = plan;
  const removes = plan.prune.enabled;
  const description = createOnly ? "only add new: existing items are left alone, nothing removed"
    : updateOnly ? "only update existing: new items are left out, nothing removed"
    : replace ? "replace all: adds, updates, and removes items that aren't in your data"
    : !plan.source.complete ? "partial data: adds and updates, never removes"
    : removes ? "complete data: adds, updates, and removes items missing from it"
    : "adds new and updates changed; nothing is removed";
  const errors = plan.issues.filter((i) => i.level === "error");
  const warnings = plan.issues.filter((i) => i.level === "warning");
  const truncated = [create, update, unverified, remove, errors, warnings].some((l) => l.length > cap);
  return {
    ok: errors.length === 0 || (extra.operation === "apply" && !!extra.applied),
    operation: extra.operation,
    sync: plan.sync,
    mode: plan.mode,
    collection: plan.collection,
    planId: plan.planId,
    source: plan.source,
    items: {
      total: plan.items.length,
      create: create.slice(0, cap),
      update: update.slice(0, cap),
      unverified: unverified.slice(0, cap),
      unchanged: by("unchanged").length,
      remove: remove.slice(0, cap),
      skipped: skipped.slice(0, cap),
      skippedNew: skippedNew.slice(0, cap),
      missing: plan.missing.slice(0, cap),
      notCompared: plan.notCompared,
    },
    run: { complete: plan.source.complete, createOnly, updateOnly, replace, removes, description },
    prune: plan.prune,
    issues: { errors: errors.slice(0, cap), warnings: warnings.slice(0, cap) },
    applied: extra.applied ?? null,
    publish: extra.publish ? { ...extra.publish, note: PUBLISH_NOTE } : null,
    durationMs: Date.now() - extra.startedAt,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Counts that decide `publish: on-change`. */
export const changedCount = (r: ApplyResult | null | undefined, plan: Plan) =>
  r ? plan.items.filter((i) => i.status === "create" || i.status === "update").length + r.removed + r.drafted : 0;
