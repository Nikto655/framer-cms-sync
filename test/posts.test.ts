import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BLOG_FIELDS, PRICING_FIELDS, setup, tmp, write } from "./helpers.ts";
import { postsFromBody } from "../src/core/posts.ts";

const blog = () => setup({
  collections: [{ id: "b", name: "Blog", ownership: "user", fields: BLOG_FIELDS }],
  syncs: { blog: { collection: { name: "Blog" }, source: { type: "markdown", path: "./posts" }, prune: { minItems: 1, maxRemove: 100 } } },
});
const slugs = (mem: ReturnType<typeof blog>["mem"]) => [...mem.state.collections.get("b")!.items.values()].map((i) => i.slug).sort();

test("add: a post from outside the folder goes to Framer and is saved into the folder", async () => {
  const { sync, mem, dir } = blog();
  write(dir, "posts/existing.md", "---\ntitle: Existing\n---\nOld.\n");
  await sync.apply("blog");
  const outside = write(tmp(), "My Draft.md", "---\nslug: new-post\ntitle: New\n---\nHello.\n");
  const r = await sync.addPosts("blog", [{ markdown: readFileSync(outside, "utf8"), slug: "My Draft", file: outside }]);
  assert.deepEqual(r.items.create, ["new-post"]);
  assert.deepEqual(slugs(mem), ["existing", "new-post"], "other items untouched");
  assert.equal(r.files[0].action, "created");
  assert.equal(readFileSync(path.join(dir, "posts/new-post.md"), "utf8"), "---\nslug: new-post\ntitle: New\n---\nHello.\n");
  // The folder and Framer now agree.
  const p = await sync.plan("blog");
  assert.equal(p.items.create.length + p.items.update.length + p.items.missing.length, 0);
});

test("add refuses an existing slug; update refuses a new one; nothing is written", async () => {
  const { sync, dir } = blog();
  write(dir, "posts/a.md", "---\ntitle: A\n---\nA\n");
  await sync.apply("blog");
  await assert.rejects(sync.addPosts("blog", [{ markdown: "---\ntitle: A2\n---\nA2", slug: "a" }]), (e: Error & { code?: string }) => e.code === "ITEM_EXISTS");
  await assert.rejects(sync.updatePosts("blog", [{ markdown: "---\ntitle: B\n---\nB", slug: "b" }]), (e: Error & { code?: string }) => e.code === "ITEM_NOT_FOUND");
  assert.equal(readFileSync(path.join(dir, "posts/a.md"), "utf8"), "---\ntitle: A\n---\nA\n");
  assert.equal(existsSync(path.join(dir, "posts/b.md")), false);
});

test("update: overwrites the file that holds the slug, even with a different file name", async () => {
  const { sync, mem, dir } = blog();
  write(dir, "posts/2026-10-first.md", "---\nslug: first\ntitle: First\n---\nOld.\n");
  write(dir, "posts/other.md", "---\ntitle: Other\n---\nOther.\n");
  await sync.apply("blog");
  const r = await sync.updatePosts("blog", [{ markdown: "---\nslug: first\ntitle: First (edited)\n---\nNew.\n" }]);
  assert.equal(r.items.update.length, 1);
  assert.equal(r.files[0].action, "updated");
  assert.match(readFileSync(path.join(dir, "posts/2026-10-first.md"), "utf8"), /edited/);
  assert.equal(existsSync(path.join(dir, "posts/first.md")), false);
  const item = [...mem.state.collections.get("b")!.items.values()].find((i) => i.slug === "first")!;
  assert.equal(item.fieldData.title.value, "First (edited)");
});

test("update: a file already in the folder is synced in place", async () => {
  const { sync, dir } = blog();
  const f = write(dir, "posts/a.md", "---\ntitle: A\n---\nA\n");
  await sync.apply("blog");
  write(dir, "posts/a.md", "---\ntitle: A edited\n---\nA\n");
  const r = await sync.updatePosts("blog", [{ markdown: readFileSync(f, "utf8"), slug: "a", file: f }]);
  assert.equal(r.items.update.length, 1);
  assert.equal(r.files[0].action, "unchanged");
});

test("invalid posts write nothing", async () => {
  const { sync, mem, dir } = blog();
  const r = await sync.addPosts("blog", [{ markdown: "---\ntitle: Bad\n---\nSee [[Wiki]].\n", slug: "bad" }]);
  assert.equal(r.applied, null);
  assert.equal(slugs(mem).length, 0);
  assert.equal(existsSync(path.join(dir, "posts/bad.md")), false);
});

