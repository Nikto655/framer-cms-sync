import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, rows, PRICING_FIELDS, BLOG_FIELDS, write } from "./helpers.ts";
import { SyncError } from "../src/core/issues.ts";

const pricingSync = (extra: Record<string, unknown> = {}) => ({
  collection: { name: "Pricing" }, source: { type: "json" }, key: { field: "Title" }, ...extra,
});

test("managed: plan shows creates, apply writes, second plan is unchanged", async () => {
  const { sync, mem } = setup({ collections: [{ id: "p", name: "Pricing", ownership: "this", fields: PRICING_FIELDS }], syncs: { pricing: pricingSync() } });
  const plan = await sync.plan("pricing", { records: rows(3) });
  assert.equal(plan.mode, "managed");
  assert.deepEqual(plan.items.create, ["plan-1", "plan-2", "plan-3"]);
  assert.equal(mem.state.log.length, 0, "plan writes nothing");
  const applied = await sync.apply("pricing", { records: rows(3) });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied?.upserted, 3);
  const again = await sync.plan("pricing", { records: rows(3) });
  assert.equal(again.items.unchanged, 3);
  assert.equal(again.items.create.length, 0);
});

test("managed: updates show old -> new values", async () => {
  const { sync } = setup({ collections: [{ id: "p", name: "Pricing", ownership: "this", fields: PRICING_FIELDS }], syncs: { pricing: pricingSync() } });
  await sync.apply("pricing", { records: rows(2) });
  const plan = await sync.plan("pricing", { records: rows(2, (i) => ({ Title: `Plan ${i}`, "Price ($)": i === 2 ? 99 : i })) });
  assert.equal(plan.items.update.length, 1);
  assert.deepEqual(plan.items.update[0], { slug: "plan-2", changes: [{ field: "Price ($)", from: 2, to: 99 }] });
});

test("validation errors block the whole apply and nothing is written", async () => {
  const { sync, mem } = setup({ collections: [{ id: "p", name: "Pricing", ownership: "this", fields: PRICING_FIELDS }], syncs: { pricing: pricingSync() } });
  const r = await sync.apply("pricing", { records: [{ Title: "A", "Price ($)": 1 }, { Title: "B", "Price ($)": "lots" }] });
  assert.equal(r.ok, false);
  assert.equal(r.applied, null);
  assert.equal(r.issues.errors[0].code, "NUMBER_INVALID");
  assert.ok(r.issues.errors[0].fix);
  assert.equal(mem.state.log.length, 0);
});

test("prune: removes stale items on a complete run, respects minItems and maxRemove", async () => {
  const { sync, mem } = setup({
    collections: [{ id: "p", name: "Pricing", ownership: "this", fields: PRICING_FIELDS }],
    syncs: { pricing: pricingSync({ prune: { minItems: 3, maxRemove: "50%" } }) },
  });
  await sync.apply("pricing", { records: rows(10) });
  const one = await sync.plan("pricing", { records: rows(9) });
  assert.deepEqual(one.items.remove, ["plan-10"]);
  // too few records: prune skipped with a warning
  const few = await sync.plan("pricing", { records: rows(2) });
  assert.equal(few.prune.enabled, false);
  assert.match(few.prune.blocked!, /minItems/);
  // a big drop trips maxRemove and blocks the apply
  const drop = await sync.apply("pricing", { records: rows(4) });
  assert.equal(drop.ok, false);
  assert.equal(drop.issues.errors[0].code, "PRUNE_GUARD");
  assert.equal([...mem.state.collections.get("p")!.items.values()].length, 10);
  // ...unless explicitly allowed
  const forced = await sync.apply("pricing", { records: rows(4) }, { allowMassRemove: true });
  assert.equal(forced.applied?.removed, 6);
  // --limit never prunes
  const limited = await sync.plan("pricing", { records: rows(3) }, { limit: 1 });
  assert.equal(limited.items.remove.length, 0);
});

