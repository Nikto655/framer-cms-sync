import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { parseConfig, loadConfig } from "../src/config/load.ts";
import { addProject, starterConfig } from "../src/config/write.ts";
import { createSync } from "../src/engine.ts";
import { createHandler } from "../src/server/http.ts";
import { createMemoryFramer } from "../src/framer/memory.ts";
import { SyncError } from "../src/core/issues.ts";
import { PRICING_FIELDS, rows, tmp } from "./helpers.ts";

process.env.NODE_ENV = "test";

const two = (syncs: Record<string, unknown> = {}) => ({
  projects: {
    main: { url: "https://framer.com/projects/main", apiKey: "key-main-123456", label: "Main Site" },
    shop: { url: "https://framer.com/projects/shop", apiKey: "key-shop-123456" },
  },
  runLog: false,
  syncs,
});
const sync = (project?: string) => ({ ...(project ? { project } : {}), collection: { name: "Pricing" }, source: { type: "json" }, key: { field: "Title" } });

function sites() {
  const main = createMemoryFramer({ projectName: "Main Site", collections: [{ id: "m", name: "Pricing", ownership: "this", fields: PRICING_FIELDS }] });
  const shop = createMemoryFramer({ projectName: "Shop", collections: [{ id: "s", name: "Pricing", ownership: "user", fields: PRICING_FIELDS }] });
  return { main, shop, connectors: { main: main.connector, shop: shop.connector } };
}

test("config: project: is shorthand for one project; syncs get it automatically", () => {
  const { config } = parseConfig({ project: { url: "https://framer.com/projects/x", apiKey: "k" }, syncs: { a: sync() } });
  assert.deepEqual(Object.keys(config.projects), ["default"]);
  assert.equal(config.syncs.a.project, "default");
});