test("remove deletes the post's file too, unless keepFile", async () => {
  const { sync, mem, dir } = blog();
  write(dir, "posts/a.md", "---\ntitle: A\n---\nA\n");
  write(dir, "posts/b.md", "---\ntitle: B\n---\nB\n");
  await sync.apply("blog");
  const r = await sync.remove("blog", "a");
  assert.equal(r.file, path.join("posts", "a.md"));
  assert.equal(existsSync(path.join(dir, "posts/a.md")), false);
  await sync.remove("blog", "b", { keepFile: true });
  assert.equal(existsSync(path.join(dir, "posts/b.md")), true);
  assert.deepEqual(slugs(mem), []);
});

test("single posts are for Markdown syncs only", async () => {
  const { sync } = setup({
    collections: [{ id: "p", name: "Pricing", ownership: "user", fields: PRICING_FIELDS }],
    syncs: { pricing: { collection: { name: "Pricing" }, source: { type: "csv" }, key: { field: "Title" } } },
  });
  await assert.rejects(sync.addPosts("pricing", [{ markdown: "x" }]), /isn't a Markdown sync/);
});

test("posts from a request body", () => {
  assert.deepEqual(postsFromBody("---\ntitle: A\n---\nA", "text/markdown", "a"), [{ markdown: "---\ntitle: A\n---\nA", slug: "a" }]);
  assert.deepEqual(postsFromBody('{"slug":"a","markdown":"x"}', "application/json"), [{ markdown: "x", slug: "a" }]);
  assert.equal(postsFromBody('{"posts":[{"markdown":"x"},{"markdown":"y","slug":"y"}]}', undefined).length, 2);
  assert.throws(() => postsFromBody('{"title":"x"}', "application/json"), /markdown string/);
});

test("mcp: add_posts, update_posts and remove_item write straight away", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createMcpServer } = await import("../src/mcp/server.ts");
  const { sync, mem, dir, config } = blog();
  const server = createMcpServer({ config, dir, file: path.join(dir, "framer-cms-sync.config.yaml") } as never, { scope: "write", engine: sync });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const agent = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), agent.connect(b)]);
  const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
  const added = text(await agent.callTool({ name: "add_posts", arguments: { sync: "blog", posts: [{ slug: "tokyo", markdown: "---\ntitle: Tokyo\n---\nHi." }] } }));
  assert.deepEqual(added.items.create, ["tokyo"]);
  assert.ok(existsSync(path.join(dir, "posts/tokyo.md")));
  const again = await agent.callTool({ name: "add_posts", arguments: { sync: "blog", posts: [{ slug: "tokyo", markdown: "---\ntitle: Tokyo\n---\nHi." }] } });
  assert.equal(text(again).error.code, "ITEM_EXISTS");
  const pub = await agent.callTool({ name: "update_posts", arguments: { sync: "blog", posts: [{ slug: "tokyo", markdown: "---\ntitle: T\n---\nHi." }], publish: true } });
  assert.equal(text(pub).error.code, "FORBIDDEN");
  const upd = text(await agent.callTool({ name: "update_posts", arguments: { sync: "blog", posts: [{ slug: "tokyo", markdown: "---\ntitle: Tokyo!\n---\nHi." }] } }));
  assert.equal(upd.items.update.length, 1);
  text(await agent.callTool({ name: "remove_item", arguments: { sync: "blog", slug: "tokyo" } }));
  assert.equal(existsSync(path.join(dir, "posts/tokyo.md")), false);
  assert.deepEqual(slugs(mem), []);
});

test("markdown into a collection with no rich-text field: fine while posts have no body", async () => {
  const { sync, dir } = setup({
    collections: [{ id: "p", name: "Gear", ownership: "user", fields: [{ id: "t", name: "Title", type: "string" }, { id: "pr", name: "Price", type: "number" }] }],
    syncs: { gear: { collection: { name: "Gear" }, source: { type: "markdown", path: "./gear" } } },
  });
  write(dir, "gear/tent.md", "---\ntitle: Tent\nprice: 120\n---\n");
  const ok = await sync.plan("gear");
  assert.equal(ok.issues.errors.length, 0);
  write(dir, "gear/tent.md", "---\ntitle: Tent\nprice: 120\n---\nA body with nowhere to go.\n");
  const bad = await sync.plan("gear");
  assert.equal(bad.issues.errors[0]?.code, "REQUIRED_FIELD_UNMAPPED");
});