test("unmanaged: creates without ids, updates by Framer node id, prunes by slug", async () => {
  const { sync, mem } = setup({
    collections: [{ id: "u", name: "Pricing", ownership: "user", fields: PRICING_FIELDS, items: [
      { id: "n1", nodeId: "n1", slug: "plan-1", draft: false, fieldData: { title: { type: "string", value: "Plan 1" }, price_usd: { type: "number", value: 1 } } },
      { id: "n9", nodeId: "n9", slug: "old-plan", draft: false, fieldData: {} },
    ] }],
    syncs: { pricing: pricingSync({ prune: { minItems: 1, maxRemove: 5 } }) },
  });
  const r = await sync.apply("pricing", { records: rows(2, (i) => ({ Title: `Plan ${i}`, "Price ($)": i * 10 })) });
  assert.equal(r.mode, "unmanaged");
  assert.deepEqual(r.items.create, ["plan-2"]);
  assert.equal(r.items.update[0].slug, "plan-1");
  assert.deepEqual(r.items.remove, ["old-plan"]);
  const items = [...mem.state.collections.get("u")!.items.values()];
  assert.equal(items.find((i) => i.slug === "plan-1")!.nodeId, "n1", "updated in place");
  assert.equal(items.find((i) => i.slug === "plan-1")!.fieldData.price_usd.value, 10);
  assert.ok(!items.some((i) => i.slug === "old-plan"));
});

test("collections owned by another plugin are refused with a fix", async () => {
  const { sync } = setup({ collections: [{ id: "o", name: "Pricing", ownership: "other", fields: PRICING_FIELDS }], syncs: { pricing: pricingSync() } });
  await assert.rejects(sync.plan("pricing", { records: rows(1) }), (e: SyncError) => e.code === "COLLECTION_FOREIGN_PLUGIN" && !!e.fix?.includes("setup"));
});

test("setup creates a managed copy with the source's fields; refuses to overwrite without force", async () => {
  const { sync, mem } = setup({
    collections: [{ id: "o", name: "Data Plans", ownership: "other", fields: PRICING_FIELDS }],
    syncs: { pricing: pricingSync({ collection: { name: "Data Plans Synced", create: true }, schemaFrom: "Data Plans" }) },
  });
  const r = await sync.setup("pricing");
  assert.equal(r.created, true);
  assert.equal(r.fieldCount, 5);
  const created = [...mem.state.collections.values()].find((c) => c.info.name === "Data Plans Synced")!;
  assert.deepEqual(created.fields.map((f) => f.id), ["title", "price_usd", "tier", "flag", "active"]);
  const again = await sync.setup("pricing");
  assert.equal(again.unchanged, true);
});

test("planId: apply refuses a stale plan and requires one when asked", async () => {
  const { sync } = setup({ collections: [{ id: "p", name: "Pricing", ownership: "this", fields: PRICING_FIELDS }], syncs: { pricing: pricingSync() } });
  const plan = await sync.plan("pricing", { records: rows(2) });
  await assert.rejects(sync.apply("pricing", { records: rows(3) }, { planId: plan.planId }), (e: SyncError) => e.code === "PLAN_STALE");
  await assert.rejects(sync.apply("pricing", { records: rows(2) }, { requirePlanId: true }), (e: SyncError) => e.code === "PLAN_REQUIRED");
  const ok = await sync.apply("pricing", { records: rows(2) }, { planId: plan.planId });
  assert.equal(ok.applied?.upserted, 2);
});

test("publish: never by default, always when asked, on-change only when something changed", async () => {
  const { sync, mem } = setup({ collections: [{ id: "p", name: "Pricing", ownership: "this", fields: PRICING_FIELDS }], syncs: { pricing: pricingSync() } });
  await sync.apply("pricing", { records: rows(2) });
  assert.equal(mem.state.published.length, 0);
  const r = await sync.apply("pricing", { records: rows(2) }, { publish: "on-change" });
  assert.equal(r.publish, null, "nothing changed, so no publish");
  const r2 = await sync.apply("pricing", { records: rows(3) }, { publish: "on-change" });
  assert.equal(r2.publish?.deployed, true);
  assert.match(r2.publish!.note, /whole site/);
  await sync.apply("pricing", { records: rows(3) }, { publish: true });
  assert.equal(mem.state.published.length, 2);
});

