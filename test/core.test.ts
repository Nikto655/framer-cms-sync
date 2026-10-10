import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, itemId, fieldId } from "../src/core/identity.ts";
import { coerce } from "../src/core/coerce.ts";
import { mapRecords } from "../src/core/map.ts";
import { syncSchema } from "../src/config/schema.ts";
import { PRICING_FIELDS } from "./helpers.ts";

const opts = { nulls: "clear" as const, formattedText: "html" as const };

test("slugify matches the original framer-sync rule", () => {
  assert.equal(slugify("United States (USA)"), "united-states-usa");
  assert.equal(slugify("  Côte d'Ivoire "), "c-te-d-ivoire");
  assert.equal(slugify("--Hello--World--"), "hello-world");
});

test("itemId keeps short slugs and hashes long ones to <= 64 chars, deterministically", () => {
  assert.equal(itemId("short-slug"), "short-slug");
  const long = "a-very-long-slug-".repeat(6) + "end";
  const id = itemId(long);
  assert.ok(id.length <= 64);
  assert.equal(id, itemId(long));
  assert.notEqual(id, itemId(long + "x"));
});

test("fieldId matches the original scheme", () => {
  assert.equal(fieldId("1GB ($)"), "f_1gb_usd");
  assert.equal(fieldId("Price (€)"), "price_eur");
  assert.equal(fieldId("Category"), "category");
});

test("coerce: numbers, booleans, dates, enums, images", () => {
  const num = PRICING_FIELDS[1], tier = PRICING_FIELDS[2], flag = PRICING_FIELDS[3], active = PRICING_FIELDS[4];
  assert.deepEqual(coerce(num, "3.49", opts), { ok: true, entry: { type: "number", value: 3.49 } });
  const bad = coerce(num, "$3.49", opts);
  assert.equal(bad.ok, false); assert.equal(!bad.ok && bad.code, "NUMBER_INVALID");
  const empty = coerce(num, null, opts);
  assert.equal(!empty.ok && empty.skip, true);
  assert.deepEqual(coerce(active, "yes", opts), { ok: true, entry: { type: "boolean", value: true } });
  assert.deepEqual(coerce(tier, "pro", opts), { ok: true, entry: { type: "enum", value: "c2" } });
  const noEnum = coerce(tier, "Gold", opts);
  assert.ok(!noEnum.ok && noEnum.fix?.includes("Free, Pro"));
  assert.equal((coerce(flag, "/img/x.png", opts) as { code: string }).code, "IMAGE_NOT_ABSOLUTE");
  assert.deepEqual(coerce({ id: "d", name: "D", type: "date" }, "2026-10-10", opts), { ok: true, entry: { type: "date", value: "2026-10-10T00:00:00.000Z" } });
});

test("coerce: empty CSV cells clear non-text fields instead of failing", () => {
  for (const type of ["boolean", "image", "link", "file", "color", "date"]) {
    const r = coerce({ id: "f", name: "F", type }, "", opts);
    assert.equal(r.ok, true, `${type} should accept an empty cell`);
  }
  assert.deepEqual(coerce({ id: "f", name: "F", type: "boolean" }, "", opts), { ok: true, entry: { type: "boolean", value: false } });
  assert.equal((coerce(PRICING_FIELDS[1], "", opts) as { code: string }).code, "NUMBER_EMPTY");
});

test("map: absent keys are untouched, null clears, unknown keys warn once", () => {
  const sync = syncSchema.parse({ collection: { name: "P" }, source: { type: "json" }, key: { field: "Title" } });
  const { items, issues } = mapRecords([
    { data: { Title: "Turkey", "Price ($)": 4.5, Flag: null, Notes: "x" }, origin: "row 1" },
    { data: { Title: "Spain", Notes: "y" }, origin: "row 2" },
  ], PRICING_FIELDS, sync);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].fieldData.flag, { type: "image", value: null });
  assert.equal(items[0].id, "turkey");
  assert.ok(!("price_usd" in items[1].fieldData));
  const unknown = issues.filter((i) => i.code === "UNKNOWN_KEY");
  assert.equal(unknown.length, 1);
  assert.match(unknown[0].message, /2 records/);
});

test("map: missing key is an error; duplicate keys warn and the later row wins", () => {
  const sync = syncSchema.parse({ collection: { name: "P" }, source: { type: "json" }, key: { field: "Title" } });
  const { items, issues } = mapRecords([
    { data: { Title: "", "Price ($)": 1 }, origin: "row 1" },
    { data: { Title: "A", "Price ($)": 1 }, origin: "row 2" },
    { data: { Title: "a", "Price ($)": 2 }, origin: "row 3" },
  ], PRICING_FIELDS, sync);
  assert.equal(issues.find((i) => i.code === "KEY_MISSING")?.level, "error");
  assert.equal(issues.find((i) => i.code === "DUPLICATE_KEY")?.level, "warning");
  assert.equal(items.length, 1);
  assert.equal(items[0].fieldData.price_usd.value, 2);
});

import { normalizeHtml } from "../src/core/plan.ts";
test("rich text compares by content, ignoring Framer's formatting changes", () => {
  assert.equal(normalizeHtml('<p dir="auto"><br class="trailing-break"></p>'), "");
  assert.equal(normalizeHtml('<p dir="auto">Hi <a href="https://x.com" target="_blank">x</a></p>'), normalizeHtml('<p>Hi <a href="https://x.com">x</a></p>'));
  assert.equal(normalizeHtml('<ol><li data-preset-tag="h4"><h4>A</h4></li></ol>'), normalizeHtml('<ol style="--framer-text-color:rgb(0,0,0)"><li><h4>A</h4></li></ol>'));
  assert.equal(normalizeHtml("blah"), "<p>blah</p>");
  assert.notEqual(normalizeHtml("<p>one</p>"), normalizeHtml("<p>two</p>"));
  assert.equal(normalizeHtml("<p>in no time.&nbsp;The result</p>"), normalizeHtml("<p>in no time. The result</p>"));
  assert.equal(normalizeHtml('<p>role "Project &gt; Editor"</p>'), normalizeHtml("<p>role &quot;Project &gt; Editor&quot;</p>"));
  assert.equal(normalizeHtml("<p>device.<br><br><strong>Quote</strong></p>"), normalizeHtml("<p>device.</p><p><strong>Quote</strong></p>"));
  assert.equal(normalizeHtml('<p>x</p><img alt="" src="https://framerusercontent.com/i.png">'), normalizeHtml('<p>x</p><p><img src="https://framerusercontent.com/i.png" alt=""></p>'));
  assert.notEqual(normalizeHtml("<p>a<br>b</p>"), normalizeHtml("<p>a</p><p>b</p>"), "a single line break still counts");
  assert.equal(normalizeHtml("<h2>A</h2><p> Once we</p>"), normalizeHtml("<h2>A</h2>\n<p>Once we</p>"));
  assert.notEqual(normalizeHtml("<p><strong>bold</strong></p>"), normalizeHtml("<p>bold</p>"), "formatting tags still count");
});
