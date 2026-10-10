// Plan: compare mapped items with what's in Framer and decide exactly what to write.
// Apply: carry out a plan. A dry run and a real run share this code, so the preview
// always matches the write.

import { createHash } from "node:crypto";
import type { FramerClient } from "../framer/client.ts";
import type { CollectionInfo, ExistingItem, FieldDef, ItemInput, Mode } from "../types.ts";
import type { SyncConfig } from "../config/schema.ts";
import type { MappedItem } from "./map.ts";
import { COMPARABLE, comparable, sameValue } from "./coerce.ts";
import { issue, SyncError, type Issue } from "./issues.ts";

export type ItemStatus = "create" | "update" | "unchanged" | "unverified" | "skipped";

export interface PlanChange { field: string; from: unknown; to: unknown }
export interface PlanItem {
  slug: string;
  status: ItemStatus;
  /** For skipped items: left alone because it already exists (add-only) or because it's new (update-only). */
  skipped?: "existing" | "new";
  origin: string;
  changes?: PlanChange[];
  write?: ItemInput; // undefined when unchanged
}
export interface PlanRemove { id: string; slug: string }

export interface Plan {
  planId: string;
  sync: string;
  mode: Mode;
  collection: { id: string; name: string };
  source: { from: string; records: number; complete: boolean };
  items: PlanItem[];
  remove: PlanRemove[];
  prune: { enabled: boolean; mode: "delete" | "draft"; blocked?: string };
  createOnly: boolean;
  updateOnly: boolean;
  replace: boolean;
  /** Slugs that are in Framer but not in the data (what "replace all" would remove). Empty for partial data. */
  missing: string[];
  issues: Issue[];
  notCompared: string[];
  /** Internal: what apply needs to remove (ids for managed, node ids for unmanaged). */
  _removeTargets: { id: string; slug: string; nodeId: string }[];
}

export interface PlanInput {
  syncName: string;
  sync: SyncConfig;
  collection: CollectionInfo;
  mode: Mode;
  fields: FieldDef[];
  items: MappedItem[];
  issues: Issue[];
  source: { from: string; records: number; complete: boolean };
  limit?: number;
  only?: string[];
  /** Add new items only; existing items are skipped entirely and nothing is removed. */
  createOnly?: boolean;
  /** Update existing items only; new items are skipped and nothing is removed. */
  updateOnly?: boolean;
  /** Make the collection match the data: also remove items whose slug isn't in it (needs complete data). */
  replace?: boolean;
}

const storedUrl = (e: { value: unknown } | undefined): string | null => {
  const v = e?.value as { url?: string } | string | null | undefined;
  if (v == null || v === "") return null;
  return typeof v === "object" ? v.url ?? null : String(v);
};
const isFramerAsset = (u: string) => /^https:\/\/framerusercontent\.com\//.test(u);
/**
 * Rich text compared by content, not formatting: Framer adds dir="auto" and data-preset-tag, strips inline
 * styles, and stores empty text as <p><br class="trailing-break"></p>. Tags, text, links and images count;
 * other attributes and whitespace don't.
 */
