import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseConfig } from "../src/config/load.ts";
import { createSync } from "../src/engine.ts";
import { createMemoryFramer } from "../src/framer/memory.ts";
import { googleSheetCsvUrl, readExcel } from "../src/formats.ts";
import { tmp } from "./helpers.ts";
import type { FieldDef, ExistingItem } from "../src/types.ts";

const FIELDS: FieldDef[] = [
  { id: "t", name: "Title", type: "string" },
  { id: "p", name: "Price", type: "number" },
  { id: "on", name: "In Stock", type: "boolean" },
  { id: "d", name: "Launch Date", type: "date" },
  { id: "tier", name: "Tier", type: "enum", cases: [{ id: "c1", name: "Free" }, { id: "c2", name: "Pro" }] },
  { id: "img", name: "Image", type: "image" },
  { id: "body", name: "Article", type: "formattedText" },
];
const item = (n: number, slug: string, draft = false): ExistingItem => ({
  id: `n${n}`, nodeId: `n${n}`, slug, draft, fieldData: {
    t: { type: "string", value: `Item, "${n}"` }, p: { type: "number", value: n * 10.5 }, on: { type: "boolean", value: n % 2 === 0 },
    d: { type: "date", value: `2026-0${n}-15T00:00:00.000Z` }, tier: { type: "enum", value: n === 1 ? "c1" : "c2" },
    img: { type: "image", value: { url: `https://framerusercontent.com/images/${n}.jpg`, id: `i${n}` } },
    body: { type: "formattedText", value: `<h2>Heading ${n}</h2><p>Para with <strong>bold</strong> and a <a href="https://x.com">link</a>.<br>Next line.</p><ul><li>one</li><li>two</li></ul>` },
  },
});

function world(ownership: "user" | "this") {
  const dir = tmp();
  const mem = createMemoryFramer({ collections: [{ id: "c", name: "Products", ownership, fields: FIELDS, items: [item(1, "first"), item(2, "second-item"), item(3, "third", true)] }] });
  return { dir, mem };
}

for (const format of ["csv", "excel", "markdown"] as const) {
  for (const ownership of ["user", "this"] as const) {
    test(`download → sync round trip (${format}, ${ownership === "user" ? "regular" : "managed"}): first preview has no changes`, async () => {
      const { dir, mem } = world(ownership);
      const base = { project: { url: "https://framer.com/projects/x", apiKey: "k-1234567" }, runLog: false };
      const engine0 = createSync({ config: parseConfig(base).config, configDir: dir, connect: mem.connector });
      const dest = format === "markdown" ? "content/products" : format === "excel" ? "data/products.xlsx" : "data/products.csv";
      const r = await engine0.download({ collection: "Products", format, dest });
      assert.equal(r.rows, 3);
      const source = { type: format, path: `./${dest}` };
      const sync = { collection: { name: "Products" }, source, ...(format !== "markdown" ? { key: { field: r.keyColumn, transform: r.keyTransform } } : {}), ...(r.bodyField ? { fields: { map: { content: r.bodyField } } } : {}) };
      const engine = createSync({ config: parseConfig({ ...base, syncs: { products: sync } }).config, configDir: dir, connect: mem.connector });
      const plan = await engine.plan("products");
      assert.deepEqual(plan.issues.errors, []);
      assert.deepEqual(plan.issues.warnings.map((w) => w.message), [], "no warnings");
      assert.deepEqual(plan.items.create, [], "nothing new");
      assert.deepEqual(plan.items.update, [], "nothing changed");
      assert.deepEqual(plan.items.remove, []);
      assert.equal(plan.items.unchanged + plan.items.unverified.length, 3);
    });
  }
}