test("writes are serialised through one queue", async () => {
  const { sync, mem } = setup({ collections: [{ id: "p", name: "Pricing", ownership: "this", fields: PRICING_FIELDS }], syncs: { pricing: pricingSync() } });
  await Promise.all([sync.apply("pricing", { records: rows(5) }), sync.apply("pricing", { records: rows(6) }), sync.publish()]);
  assert.equal(mem.state.overlap, false);
});

test("chunked writes report partial progress on failure", async () => {
  const { sync, mem, config } = setup({ collections: [{ id: "p", name: "Pricing", ownership: "this", fields: PRICING_FIELDS }], syncs: { pricing: pricingSync() } });
  config.defaults.chunkSize = 2;
  mem.state.failNextWrite = 2;
  await assert.rejects(sync.apply("pricing", { records: rows(5) }), (e: SyncError) => e.code === "APPLY_PARTIAL" && (e.details as { stepsDone: number }).stepsDone === 1);
});

test("markdown: folder sync, lint errors, remove with redirect", async () => {
  const { sync, mem, dir } = setup({
    collections: [{ id: "b", name: "Blog", ownership: "this", fields: BLOG_FIELDS }],
    syncs: { blog: { collection: { name: "Blog" }, source: { type: "markdown", path: "./posts" }, path: "/blog/", lint: { "max-length": { level: "warn", meta_description: 20 } } } },
  });
  write(dir, "posts/hello-world.md", "---\ntitle: Hello\ndate: 2026-10-01\nmeta_description: A much longer description than twenty\n---\n# Hello\n\nBody text.\n");
  write(dir, "posts/second.md", "---\ntitle: Second\ndate: 2026-10-02\n---\nSee [[Hello]].\n");
  const p = await sync.plan("blog");
  assert.equal(p.source.complete, true);
  assert.ok(p.issues.errors.some((i) => i.rule === "no-wikilinks"));
  assert.ok(p.issues.warnings.some((i) => i.rule === "max-length"));
  write(dir, "posts/second.md", "---\ntitle: Second\ndate: 2026-10-02\n---\nSee the first post.\n");
  const a = await sync.apply("blog");
  assert.equal(a.applied?.upserted, 2);
  const stored = [...mem.state.collections.get("b")!.items.values()].find((i) => i.slug === "hello-world")!;
  assert.equal(stored.fieldData.body.value, "<p>Body text.</p>", "leading H1 removed, Markdown rendered");
  const r = await sync.remove("blog", "second", { redirectTo: "hello-world" });
  assert.deepEqual(r.redirect, { from: "/blog/second", to: "/blog/hello-world" });
  assert.equal(mem.state.redirects.length, 1);
});

test("markdown: a single post never prunes", async () => {
  const { sync } = setup({
    collections: [{ id: "b", name: "Blog", ownership: "this", fields: BLOG_FIELDS }],
    syncs: { blog: { collection: { name: "Blog" }, source: { type: "markdown" }, prune: { minItems: 1, maxRemove: 100 } } },
  });
  await sync.apply("blog", { records: { posts: [{ slug: "a", markdown: "---\ntitle: A\n---\nA" }, { slug: "b", markdown: "---\ntitle: B\n---\nB" }] } });
  const p = await sync.plan("blog", { text: "---\ntitle: C\nslug: c\n---\nC" });
  assert.equal(p.items.remove.length, 0);
  assert.match(p.prune.blocked!, /partial/);
});

