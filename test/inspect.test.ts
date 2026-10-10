import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inspectSource } from "../src/inspect.ts";
import { flatten, locateRows } from "../src/core/inspect.ts";
import { parseConfig, loadConfig } from "../src/config/load.ts";
import { createSync } from "../src/engine.ts";
import { createHandler } from "../src/server/http.ts";
import { createMemoryFramer } from "../src/framer/memory.ts";
import { SyncError } from "../src/core/issues.ts";
import { tmp } from "./helpers.ts";

process.env.NODE_ENV = "test";

const NESTED = { meta: { page: 1 }, data: { items: [
  { name: "Pro", slug: "pro", price: { amount: 21, currency: "USD" }, tags: ["a", "b"], launched: "2026-01-02" },
  { name: "Team", slug: "team", price: { amount: 55, currency: "USD" }, tags: [], launched: "2026-02-03" },
] } };

test("flatten and locateRows", () => {
  assert.deepEqual(flatten({ a: 1, b: { c: 2, d: { e: 3 } }, f: [1] }), { a: 1, "b.c": 2, "b.d.e": 3, f: [1] });
  const miss = locateRows(NESTED);
  assert.equal(miss.rows, null);
  assert.deepEqual(miss.candidates[0], { path: "data.items", count: 2 });
  assert.equal(locateRows(NESTED, "data.items").rows!.length, 2);
  assert.equal(locateRows({ rows: [{ a: 1 }] }).at, "rows");
});

test("inspect: nested JSON from a live URL, with and without rows", async () => {
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(NESTED)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/plans`;
  try {
    const first = await inspectSource({ url });
    assert.equal(first.ok, false);
    assert.equal(first.candidates![0].path, "data.items");
    const r = await inspectSource({ url, rows: "data.items" });
    assert.equal(r.ok, true);
    assert.equal(r.records, 2);
    const byPath = Object.fromEntries(r.fields.map((f) => [f.path, f.type]));
    assert.deepEqual(byPath, { name: "string", slug: "string", "price.amount": "number", "price.currency": "string", tags: "list", launched: "date" });
    assert.equal(r.suggestedKey, "slug");
    assert.deepEqual(r.suggestedSource, { type: "json", url, rows: "data.items" });
  } finally { await new Promise((r) => server.close(r)); }
});

test("inspect: CSV file, Markdown folder, sent data", async () => {
  const dir = tmp();
  writeFileSync(path.join(dir, "p.csv"), "Name,Price\nA,1\nB,2\n");
  const csv = await inspectSource({ file: "p.csv", baseDir: dir });
  assert.equal(csv.format, "csv");
  assert.deepEqual(csv.fields.map((f) => [f.path, f.type]), [["Name", "string"], ["Price", "number"]]);
  const sent = await inspectSource({ records: [{ json: { id: 1, a: { b: true } } }] });
  assert.deepEqual(sent.fields.map((f) => [f.path, f.type]), [["id", "number"], ["a.b", "boolean"]], "n8n items unwrapped, nested flattened");
});

test("sync with nested JSON: rows path and dotted mappings work end to end", async () => {
  const dir = tmp();
  const file = path.join(dir, "framer-cms-sync.config.yaml");
  writeFileSync(path.join(dir, "plans.json"), JSON.stringify(NESTED));
  writeFileSync(file, `project: { url: "https://framer.com/projects/a", apiKey: "key-a-1234567" }
runLog: false
syncs:
  plans:
    collection: { name: Plans }
    source: { type: json, path: ./plans.json, rows: data.items }
    key: { field: slug, transform: none }
    fields: { map: { "price.amount": "Price" }, ignore: [price.currency, tags, launched] }
`);
  const mem = createMemoryFramer({ collections: [{ id: "c", name: "Plans", ownership: "this", fields: [{ id: "n", name: "Name", type: "string" }, { id: "p", name: "Price", type: "number" }] }] });
  const engine = createSync({ ...(() => { const l = loadConfig(file); return { config: l.config, configDir: dir, configFile: file }; })(), connect: mem.connector });
  const r = await engine.apply("plans");
  assert.equal(r.ok, true);
  assert.equal(r.issues.warnings.length, 0);
  const items = [...mem.state.collections.get("c")!.items.values()];
  assert.equal(items.find((i) => i.slug === "pro")!.fieldData.p.value, 21);
  const ins = await engine.inspect({ sync: "plans" });
  assert.equal(ins.rowsAt, "data.items");
  // without rows: a helpful error that names the path
  writeFileSync(file, readFile(file).replace(", rows: data.items", ""));
  const engine2 = createSync({ config: loadConfig(file).config, configDir: dir, connect: mem.connector });
  await assert.rejects(engine2.plan("plans"), (e: SyncError) => /source\.rows: data\.items/.test(e.fix!));
});
import { readFileSync } from "node:fs";
const readFile = (p: string) => readFileSync(p, "utf8");

test("inspect over HTTP and MCP: arbitrary URLs need admin", async () => {
  const loaded = parseConfig({
    project: { url: "https://framer.com/projects/a", apiKey: "key-a-1234567" }, runLog: false,
    server: { tokens: [{ name: "r", token: "r".repeat(20), scope: "read" }, { name: "a", token: "a".repeat(20), scope: "admin" }] },
    syncs: { s: { collection: { name: "X" }, source: { type: "json" }, key: { field: "id" } } },
  });
  const handler = createHandler(loaded, { connect: createMemoryFramer({}).connector });
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string, tok: string, body?: unknown) => fetch(base + p, { method: "POST", headers: { "x-sync-token": tok, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json() as any })); // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    const sent = await post("/inspect?rows=data.items", "r".repeat(20), NESTED);
    assert.equal(sent.status, 200);
    assert.equal(sent.json.records, 2);
    assert.equal((await post(`/inspect?url=${encodeURIComponent("http://169.254.169.254/latest/meta-data")}`, "r".repeat(20))).status, 403, "read token can't make the server fetch URLs");
    const bySync = await post("/syncs/s/inspect", "r".repeat(20), [{ id: 1, x: { y: "z" } }]);
    assert.deepEqual(bySync.json.fields.map((f: { path: string }) => f.path), ["id", "x.y"]);
  } finally { await new Promise((r) => server.close(r)); }

  const { createMcpServer } = await import("../src/mcp/server.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const mcp = createMcpServer(loaded, { scope: "write", connect: createMemoryFramer({}).connector });
  const [x, y] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([mcp.connect(x), client.connect(y)]);
  const res = await client.callTool({ name: "inspect_source", arguments: { url: "http://10.0.0.1/" } });
  assert.equal(res.isError, true);
  assert.match((res as { content: { text: string }[] }).content[0].text, /admin scope/);
  const ok = await client.callTool({ name: "inspect_source", arguments: { records: NESTED, rows: "data.items" } });
  assert.equal(JSON.parse((ok as { content: { text: string }[] }).content[0].text).records, 2);
});
