import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { BLOG_FIELDS, PRICING_FIELDS, setup } from "./helpers.ts";

const pass = (fields = PRICING_FIELDS, extra: Record<string, unknown> = {}) => setup({
  collections: [{ id: "c", name: "Things", ownership: "user", fields }],
  syncs: { things: { collection: { name: "Things" }, source: { type: "none" }, ...extra } },
});

test("pass-through: rows sent in are matched by their slug", async () => {
  const { sync, mem } = pass();
  const r = await sync.apply("things", { records: [{ slug: "pro", Title: "Pro", "Price ($)": 20 }] }, { partial: true });
  assert.deepEqual(r.items.create, ["pro"]);
  const u = await sync.apply("things", { text: "slug,Price ($)\npro,25\n", contentType: "text/csv" }, { partial: true });
  assert.equal(u.items.update[0].changes[0].to, 25);
  assert.equal(mem.state.collections.get("c")!.items.size, 1);
});

test("pass-through: Markdown posts work like a Markdown sync, nothing saved locally", async () => {
  const { sync, mem, dir } = pass(BLOG_FIELDS);
  const r = await sync.addPosts("things", [{ slug: "hello", markdown: "---\ntitle: Hello\n---\nBody." }]);
  assert.deepEqual(r.items.create, ["hello"]);
  assert.deepEqual(r.files, []);
  assert.equal(readdirSync(dir).length, 0, "nothing written to the project folder");
  const item = [...mem.state.collections.get("c")!.items.values()][0];
  assert.equal(item.fieldData.body.value, "<p>Body.</p>");
  await sync.updatePosts("things", [{ slug: "hello", markdown: "---\ntitle: Hello again\n---\nBody." }]);
  await sync.remove("things", "hello");
  assert.equal(mem.state.collections.get("c")!.items.size, 0);
  assert.equal(existsSync(`${dir}/hello.md`), false);
});

test("pass-through: no data → a clear NO_INPUT; pull refused; listed as sent in", async () => {
  const { sync } = pass();
  await assert.rejects(sync.plan("things"), (e: Error & { code?: string; fix?: string }) => e.code === "NO_INPUT" && /add/.test(e.fix!));
  await assert.rejects(sync.pull("things"), /nothing to download into/);
  assert.match(sync.syncs()[0].source, /sent in/);
});

test("pass-through: a new collection gets basic fields", async () => {
  const { sync } = setup({ collections: [], syncs: { notes: { collection: { name: "Notes", create: true, mode: "unmanaged" }, source: { type: "none" } } } });
  const r = await sync.setup("notes");
  assert.equal(r.created, true);
  const f = await sync.fields("Notes");
  assert.deepEqual(f.fields.map((x) => x.name), ["Title", "Date", "Image", "Description", "Content"]);
});