test("redirects: plan catches live pages and chains; apply writes", async () => {
  const { sync, mem } = setup({
    collections: [{ id: "b", name: "Blog", ownership: "this", fields: BLOG_FIELDS }],
    syncs: { blog: { collection: { name: "Blog" }, source: { type: "markdown" }, path: "/blog/" } },
  });
  await sync.apply("blog", { text: "---\ntitle: Live\nslug: live\n---\nHi" });
  const csv = 'from,to\n/blog/live,/blog/x\n"https://example.com/old,page",/blog/live\n/a,/b\n/b,/blog/live\n';
  const plan = await sync.redirects.plan(csv);
  const msgs = plan.issues.map((i) => i.message).join("\n");
  assert.match(msgs, /\/blog\/live is a live page/);
  assert.match(msgs, /chain: \/a -> \/b/);
  assert.ok(plan.add.some((r) => r.from === "/old,page"), "quoted comma parsed correctly");
  const bad = await sync.redirects.apply(csv);
  assert.equal(bad.ok, false);
  const good = await sync.redirects.apply("from,to\n/old,/blog/live\n");
  assert.equal(good.ok, true);
  assert.equal(mem.state.redirects.length, 1);
});

test("setup: creates a new managed collection with fields worked out from the data", async () => {
  const { sync, mem, dir } = setup({ collections: [], syncs: { plans: { collection: { name: "Plans", create: true }, source: { type: "csv", path: "./plans.csv" }, key: { field: "Name" } } } });
  write(dir, "plans.csv", "Name,Price,Active,Launched,Logo,Site\nPro,21,yes,2026-01-01,https://x.com/a.png,https://x.com\nTeam,55,no,2026-02-01,https://x.com/b.png,https://y.com\n");
  const r = await sync.setup("plans");
  assert.equal(r.created, true);
  assert.equal(r.mode, "managed");
  assert.deepEqual(r.fields!.map((f) => `${f.name}:${f.type}`), ["Name:string", "Price:number", "Active:boolean", "Launched:date", "Logo:image", "Site:link"]);
  const applied = await sync.apply("plans");
  assert.equal(applied.mode, "managed");
  assert.equal(applied.applied?.upserted, 2);
  assert.equal([...mem.state.collections.values()][0].items.size, 2);
});

test("setup: creates a regular (unmanaged) collection; Framer assigns field ids and the sync still matches by name", async () => {
  const { sync, mem, dir } = setup({ collections: [], syncs: { blog: { collection: { name: "Posts", create: true, mode: "unmanaged" }, source: { type: "markdown", path: "./posts" } } } });
  write(dir, "posts/a.md", "---\ntitle: A\ndate: 2026-10-01\nthumbnail: https://x.com/a.jpg\n---\nHello");
  const r = await sync.setup("blog");
  assert.equal(r.mode, "unmanaged");
  const col = [...mem.state.collections.values()][0];
  assert.equal(col.info.ownership, "user");
  assert.ok(col.fields.every((f) => f.id.startsWith("fld")), "ids come from Framer");
  assert.deepEqual(col.fields.map((f) => `${f.name}:${f.type}`), ["Title:string", "Date:date", "Thumbnail:image", "Content:formattedText"]);
  const applied = await sync.apply("blog");
  assert.equal(applied.mode, "unmanaged");
  assert.equal(applied.applied?.upserted, 1);
  const again = await sync.setup("blog");
  assert.equal(again.unchanged, true);
  assert.match(again.note!, /Framer editor/);
});

test("setup: a new collection can copy fields from an existing one", async () => {
  const { sync } = setup({
    collections: [{ id: "p", name: "Pricing", ownership: "user", fields: PRICING_FIELDS }],
    syncs: { p2: { collection: { name: "Pricing 2", create: true, mode: "unmanaged" }, schemaFrom: "Pricing", source: { type: "json" }, key: { field: "Title" } } },
  });
  const r = await sync.setup("p2");
  assert.equal(r.fieldsFrom, 'copied from "Pricing"');
  assert.equal(r.fieldCount, PRICING_FIELDS.length);
});