test("markdown download: frontmatter uses field names, body converted to Markdown, drafts marked", async () => {
  const { dir, mem } = world("user");
  const engine = createSync({ config: parseConfig({ project: { url: "https://framer.com/projects/x", apiKey: "k-1234567" }, runLog: false }).config, configDir: dir, connect: mem.connector });
  await engine.download({ collection: "Products", format: "markdown", dest: "posts" });
  const md = readFileSync(path.join(dir, "posts", "third.md"), "utf8");
  assert.match(md, /^---\nslug: third\nTitle: Item, "3"\n/);
  assert.match(md, /Launch Date: 2026-03-15/);
  assert.match(md, /Tier: Pro/);
  assert.match(md, /published: false/);
  assert.match(md, /## Heading 3\n\nPara with \*\*bold\*\* and a \[link\]\(https:\/\/x\.com\)\./);
  assert.match(md, /- one\n- two/);
  await assert.rejects(engine.download({ collection: "Products", format: "markdown", dest: "posts" }), /already has Markdown files/);
});

test("templates: one example row whose types can be worked out; copying another collection's fields", async () => {
  const { dir, mem } = world("user");
  const engine = createSync({ config: parseConfig({ project: { url: "https://framer.com/projects/x", apiKey: "k-1234567" }, runLog: false }).config, configDir: dir, connect: mem.connector });
  const basic = await engine.template({ format: "excel", dest: "t.xlsx" });
  assert.equal(basic.keyColumn, "Name");
  const rows = await readExcel(path.join(dir, "t.xlsx"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Price, 19.99);
  const copy = await engine.template({ format: "csv", dest: "c.csv", from: "Products" });
  assert.deepEqual(copy.columns, ["Title", "Price", "In Stock", "Launch Date", "Tier", "Image", "Article"]);
  assert.equal(copy.keyColumn, "Title");
  assert.match(readFileSync(path.join(dir, "c.csv"), "utf8"), /First item,42,true,2026-01-31,Free/);
  await assert.rejects(engine.template({ format: "csv", dest: "c.csv" }), /already exists/);
});

test("Excel source: reads the first sheet or a named one", async () => {
  const dir = tmp();
  const { writeExcel } = await import("../src/formats.ts");
  await writeExcel(path.join(dir, "x.xlsx"), [{ Name: "A", Price: 1 }, { Name: "B", Price: 2 }], ["Name", "Price"], "Prices");
  const rows = await readExcel(path.join(dir, "x.xlsx"), "Prices");
  assert.deepEqual(rows, [{ Name: "A", Price: 1 }, { Name: "B", Price: 2 }]);
  await assert.rejects(readExcel(path.join(dir, "x.xlsx"), "Nope"), /no sheet named "Nope"/);
});

test("Google Sheets links become CSV export addresses", () => {
  assert.equal(googleSheetCsvUrl("https://docs.google.com/spreadsheets/d/ABC123/edit#gid=456"), "https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=456");
  assert.equal(googleSheetCsvUrl("https://docs.google.com/spreadsheets/d/ABC123/edit?usp=sharing"), "https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=0");
  assert.equal(googleSheetCsvUrl("https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pubhtml?gid=7"), "https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pub?output=csv&gid=7");
  assert.equal(googleSheetCsvUrl("https://example.com/data.csv"), "https://example.com/data.csv");
});
void writeFileSync;

import { detectOrder, parseDate } from "../src/core/dates.ts";
import { inferFields } from "../src/core/infer.ts";
import { syncSchema } from "../src/config/schema.ts";
import { coerce } from "../src/core/coerce.ts";

test("dates: day/month vs month/day is never guessed", () => {
  assert.equal(detectOrder(["10/08/2026", "01/02/2026"]), "ambiguous");
  assert.equal(detectOrder(["10/08/2026", "25/08/2026"]), "DMY");
  assert.equal(detectOrder(["08/25/2026"]), "MDY");
  assert.equal(parseDate("10/08/2026"), "ambiguous");
  assert.equal((parseDate("10/08/2026", "DMY") as Date).toISOString(), "2026-08-10T00:00:00.000Z");
  assert.equal((parseDate("10/08/2026", "MDY") as Date).toISOString(), "2026-10-08T00:00:00.000Z");
  assert.equal((parseDate("25/08/2026") as Date).toISOString(), "2026-08-25T00:00:00.000Z", "unambiguous on its own");
  assert.equal((parseDate("2026-08-10") as Date).toISOString(), "2026-08-10T00:00:00.000Z");
  const field = { id: "d", name: "Publish Date", type: "date" };
  const amb = coerce(field, "10/08/2026", { nulls: "clear", formattedText: "html" });
  assert.equal(!amb.ok && amb.code, "DATE_AMBIGUOUS");
  assert.ok(!amb.ok && /fields\.dateOrder/.test(amb.fix!));
  assert.deepEqual(coerce(field, "10/08/2026", { nulls: "clear", formattedText: "html", dateOrder: "DMY" }), { ok: true, entry: { type: "date", value: "2026-08-10T00:00:00.000Z" } });
});

test("inference: sheet-style columns get sensible types and readable names", () => {
  const rec = { title: "Test", slug: "test-slug", "publish-date": "10/08/2026", meta_description: "x", published: "yes", author: "Sam", thumbnail: "", content_html: "blah", featured: "yes", "updated-date": "" };
  const { fields } = inferFields([{ data: rec, origin: "row 1" }], syncSchema.parse({ collection: { name: "x" }, source: { type: "csv" }, key: { field: "slug" } }));
  const got = Object.fromEntries(fields.map((f) => [f.name, f.type]));
  assert.deepEqual(got, {
    Title: "string", "Publish Date": "date", "Meta Description": "string", Published: "boolean", Author: "string",
    Thumbnail: "image", "Content HTML": "formattedText", Featured: "boolean", "Updated Date": "date",
  });
});

import { existsSync as exists2, readdirSync as readdir2 } from "node:fs";
import { loadConfig as loadCfg } from "../src/config/load.ts";

test("pull: Framer edits come down into the sync's file, with a backup; the next preview has no changes", async () => {
  for (const format of ["excel", "markdown"] as const) {
    const { dir, mem } = world("user");
    const file = path.join(dir, "framer-cms-sync.config.yaml");
    const src = format === "excel" ? "./data/products.xlsx" : "./content/products";
    writeFileSync(file, `project: { url: "https://framer.com/projects/x", apiKey: "k-1234567" }
runLog: false
syncs:
  products:
    collection: { name: Products }
    source: { type: ${format}, path: ${src} }
${format === "excel" ? "    key: { field: slug, transform: none }\n" : ""}`);
    const mk = () => { const l = loadCfg(file); return createSync({ config: l.config, configDir: dir, configFile: file, connect: mem.connector }); };
    // start from a download, then someone edits an item in Framer
    await mk().download({ collection: "Products", format, dest: src });
    const item = [...mem.state.collections.get("c")!.items.values()].find((i) => i.slug === "first")!;
    item.fieldData.p = { type: "number", value: 999 };
    const before = await mk().plan("products");
    assert.equal(before.items.update.length, 1, `${format}: the Framer edit shows as a difference`);
    const r = await mk().pull("products");
    assert.equal(r.rows, 3);
    assert.ok(r.backup && exists2(path.join(dir, r.backup)), "backup saved");
    if (format === "markdown") assert.equal(readdir2(path.join(dir, src)).filter((f) => f.endsWith(".md")).length, 3);
    const after = await mk().plan("products");
    assert.equal(after.items.update.length + after.items.create.length, 0, `${format}: file now matches Framer`);
    if (format === "excel") assert.deepEqual(loadCfg(file).config.syncs.products.key, { field: "slug", transform: "none" }, "key switched to exact slugs");
  }
});

test("pull: refused for URL sources, with how to do it instead", async () => {
  const { dir, mem } = world("user");
  const engine = createSync({ config: parseConfig({ project: { url: "https://framer.com/projects/x", apiKey: "k-1234567" }, runLog: false, syncs: { s: { collection: { name: "Products" }, source: { type: "csv", url: "https://docs.google.com/spreadsheets/d/abc/edit" }, key: { field: "slug" } } } }).config, configDir: dir, configFile: path.join(dir, "c.yaml"), connect: mem.connector });
  await assert.rejects(engine.pull("s"), (e: Error & { fix?: string }) => /can't write to/.test(e.message) && /File → Import/.test(e.fix!));
});