export const normalizeHtml = (h: string) => {
  let s = h
    .replace(/<br[^>]*class="trailing-break"[^>]*>/g, "")
    .replace(/<([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)\s*(\/?)>/g, (_m, tag: string, attrs: string, self: string) => {
      // Only content attributes, non-empty, in a fixed order (so <img alt="" src> = <img src alt="">).
      const keep = [...(attrs ?? "").matchAll(/\s(href|src|alt)="([^"]*)"/g)].filter((m) => m[2] !== "").map((m) => ` ${m[1]}="${m[2]}"`).sort().join("");
      return `<${tag.toLowerCase()}${keep}${self ? "/" : ""}>`;
    })
    // The same characters written differently: &nbsp; vs a space, &quot; vs ", &#39; vs '.
    .replace(/&nbsp;|&#160;|\u00a0/g, " ").replace(/&quot;|&#34;/g, '"').replace(/&#39;|&apos;|&#x27;/g, "'")
    // Whitespace next to tags doesn't change the content.
    .replace(/\s+/g, " ").replace(/>\s+/g, ">").replace(/\s+</g, "<").trim()
    // Two line breaks in a row read as a paragraph break.
    .replace(/(?:<br\/?>){2,}/g, "</p><p>").replace(/<br\/?><\/p>/g, "</p>")
    // An image on its own, with or without a paragraph around it.
    .replace(/<p>(<img[^>]*>)<\/p>/g, "$1");
  if (/^(<p><\/p>)*$/.test(s)) return "";
  if (s && !s.startsWith("<")) s = `<p>${s}</p>`;
  return s;
};
const sameHtml = (a: string, b: string) => normalizeHtml(a) === normalizeHtml(b);
const textSnippet = (h: string) => { const t = h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); return t.length > 50 ? t.slice(0, 50) + "…" : t || "(empty)"; };

const fieldName = (fields: FieldDef[], id: string) => fields.find((f) => f.id === id)?.name ?? id;

export async function buildPlan(client: FramerClient, input: PlanInput): Promise<Plan> {
  const { sync, collection, mode, fields } = input;
  const issues = [...input.issues];
  const existing = await client.getItems(collection.id);

  const bySlug = new Map<string, ExistingItem>();
  const dupSlugs = new Set<string>();
  for (const it of existing) { if (bySlug.has(it.slug)) dupSlugs.add(it.slug); bySlug.set(it.slug, it); }
  if (mode === "unmanaged" && dupSlugs.size)
    issues.push(issue("error", "DUPLICATE_SLUG_IN_COLLECTION", `the Framer collection has items sharing a slug: ${[...dupSlugs].slice(0, 5).join(", ")}`, { fix: "give each item in Framer a unique slug" }));
  const managedIds = mode === "managed" ? new Set(await client.getManagedItemIds(collection.id)) : null;

  let items = input.items;
  if (input.only?.length) {
    const want = new Set(input.only);
    items = items.filter((i) => want.has(i.slug) || want.has(i.id));
  }
  if (input.limit && input.limit > 0) items = items.slice(0, input.limit);

  // Everything is matched by slug, as in Framer. For managed collections the existing item with that
  // slug supplies the id to update; a new slug gets a new id (made unique if it's already taken).
  const managedIdFor = (it: MappedItem): string | null => {
    if (!managedIds) return null;
    const ex = bySlug.get(it.slug);
    return ex && managedIds.has(ex.id) ? ex.id : null;
  };
  const newManagedId = (it: MappedItem): string => {
    if (!managedIds?.has(it.id)) return it.id;
    return `${it.id.slice(0, 55).replace(/-+$/, "")}-${createHash("sha1").update(`${it.slug}#new`).digest("hex").slice(0, 8)}`;
  };
  const notCompared = new Set<string>();
  const pruneCfgDraft = !!sync.prune && sync.prune.mode === "draft";
  const planItems: PlanItem[] = items.map((it) => {
    const ex = bySlug.get(it.slug);
    const managedId = managedIdFor(it);
    const exists = mode === "managed" ? !!managedId : !!ex;
    if (exists && input.createOnly) return { slug: it.slug, status: "skipped", skipped: "existing", origin: it.origin };
    if (!exists && input.updateOnly) return { slug: it.slug, status: "skipped", skipped: "new", origin: it.origin };
    if (!exists) {
      return { slug: it.slug, status: "create", origin: it.origin, write: { ...(mode === "managed" ? { id: newManagedId(it) } : {}), slug: it.slug, ...(it.draft !== undefined ? { draft: it.draft } : {}), fieldData: it.fieldData } };
    }
    // Draft status: if the source doesn't say, keep what's in Framer (so drafts set by hand
    // survive a sync), except that items drafted by `prune.mode: draft` come back when they
    // return to the data. Framer treats a missing draft as "published", so always send it.
    const draft = it.draft !== undefined ? it.draft : ex ? (pruneCfgDraft ? false : ex.draft) : undefined;
    const changes: PlanChange[] = [];
    let uncomparable = false;
    for (const [fid, entry] of Object.entries(it.fieldData)) {
      // Images: equal when the URL is the one Framer already has. Framer re-hosts outside images under
      // its own address, so a different outside URL can't be judged and the item is rewritten.
      if (entry.type === "image" || entry.type === "file") {
        const now = storedUrl(ex?.fieldData?.[fid]);
        const want = entry.value == null || entry.value === "" ? null : String(entry.value);
        if (now === want) continue;
        if (want === null || now === null || isFramerAsset(want)) { changes.push({ field: fieldName(fields, fid), from: now, to: want }); continue; }
        uncomparable = true; notCompared.add(entry.type); continue;
      }
      // Rich text: Framer adds formatting such as dir="auto" when storing; compare without it.
      if (entry.type === "formattedText") {
        const now = String(ex?.fieldData?.[fid]?.value ?? ""), want = String(entry.value ?? "");
        if (sameHtml(now, want)) continue;
        changes.push({ field: fieldName(fields, fid), from: textSnippet(now), to: textSnippet(want) });
        continue;
      }
      if (!COMPARABLE.has(entry.type)) { uncomparable = true; notCompared.add(entry.type); continue; }
      let a = comparable(ex?.fieldData?.[fid]);
      let b = comparable(entry);
      // Option fields: Framer may report an option by name or by id; compare (and show) by name.
      const def = fields.find((f) => f.id === fid);
      if (def?.type === "enum") {
        const name = (v: unknown) => def.cases?.find((c) => c.id === v || c.name === v)?.name ?? v;
        a = name(a); b = name(b);
      }
      if (!sameValue(a, b)) changes.push({ field: fieldName(fields, fid), from: a, to: b });
    }
    if (ex && draft !== undefined && ex.draft !== draft) changes.push({ field: "(draft)", from: ex.draft, to: draft });
    const status: ItemStatus = changes.length ? "update" : uncomparable ? "unverified" : "unchanged";
    const write: ItemInput | undefined = status === "unchanged" ? undefined : {
      ...(mode === "managed" ? { id: managedId! } : { id: ex!.nodeId }),
      slug: it.slug, ...(draft !== undefined ? { draft } : {}), fieldData: it.fieldData,
    };
    return { slug: it.slug, status, origin: it.origin, ...(changes.length ? { changes } : {}), write };
  });

  // Items in Framer whose slug isn't in the data. Only meaningful when the data is the whole set.
  const wholeSet = input.source.complete && !input.limit && !input.only?.length;
  const dataSlugs = new Set(input.items.map((i) => i.slug));
  const missingItems = wholeSet ? existing.filter((e) => !dataSlugs.has(e.slug)) : [];

  // Removing: when the sync has `prune` on, or for a "replace all" run.
  const pruneCfg = sync.prune;
  const removal = input.replace ? { minItems: pruneCfg ? pruneCfg.minItems : 1, maxRemove: pruneCfg ? pruneCfg.maxRemove : "20%", mode: pruneCfg ? pruneCfg.mode : "delete" as const } : pruneCfg || null;
  const prune: Plan["prune"] = { enabled: false, mode: removal ? removal.mode : "delete" };
  let removeTargets: Plan["_removeTargets"] = [];
  if (removal) {
    if (input.createOnly) prune.blocked = "add-only run: existing items are left alone, nothing is removed";
    else if (input.updateOnly) prune.blocked = "update-only run: nothing is added or removed";
    else if (!input.source.complete) prune.blocked = input.replace ? "partial data can't replace the collection (a single post or data sent in); nothing is removed" : "partial data (a single post, data sent in, or --partial), so nothing is removed";
    else if (input.limit || input.only?.length) prune.blocked = "--limit / --only was used, so nothing is removed";
    else if (input.source.records < removal.minItems) prune.blocked = `the source has ${input.source.records} records, fewer than prune.minItems (${removal.minItems}), so nothing is removed`;
    else {
      prune.enabled = true;
      removeTargets = missingItems
        .filter((e) => mode !== "managed" || managedIds!.has(e.id))
        .map((e) => ({ id: e.id, slug: e.slug, nodeId: e.nodeId }));
      if (prune.mode === "draft") removeTargets = removeTargets.filter((t) => !bySlug.get(t.slug)?.draft);
      const max = typeof removal.maxRemove === "number" ? removal.maxRemove : Math.floor((parseFloat(removal.maxRemove) / 100) * existing.length);
      if (removeTargets.length > max) {
        issues.push(issue("error", "PRUNE_GUARD",
          `this would remove ${removeTargets.length} of ${existing.length} items, more than the limit (${removal.maxRemove})`,
          { fix: "check the data is complete; if the removal is intended, confirm it (--allow-mass-remove)" }));
      }
    }
  }
  if (input.replace && prune.blocked) issues.push(issue("error", "PRUNE_GUARD", prune.blocked, { fix: "use the whole data set (the sync's source, a full file or folder) to replace" }));
  // Otherwise only warn when removal was skipped for a reason the person didn't choose (too few records).
  else if (prune.blocked && pruneCfg && prune.blocked.includes("minItems")) issues.push(issue("warning", "PRUNE_GUARD", prune.blocked));

  const plan: Omit<Plan, "planId"> = {
    sync: input.syncName, mode, collection: { id: collection.id, name: collection.name }, source: input.source,
    items: planItems, remove: removeTargets.map(({ id, slug }) => ({ id, slug })), prune,
    createOnly: !!input.createOnly, updateOnly: !!input.updateOnly, replace: !!input.replace, missing: missingItems.map((e) => e.slug), issues,
    notCompared: [...notCompared], _removeTargets: removeTargets,
  };
  return { planId: planIdOf(plan), ...plan };
}

export function planIdOf(plan: Omit<Plan, "planId">): string {
  const h = createHash("sha256");
  h.update(JSON.stringify([plan.sync, plan.collection.id, plan.mode, plan.prune.mode, plan.createOnly, plan.updateOnly, plan.replace, plan.source.complete,
    plan.items.map((i) => [i.slug, i.status, i.write ?? null]), plan._removeTargets.map((r) => r.id)]));
  return h.digest("hex").slice(0, 16);
}

export interface ApplyResult { upserted: number; removed: number; drafted: number; chunks: { done: number; total: number } }

export async function executePlan(client: FramerClient, plan: Plan, opts: { chunkSize: number; allowMassRemove?: boolean }): Promise<ApplyResult> {
  const errors = plan.issues.filter((i) => i.level === "error" && !(i.code === "PRUNE_GUARD" && opts.allowMassRemove));
  if (errors.length) throw new SyncError("VALIDATION_FAILED", `${errors.length} problem${errors.length === 1 ? "" : "s"} must be fixed first; nothing was written`, { details: errors });

  const writes = plan.items.map((i) => i.write).filter((w): w is ItemInput => !!w);
  const draftWrites: ItemInput[] = plan.prune.enabled && plan.prune.mode === "draft"
    ? plan._removeTargets.map((t) => ({ id: plan.mode === "managed" ? t.id : t.nodeId, slug: t.slug, draft: true, fieldData: {} }))
    : [];
  const all = [...writes, ...draftWrites];
  const chunks: ItemInput[][] = [];
  for (let i = 0; i < all.length; i += opts.chunkSize) chunks.push(all.slice(i, i + opts.chunkSize));
  const removing = plan.prune.enabled && plan.prune.mode === "delete" && plan._removeTargets.length > 0;
  const total = chunks.length + (removing ? 1 : 0);
  let done = 0, upserted = 0;
  try {
    for (const chunk of chunks) {
      if (plan.mode === "managed") await client.upsertManaged(plan.collection.id, chunk);
      else await client.writeUnmanaged(plan.collection.id, chunk);
      done++; upserted += chunk.length;
    }
    if (removing) {
      if (plan.mode === "managed") await client.removeManaged(plan.collection.id, plan._removeTargets.map((t) => t.id));
      else await client.removeUnmanaged(plan.collection.id, plan._removeTargets.map((t) => t.nodeId));
      done++;
    }
  } catch (e) {
    if (done === 0) throw e;
    throw new SyncError("APPLY_PARTIAL", `stopped after ${done} of ${total} steps: ${(e as Error).message}`,
      { fix: "fix the cause and apply again; writes are upserts, so re-running is safe", details: { stepsDone: done, stepsTotal: total, itemsWritten: Math.min(upserted, writes.length) } });
  }
  return {
    upserted: Math.min(upserted, writes.length),
    removed: removing ? plan._removeTargets.length : 0,
    drafted: draftWrites.length,
    chunks: { done, total },
  };
}