test("draft status: hand-set drafts survive a sync; prune-drafted items come back", async () => {
  const items = [
    { id: "n1", nodeId: "n1", slug: "plan-1", draft: true, fieldData: { title: { type: "string", value: "Plan 1" } } },
    { id: "n2", nodeId: "n2", slug: "plan-2", draft: false, fieldData: { title: { type: "string", value: "Plan 2" } } },
  ];
  const keep = setup({ collections: [{ id: "u", name: "Pricing", ownership: "user", fields: PRICING_FIELDS, items }], syncs: { pricing: pricingSync() } });
  await keep.sync.apply("pricing", { records: [{ Title: "Plan 1" }, { Title: "Plan 2" }] });
  assert.equal(keep.mem.state.collections.get("u")!.items.get("n1")!.draft, true, "hand-set draft kept");
  const revive = setup({ collections: [{ id: "u", name: "Pricing", ownership: "user", fields: PRICING_FIELDS, items }], syncs: { pricing: pricingSync({ prune: { minItems: 1, maxRemove: 5, mode: "draft" } }) } });
  const p = await revive.sync.plan("pricing", { records: [{ Title: "Plan 1" }, { Title: "Plan 2" }] });
  assert.deepEqual(p.items.update[0].changes, [{ field: "(draft)", from: true, to: false }]);
});

test("allow-mass-remove turns the guard error into a warning in the report", async () => {
  const { sync } = setup({ collections: [{ id: "p", name: "Pricing", ownership: "this", fields: PRICING_FIELDS }], syncs: { pricing: pricingSync({ prune: { minItems: 1, maxRemove: "20%" } }) } });
  await sync.apply("pricing", { records: rows(10) });
  const r = await sync.apply("pricing", { records: rows(2) }, { allowMassRemove: true });
  assert.equal(r.ok, true);
  assert.equal(r.issues.errors.length, 0);
  assert.match(r.issues.warnings.find((w) => w.code === "PRUNE_GUARD")!.message, /allowed/);
});

test("partial: adds and updates but never removes; create-only leaves existing items untouched", async () => {
  const { sync, mem } = setup({
    collections: [{ id: "p", name: "Pricing", ownership: "this", fields: PRICING_FIELDS }],
    syncs: { pricing: pricingSync({ prune: { minItems: 1, maxRemove: "100%" } }) },
  });
  await sync.apply("pricing", { records: rows(5) });
  const complete = await sync.plan("pricing", { records: rows(4) });
  assert.deepEqual(complete.items.remove, ["plan-5"]);
  assert.match(complete.run.description, /complete data: adds, updates, and removes/);
  const partial = await sync.apply("pricing", { records: [{ Title: "Plan 1", "Price ($)": 99 }, { Title: "New" }] }, { partial: true });
  assert.deepEqual(partial.items.remove, []);
  assert.match(partial.run.description, /partial data/);
  assert.equal(mem.state.collections.get("p")!.items.size, 6, "nothing removed, one added");
  const co = await sync.apply("pricing", { records: [{ Title: "Plan 2", "Price ($)": 1000 }, { Title: "Fresh" }] }, { createOnly: true });
  assert.deepEqual(co.items.create, ["fresh"]);
  assert.deepEqual(co.items.skipped, ["plan-2"]);
  assert.equal(co.items.update.length, 0);
  assert.match(co.run.description, /only add new/);
  const plan2 = [...mem.state.collections.get("p")!.items.values()].find((i) => i.slug === "plan-2")!;
  assert.equal(plan2.fieldData.price_usd.value, 2, "existing item untouched");
  // the plan id differs between a partial and a complete run of the same data
  const a = await sync.plan("pricing", { records: rows(3) });
  const b = await sync.plan("pricing", { records: rows(3) }, { partial: true });
  assert.notEqual(a.planId, b.planId);
});