test("config: with several projects every sync must name one", () => {
  assert.throws(() => parseConfig(two({ a: sync() })), (e: SyncError) => /syncs.a.project is required/.test(e.message) && /main, shop/.test(e.fix!));
  assert.throws(() => parseConfig(two({ a: sync("nope") })), (e: SyncError) => /isn't one of the projects/.test(e.message));
  assert.throws(() => parseConfig({ ...two(), project: { url: "u", apiKey: "k" } }), (e: SyncError) => /both project: and projects:/.test(e.message));
});

test("engine: each sync writes to its own project, in the right mode", async () => {
  const { main, shop, connectors } = sites();
  const { config } = parseConfig(two({ a: sync("main"), b: sync("shop") }));
  const engine = createSync({ config, configDir: tmp(), connectors });
  const a = await engine.apply("a", { records: rows(2) });
  const b = await engine.apply("b", { records: rows(3) });
  assert.equal(a.mode, "managed");
  assert.equal(b.mode, "unmanaged");
  assert.equal(main.state.collections.get("m")!.items.size, 2);
  assert.equal(shop.state.collections.get("s")!.items.size, 3);
  assert.deepEqual(engine.syncs().map((s) => s.project), ["main", "shop"]);
});

test("engine: site-wide operations need a project when there are several", async () => {
  const { main, connectors } = sites();
  const { config } = parseConfig(two());
  const engine = createSync({ config, configDir: tmp(), connectors });
  await assert.rejects(engine.collections(), (e: SyncError) => e.code === "INPUT_INVALID" && /main, shop/.test(e.fix!));
  assert.equal((await engine.collections({ project: "shop" }))[0].ownership, "user");
  await assert.rejects(engine.publish({ project: "nope" }), (e: SyncError) => e.code === "NOT_FOUND");
  await engine.publish({ project: "main" });
  assert.equal(main.state.published.length, 1);
  const ps = await engine.projects({ check: true });
  assert.deepEqual(ps.map((p) => [p.name, (p as { framerName?: string }).framerName]), [["main", "Main Site"], ["shop", "Shop"]]);
});

test("engine: writes to different projects can run at the same time; the same project is queued", async () => {
  const { main, shop, connectors } = sites();
  const { config } = parseConfig(two({ a: sync("main"), a2: sync("main"), b: sync("shop") }));
  const engine = createSync({ config, configDir: tmp(), connectors });
  await Promise.all([engine.apply("a", { records: rows(5) }), engine.apply("a2", { records: rows(5) }), engine.apply("b", { records: rows(5) })]);
  assert.equal(main.state.overlap, false, "same project never overlaps");
  assert.equal(shop.state.collections.get("s")!.items.size, 5);
});

test("addProject: converts a single-project config and keeps existing syncs attached", () => {
  const dir = tmp();
  const file = path.join(dir, "framer-cms-sync.config.yaml");
  writeFileSync(file, starterConfig().replace("syncs: {}", "syncs:\n  pricing:\n    collection: { name: Pricing }\n    source: { type: csv, path: ./p.csv }\n    key: { field: Name }"));
  writeFileSync(path.join(dir, ".env"), "FRAMER_PROJECT_URL=https://framer.com/projects/a\nFRAMER_API_KEY=key-a-1234567\n");
  const r = addProject(file, { name: "shop", url: "https://framer.com/projects/b", apiKey: "key-b-1234567", label: "Shop", firstName: "main" });
  assert.equal(r.converted, "main");
  assert.deepEqual(r.envVars, ["FRAMER_SHOP_URL", "FRAMER_SHOP_API_KEY"]);
  delete process.env.FRAMER_PROJECT_URL; delete process.env.FRAMER_API_KEY;
  const { config } = loadConfig(file);
  assert.deepEqual(Object.keys(config.projects), ["main", "shop"]);
  assert.equal(config.projects.shop.apiKey, "key-b-1234567");
  assert.equal(config.syncs.pricing.project, "main");
  assert.match(readFileSync(file, "utf8"), /# framer-cms-sync configuration/, "comments kept");
  assert.doesNotMatch(readFileSync(file, "utf8"), /key-b/, "key stays out of the config");
});

test("server: tokens can be limited to some projects", async () => {
  const { connectors } = sites();
  const loaded = parseConfig({ ...two({ a: sync("main"), b: sync("shop") }), server: { tokens: [{ name: "shop-only", token: "s".repeat(20), scope: "write", projects: ["shop"] }] } });
  const handler = createHandler(loaded, { connectors });
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, p: string, body?: unknown) => fetch(base + p, { method, headers: { "x-sync-token": "s".repeat(20), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.status);
  try {
    assert.equal(await call("POST", "/syncs/b/apply", rows(1)), 200);
    assert.equal(await call("POST", "/syncs/a/apply", rows(1)), 403);
    assert.equal(await call("GET", "/collections?project=shop"), 200);
    assert.equal(await call("GET", "/collections?project=main"), 403);
    assert.equal(await call("GET", "/collections"), 403);
  } finally { await new Promise((r) => server.close(r)); }
});


import { renameProject, setProjectLabel, removeProject } from "../src/config/write.ts";
import { readState, writeState } from "../src/core/state.ts";

function twoSiteFile() {
  const dir = tmp();
  const file = path.join(dir, "framer-cms-sync.config.yaml");
  writeFileSync(file, `# my sites
projects:
  main: { url: "https://framer.com/projects/a", apiKey: "key-a-1234567" }
  shop: { url: "https://framer.com/projects/b", apiKey: "key-b-1234567", label: Shop }
server:
  tokens:
    - { name: t, token: "${"x".repeat(20)}", scope: write, projects: [shop] }
syncs:
  products: { project: shop, collection: { name: P }, source: { type: json }, key: { field: Name } }
  blog: { project: main, collection: { name: B }, source: { type: markdown } }
`);
  return { dir, file };
}

test("renameProject: syncs and tokens follow; comments kept", () => {
  const { file } = twoSiteFile();
  renameProject(file, "shop", "store");
  const { config } = loadConfig(file);
  assert.deepEqual(Object.keys(config.projects), ["main", "store"]);
  assert.equal(config.syncs.products.project, "store");
  assert.equal(config.syncs.blog.project, "main");
  assert.deepEqual(config.server.tokens[0].projects, ["store"]);
  assert.equal(config.projects.store.label, "Shop");
  assert.match(readFileSync(file, "utf8"), /# my sites/);
  assert.throws(() => renameProject(file, "store", "main"), /already exists/);
  assert.throws(() => renameProject(file, "nope", "x"), /no site/);
  assert.throws(() => renameProject(file, "main", "bad name"), /letters, digits/);
});

test("renameProject: a single project: config becomes a named site", () => {
  const dir = tmp();
  const file = path.join(dir, "framer-cms-sync.config.yaml");
  writeFileSync(file, 'project: { url: "https://framer.com/projects/a", apiKey: "key-a-1234567" }\nsyncs:\n  s: { collection: { name: P }, source: { type: json }, key: { field: Name } }\n');
  renameProject(file, "default", "main");
  const { config } = loadConfig(file);
  assert.deepEqual(Object.keys(config.projects), ["main"]);
  assert.equal(config.syncs.s.project, "main");
});

test("setProjectLabel and removeProject", () => {
  const { file } = twoSiteFile();
  setProjectLabel(file, "main", "Main Site");
  assert.equal(loadConfig(file).config.projects.main.label, "Main Site");
  setProjectLabel(file, "main", "");
  assert.equal(loadConfig(file).config.projects.main.label, undefined);
  assert.throws(() => removeProject(file, "shop", ["products"]), /still has syncs/);
  writeFileSync(file, readFileSync(file, "utf8").replace(/  products:.*\n/, ""));
  removeProject(file, "shop", []);
  assert.deepEqual(Object.keys(loadConfig(file).config.projects), ["main"]);
  assert.throws(() => removeProject(file, "main", []), /only site/);
});

test("current site: state is per folder, and the engine uses it when no project is named", async () => {
  const { dir } = twoSiteFile();
  assert.equal(readState(dir).currentProject, undefined);
  writeState(dir, { currentProject: "shop" });
  assert.equal(readState(dir).currentProject, "shop");
  const { main, shop, connectors } = sites();
  const { config } = parseConfig(two());
  const engine = createSync({ config, configDir: dir, connectors, defaultProject: "shop" });
  assert.equal(engine.currentProject, "shop");
  assert.equal((await engine.collections())[0].ownership, "user", "used shop without being told");
  await engine.publish();
  assert.equal(shop.state.published.length, 1);
  assert.equal(main.state.published.length, 0);
});

import { addToken, revokeToken } from "../src/config/write.ts";

test("tokens: add saves the value to .env and the config, revoke removes both", () => {
  const { dir, file } = twoSiteFile();
  const t = addToken(file, { name: "claude", scope: "write", description: "Claude on my laptop" });
  assert.match(t.value, /^fcs_[0-9a-f]{48}$/);
  assert.equal(t.envVar, "SYNC_TOKEN_CLAUDE");
  assert.match(readFileSync(path.join(dir, ".env"), "utf8"), new RegExp(`SYNC_TOKEN_CLAUDE=${t.value}`));
  assert.doesNotMatch(readFileSync(file, "utf8"), new RegExp(t.value), "value never in the config");
  const { config } = loadConfig(file);
  const tok = config.server.tokens.find((x) => x.name === "claude")!;
  assert.equal(tok.token, t.value);
  assert.equal(tok.scope, "write");
  assert.equal(tok.description, "Claude on my laptop");
  assert.throws(() => addToken(file, { name: "claude", scope: "read" }), /already exists/);
  const limited = addToken(file, { name: "n8n", scope: "publish", syncs: ["products"] });
  assert.deepEqual(loadConfig(file).config.server.tokens.find((x) => x.name === "n8n")!.syncs, ["products"]);
  revokeToken(file, "claude");
  assert.ok(!loadConfig(file).config.server.tokens.some((x) => x.name === "claude"));
  assert.doesNotMatch(readFileSync(path.join(dir, ".env"), "utf8"), /SYNC_TOKEN_CLAUDE/);
  assert.match(readFileSync(path.join(dir, ".env"), "utf8"), new RegExp(limited.value), "other tokens untouched");
  assert.throws(() => revokeToken(file, "nope"), /no token/);
});

test("server: tokens added or revoked take effect without a restart", async () => {
  const { dir, file } = twoSiteFile();
  const { connectors } = sites();
  const first = addToken(file, { name: "first", scope: "read" });
  delete process.env.SYNC_TOKEN_FIRST;
  const handler = createHandler(loadConfig(file), { connectors });
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const status = (tok: string) => fetch(base + "/syncs", { headers: { "x-sync-token": tok } }).then((r) => r.status);
  try {
    assert.equal(await status(first.value), 200);
    await new Promise((r) => setTimeout(r, 20));
    const second = addToken(file, { name: "second", scope: "read" });
    assert.equal(await status(second.value), 200, "new token works immediately");
    await new Promise((r) => setTimeout(r, 20));
    revokeToken(file, "first");
    assert.equal(await status(first.value), 401, "revoked token refused immediately");
    void dir;
  } finally { await new Promise((r) => server.close(r)); }
});

test("mappings: view shows how each column matched; changes save to the config and take effect", async () => {
  const dir = tmp();
  const file = path.join(dir, "framer-cms-sync.config.yaml");
  writeFileSync(path.join(dir, "data.csv"), "Title,Price (USD),Notes,price_usd\nPlan A,10,x,1\n");
  writeFileSync(file, `project: { url: "https://framer.com/projects/a", apiKey: "key-a-1234567" }
runLog: false
syncs:
  p: { collection: { name: Pricing }, source: { type: csv, path: ./data.csv }, key: { field: Title } }
`);
  const mem = createMemoryFramer({ collections: [{ id: "c", name: "Pricing", ownership: "this", fields: [
    { id: "t", name: "Title", type: "string" }, { id: "pr", name: "Price", type: "number" }, { id: "pu", name: "Price USD", type: "number" },
  ] }] });
  const loaded = loadConfig(file);
  const engine = createSync({ config: loaded.config, configDir: dir, configFile: file, connect: mem.connector });
  const before = await engine.mappings("p");
  const how = Object.fromEntries(before.columns.map((c) => [c.column, [c.field?.name ?? null, c.how]]));
  assert.deepEqual(how["Title"], ["Title", "exact"]);
  assert.deepEqual(how["Notes"], [null, "none"]);
  assert.deepEqual(how["price_usd"], ["Price USD", "loose"]);
  assert.deepEqual(how["Price (USD)"], ["Price USD", "loose"]);
  assert.equal(before.columns.find((c) => c.column === "price_usd")!.shadowedBy, "Price (USD)", "second column into the same field is flagged");
  assert.deepEqual(before.unusedFields.map((f) => f.name), ["Price"]);

  const after = await engine.setMappings("p", [{ column: "Price (USD)", to: "price" }, { column: "Notes", to: "ignore" }, { column: "price_usd", to: "Price USD" }]);
  const how2 = Object.fromEntries(after.columns.map((c) => [c.column, [c.field?.name ?? null, c.how]]));
  assert.deepEqual(how2["Price (USD)"], ["Price", "map"], "field resolved loosely, saved by its real name");
  assert.deepEqual(how2["Notes"], [null, "ignored"]);
  assert.equal(after.unusedFields.length, 0);
  const saved = loadConfig(file).config.syncs.p.fields;
  assert.deepEqual(saved.map, { "Price (USD)": "Price", price_usd: "Price USD" });
  assert.deepEqual(saved.ignore, ["Notes"]);
  const plan = await engine.plan("p");
  assert.equal(plan.issues.warnings.filter((w) => w.code === "UNKNOWN_KEY").length, 0, "no more unmatched-column warnings");

  await engine.setMappings("p", [{ column: "Notes", to: "auto" }, { column: "Price (USD)", to: "auto" }]);
  const back = loadConfig(file).config.syncs.p.fields;
  assert.deepEqual(back.ignore, []);
  assert.deepEqual(back.map, { price_usd: "Price USD" });
  await assert.rejects(engine.setMappings("p", [{ column: "Notes", to: "Nope" }]), (e: SyncError) => /has no field "Nope"/.test(e.message) && /Title, Price, Price USD/.test(e.fix!));
});

test("mappings over HTTP and MCP", async () => {
  const dir = tmp();
  const file = path.join(dir, "framer-cms-sync.config.yaml");
  writeFileSync(path.join(dir, "data.csv"), "Title,Cost\nA,1\n");
  writeFileSync(file, `project: { url: "https://framer.com/projects/a", apiKey: "key-a-1234567" }
runLog: false
server: { tokens: [ { name: r, token: "${"r".repeat(20)}", scope: read }, { name: w, token: "${"w".repeat(20)}", scope: write } ] }
syncs:
  p: { collection: { name: Pricing }, source: { type: csv, path: ./data.csv }, key: { field: Title } }
`);
  const mem = createMemoryFramer({ collections: [{ id: "c", name: "Pricing", ownership: "user", fields: [{ id: "t", name: "Title", type: "string" }, { id: "pr", name: "Price", type: "number" }] }] });
  const handler = createHandler(loadConfig(file), { connect: mem.connector });
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, tok: string, body?: unknown) => fetch(base + "/syncs/p/mappings", { method, headers: { "x-sync-token": tok, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json() as any })); // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    const view = await call("GET", "r".repeat(20));
    assert.equal(view.status, 200);
    assert.equal(view.json.columns.find((c: { column: string }) => c.column === "Cost").how, "none");
    assert.equal((await call("POST", "r".repeat(20), { changes: [{ column: "Cost", to: "Price" }] })).status, 403, "read can't change");
    const changed = await call("POST", "w".repeat(20), { changes: [{ column: "Cost", to: "Price" }] });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.columns.find((c: { column: string }) => c.column === "Cost").how, "map");
    const short = await call("POST", "w".repeat(20), { Cost: "auto" });
    assert.equal(short.json.columns.find((c: { column: string }) => c.column === "Cost").how, "none", "object shorthand works");
  } finally { await new Promise((r) => server.close(r)); }

  const { createMcpServer } = await import("../src/mcp/server.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const loaded = loadConfig(file);
  const mcp = createMcpServer(loaded, { scope: "write", connect: mem.connector });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
  const got = text(await client.callTool({ name: "get_mappings", arguments: { sync: "p" } }));
  assert.equal(got.columns.find((c: { column: string }) => c.column === "Cost").how, "none");
  const set = text(await client.callTool({ name: "set_mappings", arguments: { sync: "p", changes: [{ column: "Cost", to: "Price" }] } }));
  assert.equal(set.columns.find((c: { column: string }) => c.column === "Cost").field.name, "Price");
});

import { deleteSync, deleteSite } from "../src/config/write.ts";
import { existsSync, mkdirSync } from "node:fs";

function deleteWorld() {
  const dir = tmp();
  const file = path.join(dir, "framer-cms-sync.config.yaml");
  mkdirSync(path.join(dir, "data"), { recursive: true });
  writeFileSync(path.join(dir, "data", "p.csv"), "Name\nA\n");
  writeFileSync(path.join(dir, "data", "b.xlsx"), "x");
  writeFileSync(path.join(dir, ".env"), [
    "FRAMER_MAIN_URL=https://framer.com/projects/a", "FRAMER_MAIN_API_KEY=key-a-1234567",
    "FRAMER_SHOP_URL=https://framer.com/projects/b", "FRAMER_SHOP_API_KEY=key-b-1234567",
    "FEED_SOURCE_URL=https://x.com/feed?token=abc", "FEED_SOURCE_HEADER=Bearer zzz",
    `SYNC_TOKEN_FEEDONLY=${"f".repeat(20)}`, `SYNC_TOKEN_ALL=${"a".repeat(20)}`, `SYNC_TOKEN_SHOPONLY=${"s".repeat(20)}`,
  ].join("\n") + "\n");
  writeFileSync(file, `projects:
  main: { url: "\${FRAMER_MAIN_URL}", apiKey: "\${FRAMER_MAIN_API_KEY}" }
  shop: { url: "\${FRAMER_SHOP_URL}", apiKey: "\${FRAMER_SHOP_API_KEY}" }
server:
  tokens:
    - { name: feedonly, token: "\${SYNC_TOKEN_FEEDONLY}", scope: write, syncs: [feed] }
    - { name: all, token: "\${SYNC_TOKEN_ALL}", scope: write }
    - { name: shoponly, token: "\${SYNC_TOKEN_SHOPONLY}", scope: read, projects: [shop] }
syncs:
  feed: { project: main, collection: { name: F }, source: { type: json, url: "\${FEED_SOURCE_URL}", headers: { Authorization: "\${FEED_SOURCE_HEADER}" } }, key: { field: id } }
  prices: { project: shop, collection: { name: P }, source: { type: csv, path: ./data/p.csv }, key: { field: Name } }
  outside: { project: shop, collection: { name: O }, source: { type: csv, path: ../elsewhere.csv }, key: { field: Name } }
  books: { project: shop, collection: { name: B }, source: { type: excel, path: ./data/b.xlsx }, key: { field: Name } }
`);
  return { dir, file };
}

test("deleteSync: removes its settings, secrets and limited tokens; files kept unless asked", () => {
  const { dir, file } = deleteWorld();
  const r = deleteSync(file, "feed");
  assert.deepEqual(r.removedSyncs, ["feed"]);
  assert.deepEqual(r.removedEnv.sort(), ["FEED_SOURCE_HEADER", "FEED_SOURCE_URL", "SYNC_TOKEN_FEEDONLY"]);
  assert.deepEqual(r.tokensRevoked, ["feedonly"]);
  const env = readFileSync(path.join(dir, ".env"), "utf8");
  assert.doesNotMatch(env, /FEED_SOURCE|SYNC_TOKEN_FEEDONLY/);
  assert.match(env, /SYNC_TOKEN_ALL/);
  const { config } = loadConfig(file);
  assert.ok(!config.syncs.feed);
  assert.deepEqual(config.server.tokens.map((t) => t.name), ["all", "shoponly"]);
  const k = deleteSync(file, "prices");
  assert.deepEqual(k.keptFiles, ["./data/p.csv"]);
  assert.ok(existsSync(path.join(dir, "data", "p.csv")), "kept by default");
});

test("deleteSync with files: deletes only inside the project folder", () => {
  const { dir, file } = deleteWorld();
  const r = deleteSync(file, "prices", { deleteFiles: true });
  assert.deepEqual(r.deletedFiles, ["./data/p.csv"]);
  assert.ok(!existsSync(path.join(dir, "data", "p.csv")));
  const o = deleteSync(file, "outside", { deleteFiles: true });
  assert.match(o.keptFiles[0], /outside the project folder/);
});

test("deleteSite: removes the site, its syncs, its URL/key and tokens limited to it", () => {
  const { dir, file } = deleteWorld();
  const r = deleteSite(file, "shop", { deleteFiles: true });
  assert.deepEqual(r.removedSyncs.sort(), ["books", "outside", "prices"]);
  assert.deepEqual(r.tokensRevoked, ["shoponly"]);
  assert.ok(r.removedEnv.includes("FRAMER_SHOP_API_KEY") && r.removedEnv.includes("FRAMER_SHOP_URL"));
  assert.deepEqual(r.deletedFiles.sort(), ["./data/b.xlsx", "./data/p.csv"]);
  const { config } = loadConfig(file);
  assert.deepEqual(Object.keys(config.projects), ["main"]);
  assert.deepEqual(Object.keys(config.syncs), ["feed"]);
  assert.match(readFileSync(path.join(dir, ".env"), "utf8"), /FRAMER_MAIN_API_KEY/);
  // the last site resets everything local
  const last = deleteSite(file, "main");
  assert.equal(last.reset, true);
  assert.ok(!existsSync(file) && !existsSync(path.join(dir, ".env")));
});

test("mappings: the first change can be an ignore on a compact config with no fields: yet", async () => {
  const dir = tmp();
  const file = path.join(dir, "framer-cms-sync.config.yaml");
  writeFileSync(path.join(dir, "data.csv"), "Title,Notes\nPlan A,x\n");
  writeFileSync(file, `project: { url: "https://framer.com/projects/a", apiKey: "key-a-1234567" }
runLog: false
syncs:
  p:
    collection: { name: Pricing }
    source: { type: csv, path: ./data.csv }
    key: { field: Title }
`);
  const mem = createMemoryFramer({ collections: [{ id: "c", name: "Pricing", ownership: "this", fields: [{ id: "t", name: "Title", type: "string" }] }] });
  const engine = createSync({ config: loadConfig(file).config, configDir: dir, configFile: file, connect: mem.connector });
  await engine.setMappings("p", [{ column: "Notes", to: "ignore" }]);
  assert.match(readFileSync(file, "utf8"), /ignore:\n\s+- Notes/);
  await engine.setMappings("p", [{ column: "Notes", to: "auto" }]);
  assert.doesNotMatch(readFileSync(file, "utf8"), /Notes/);
});
