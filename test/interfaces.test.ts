import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseConfig, interpolate } from "../src/config/load.ts";
import { createHandler } from "../src/server/http.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { createMemoryFramer } from "../src/framer/memory.ts";
import { loadSource } from "../src/sources/index.ts";
import { syncSchema } from "../src/config/schema.ts";
import { SyncError } from "../src/core/issues.ts";
import { PRICING_FIELDS, rows, tmp, write } from "./helpers.ts";

process.env.NODE_ENV = "test";

const baseConfig = (server: Record<string, unknown> = {}) => ({
  project: { url: "https://framer.com/projects/x", apiKey: "test-key-123456" },
  runLog: false,
  server,
  syncs: { pricing: { collection: { name: "Pricing" }, source: { type: "json" }, key: { field: "Title" } } },
});

function memory() {
  return createMemoryFramer({ collections: [{ id: "p", name: "Pricing", ownership: "this", fields: PRICING_FIELDS }] });
}

async function serve(cfg: Record<string, unknown>) {
  const loaded = parseConfig(cfg);
  const mem = memory();
  const handler = createHandler(loaded, { connect: mem.connector });
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, token?: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { ...(token ? { "x-sync-token": token } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { call, mem, base, close: () => new Promise((r) => server.close(r)) };
}

test("config: ${VAR} interpolation with defaults; missing vars are reported", () => {
  const missing = new Set<string>();
  assert.equal(interpolate("${A}-${B:-dflt}-${C}", { A: "x" }, missing), "x-dflt-");
  assert.deepEqual([...missing], ["C"]);
  assert.throws(() => parseConfig({ project: { url: "${NOPE_URL}", apiKey: "k" } }, "cfg.yaml", {}), (e: SyncError) => e.code === "CONFIG_INVALID" && /NOPE_URL/.test(e.message));
  assert.throws(() => parseConfig({ ...baseConfig(), syncs: { s: { collection: { name: "X" }, source: { type: "csv" } } } }), (e: SyncError) => /key.field is required/.test(e.message));
});

test("sources: CSV quoting, n8n item unwrapping, Markdown folder completeness", async () => {
  const csv = syncSchema.parse({ collection: { name: "X" }, source: { type: "csv" }, key: { field: "a" } });
  const r = await loadSource(csv, { text: 'a,b\n"x, y","say ""hi"""\n' }, { baseDir: "." });
  assert.deepEqual(r.records[0].data, { a: "x, y", b: 'say "hi"' });
  const json = syncSchema.parse({ collection: { name: "X" }, source: { type: "json" }, key: { field: "a" } });
  const j = await loadSource(json, { records: [{ json: { a: 1 } }, { a: 2 }] }, { baseDir: "." });
  assert.deepEqual(j.records.map((x) => x.data.a), [1, 2]);
  await assert.rejects(loadSource(json, { text: "[{bad json" }, { baseDir: "." }), (e: SyncError) => e.code === "INPUT_INVALID");
  const dir = tmp();
  write(dir, "posts/a.md", "---\ntitle: A\n---\nA");
  const md = syncSchema.parse({ collection: { name: "X" }, source: { type: "markdown", path: "./posts" } });
  assert.equal((await loadSource(md, undefined, { baseDir: dir })).complete, true);
  assert.equal((await loadSource(md, { files: [dir + "/posts/a.md"] }, { baseDir: dir })).complete, false);
});

test("server: refuses to start without a token", () => {
  assert.throws(() => createHandler(parseConfig(baseConfig()), { connect: memory().connector }), (e: SyncError) => e.code === "AUTH_MISSING");
});

test("server: auth, scopes and routes", async () => {
  const s = await serve(baseConfig({ tokens: [
    { name: "reader", token: "r".repeat(20), scope: "read" },
    { name: "agent", token: "w".repeat(20), scope: "write" },
    { name: "owner", token: "o".repeat(20), scope: "admin" },
  ] }));
  try {
    assert.equal((await s.call("GET", "/health")).status, 200);
    assert.equal((await s.call("GET", "/collections")).status, 401);
    assert.equal((await s.call("GET", "/collections", "x".repeat(20))).status, 401);
    const plan = await s.call("POST", "/syncs/pricing/plan", "r".repeat(20), rows(2));
    assert.equal(plan.status, 200);
    assert.equal(plan.json.items.create.length, 2);
    assert.equal((await s.call("POST", "/syncs/pricing/apply", "r".repeat(20), rows(2))).status, 403, "read can't write");
    const applied = await s.call("POST", "/syncs/pricing/apply", "w".repeat(20), rows(2));
    assert.equal(applied.status, 200);
    assert.equal(applied.json.applied.upserted, 2);
    assert.equal((await s.call("POST", "/syncs/pricing/apply?publish=true", "w".repeat(20), rows(2))).status, 403, "write can't publish");
    assert.equal((await s.call("POST", "/publish", "w".repeat(20))).status, 403);
    assert.equal((await s.call("POST", "/publish", "o".repeat(20))).status, 200);
    const bad = await s.call("POST", "/syncs/pricing/plan", "r".repeat(20), [{ Title: "X", "Price ($)": "lots" }]);
    assert.equal(bad.status, 422);
    const missing = await s.call("POST", "/syncs/nope/plan", "r".repeat(20), []);
    assert.equal(missing.status, 404);
    assert.ok(missing.json.error.fix.includes("pricing"));
  } finally { await s.close(); }
});

test("mcp: apply requires a planId; tools follow the scope", async () => {
  const loaded = parseConfig(baseConfig());
  const mem = memory();
  const connect = async (scope: "read" | "write" | "publish" | "admin") => {
    const server = createMcpServer(loaded, { scope, connect: mem.connector });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  };
  const read = await connect("read");
  const names = (await read.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("plan_sync"));
  assert.ok(!names.includes("apply_sync") && !names.includes("publish_site"));

  const agent = await connect("write");
  const tools = (await agent.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("apply_sync") && !tools.includes("publish_site"));
  const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
  const plan = text(await agent.callTool({ name: "plan_sync", arguments: { sync: "pricing", records: rows(2) } }));
  assert.equal(plan.items.create.length, 2);
  const stale = await agent.callTool({ name: "apply_sync", arguments: { sync: "pricing", records: rows(3), planId: plan.planId } });
  assert.equal(stale.isError, true);
  assert.equal(text(stale).error.code, "PLAN_STALE");
  const noPublish = await agent.callTool({ name: "apply_sync", arguments: { sync: "pricing", records: rows(2), planId: plan.planId, publish: true } });
  assert.equal(text(noPublish).error.code, "FORBIDDEN");
  const ok = text(await agent.callTool({ name: "apply_sync", arguments: { sync: "pricing", records: rows(2), planId: plan.planId } }));
  assert.equal(ok.applied.upserted, 2);
  assert.equal(mem.state.published.length, 0);
});

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("server: MCP over HTTP at /mcp uses the token's scope", async () => {
  const s = await serve(baseConfig({ tokens: [
    { name: "agent", token: "w".repeat(20), scope: "write" },
    { name: "limited", token: "l".repeat(20), scope: "write", syncs: ["pricing"] },
  ] }));
  const connect = async (token: string) => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(s.base + "/mcp"), { requestInit: { headers: { "x-sync-token": token } } }));
    return client;
  };
  try {
    const agent = await connect("w".repeat(20));
    const names = (await agent.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("apply_sync") && !names.includes("publish_site"));
    const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
    const plan = text(await agent.callTool({ name: "plan_sync", arguments: { sync: "pricing", records: rows(2) } }));
    const applied = text(await agent.callTool({ name: "apply_sync", arguments: { sync: "pricing", records: rows(2), planId: plan.planId } }));
    assert.equal(applied.applied.upserted, 2);
    await agent.close();
    await assert.rejects(connect("x".repeat(20)));
    await assert.rejects(connect("l".repeat(20)));
  } finally { await s.close(); }
});

test("server: data in the body is partial by default; complete=true allows removal", async () => {
  const cfg = baseConfig({ tokens: [{ name: "w", token: "w".repeat(20), scope: "write" }] });
  (cfg.syncs.pricing as Record<string, unknown>).prune = { minItems: 1, maxRemove: "100%" };
  const s = await serve(cfg);
  try {
    await s.call("POST", "/syncs/pricing/apply?complete=true", "w".repeat(20), rows(3));
    const partial = await s.call("POST", "/syncs/pricing/plan", "w".repeat(20), rows(1));
    assert.deepEqual(partial.json.items.remove, [], "body data never removes by default");
    assert.equal(partial.json.run.complete, false);
    const complete = await s.call("POST", "/syncs/pricing/plan?complete=true", "w".repeat(20), rows(1));
    assert.deepEqual(complete.json.items.remove, ["plan-2", "plan-3"]);
    const co = await s.call("POST", "/syncs/pricing/apply?createOnly=true", "w".repeat(20), [{ Title: "Plan 1", "Price ($)": 500 }, { Title: "Brand New" }]);
    assert.deepEqual(co.json.items.create, ["brand-new"]);
    assert.deepEqual(co.json.items.skipped, ["plan-1"]);
  } finally { await s.close(); }
});