test("option fields compare by option, whether Framer reports the name or the id", async () => {
  const { sync } = setup({
    collections: [{ id: "u", name: "Pricing", ownership: "user", fields: PRICING_FIELDS, items: [
      { id: "n1", nodeId: "n1", slug: "plan-1", draft: false, fieldData: { title: { type: "string", value: "Plan 1" }, tier: { type: "enum", value: "Pro" } } },
      { id: "n2", nodeId: "n2", slug: "plan-2", draft: false, fieldData: { title: { type: "string", value: "Plan 2" }, tier: { type: "enum", value: "c1" } } },
    ] }],
    syncs: { pricing: pricingSync() },
  });
  const same = await sync.plan("pricing", { records: [{ Title: "Plan 1", Tier: "Pro" }, { Title: "Plan 2", Tier: "Free" }] });
  assert.equal(same.items.update.length, 0, "name vs id is the same option");
  assert.equal(same.items.unchanged, 2);
  const changed = await sync.plan("pricing", { records: [{ Title: "Plan 1", Tier: "Free" }, { Title: "Plan 2", Tier: "Free" }] });
  assert.deepEqual(changed.items.update, [{ slug: "plan-1", changes: [{ field: "Tier", from: "Pro", to: "Free" }] }], "shown by name");
});

test("update-only, replace all, and everything matched by slug", async () => {
  const { sync, mem } = setup({ collections: [{ id: "p", name: "Pricing", ownership: "this", fields: PRICING_FIELDS }], syncs: { pricing: pricingSync() } });
  await sync.apply("pricing", { records: rows(4) });
  const data = [{ Title: "Plan 1", "Price ($)": 100 }, { Title: "Plan 2", "Price ($)": 2 }, { Title: "Brand New" }];
  const preview = await sync.plan("pricing", { records: data }, {});
  assert.deepEqual(preview.items.missing, ["plan-3", "plan-4"], "in Framer, not in the data");
  assert.deepEqual(preview.items.remove, [], "kept unless replacing");

  const upd = await sync.apply("pricing", { records: data }, { updateOnly: true });
  assert.deepEqual(upd.items.update.map((u) => u.slug), ["plan-1"]);
  assert.deepEqual(upd.items.skippedNew, ["brand-new"]);
  assert.equal(mem.state.collections.get("p")!.items.size, 4, "nothing added or removed");

  const rep = await sync.apply("pricing", { records: data }, { replace: true, allowMassRemove: true });
  assert.deepEqual(rep.items.create, ["brand-new"]);
  assert.deepEqual(rep.items.remove, ["plan-3", "plan-4"]);
  assert.deepEqual([...mem.state.collections.get("p")!.items.values()].map((i) => i.slug).sort(), ["brand-new", "plan-1", "plan-2"]);
  assert.match(rep.run.description, /replace all/);

  await assert.rejects(sync.plan("pricing", { records: data }, { replace: true, createOnly: true }), /choose one of/);
  const partialReplace = await sync.plan("pricing", { records: data }, { replace: true, partial: true });
  assert.ok(partialReplace.issues.errors.some((e) => /partial data can't replace/.test(e.message)));
});

test("managed: an existing item is found by slug even when its id differs; a new slug never overwrites another item's id", async () => {
  const { sync, mem } = setup({
    collections: [{ id: "p", name: "Pricing", ownership: "this", fields: PRICING_FIELDS, items: [
      { id: "legacy-1", nodeId: "n1", slug: "plan-1", draft: false, fieldData: { title: { type: "string", value: "Plan 1" } } },
      { id: "plan-2", nodeId: "n2", slug: "something-else", draft: false, fieldData: { title: { type: "string", value: "Other" } } },
    ] }],
    syncs: { pricing: pricingSync() },
  });
  const r = await sync.apply("pricing", { records: [{ Title: "Plan 1", "Price ($)": 5 }, { Title: "Plan 2", "Price ($)": 6 }] });
  assert.deepEqual(r.items.update.map((u) => u.slug), ["plan-1"], "matched by slug, updated in place");
  assert.deepEqual(r.items.create, ["plan-2"]);
  const items = [...mem.state.collections.get("p")!.items.values()];
  assert.equal(items.find((i) => i.slug === "plan-1")!.id, "legacy-1");
  assert.ok(items.find((i) => i.slug === "something-else"), "the item that owned id plan-2 is untouched");
  assert.notEqual(items.find((i) => i.slug === "plan-2")!.id, "plan-2", "new item got its own id");
});
