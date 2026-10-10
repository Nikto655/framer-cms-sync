// Single Markdown posts: add, update or remove one post at a time, keeping the sync's folder in step
// with Framer so the next full sync doesn't undo the change.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SyncConfig } from "../config/schema.ts";
import { parsePost } from "../sources/markdown.ts";
import { keyToSlug } from "./identity.ts";
import { SyncError } from "./issues.ts";
import { isMarkdownFile, postName } from "./filetypes.ts";

export interface Post {
  markdown: string;
  /** Slug to use when the frontmatter has none (a file's name, or one given by the caller). */
  slug?: string;
  /** Where the post came from, when it's a file. */
  file?: string;
}

export interface PostFile { slug: string; file: string | null; action: "created" | "updated" | "unchanged" | "deleted" | "none" }

export function requireMarkdown(name: string, sync: SyncConfig) {
  if (sync.source.type !== "markdown" && sync.source.type !== "none")
    throw new SyncError("INPUT_INVALID", `"${name}" isn't a Markdown sync; adding or updating single posts is for Markdown syncs`,
      { fix: `edit the ${sync.source.type === "excel" ? "spreadsheet" : "file"}, then run \`framer-cms-sync apply ${name} --partial\`` });
}

/** The slug a post will get: the same rule the sync uses (frontmatter slug, else the file name). */
export function slugOf(post: Post, sync: SyncConfig): string | undefined {
  if (sync.source.type === "none") sync = { ...sync, source: { ...sync.source, type: "markdown" } };
  const r = parsePost(post.markdown, post.slug ? `${post.slug}.md` : "post", sync);
  if (!r.record) return undefined;
  const key = sync.key ?? { field: "slug", transform: "none" as const };
  const raw = r.record.data[key.field] ?? (key.field === "slug" ? post.slug : undefined);
  return keyToSlug(raw, key.transform) || undefined;
}

/** The sync's posts folder, or null when it has none (fed only over HTTP/MCP, a glob, or a URL). */
export function postFolder(sync: SyncConfig, configDir: string): string | null {
  const p = sync.source.path;
  if (!p || sync.source.url || /[*?[\]{}]/.test(p) || isMarkdownFile(p)) return null;
  return path.resolve(configDir, p);
}

function postFiles(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return (readdirSync(folder, { recursive: true }) as string[]).filter(isMarkdownFile).map((f) => path.join(folder, f));
}

/** The file in the folder that holds this slug, if any. */
export function findPostFile(folder: string, slug: string, sync: SyncConfig): string | undefined {
  return postFiles(folder).find((f) => slugOf({ markdown: readFileSync(f, "utf8"), slug: postName(f) }, sync) === slug);
}

/** Save a post into the folder: over the file that already has its slug, else as <slug>.md. */
export function savePost(folder: string, slug: string, post: Post, sync: SyncConfig): PostFile {
  const existing = findPostFile(folder, slug, sync);
  const target = existing ?? path.join(folder, `${slug}.md`);
  if (post.file && path.resolve(post.file) === target) return { slug, file: target, action: "unchanged" };
  if (existing && readFileSync(existing, "utf8") === post.markdown) return { slug, file: target, action: "unchanged" };
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, post.markdown.endsWith("\n") ? post.markdown : post.markdown + "\n");
  return { slug, file: target, action: existing ? "updated" : "created" };
}

export function deletePost(folder: string, slug: string, sync: SyncConfig): PostFile {
  const f = findPostFile(folder, slug, sync);
  if (!f) return { slug, file: null, action: "none" };
  rmSync(f);
  return { slug, file: f, action: "deleted" };
}

/** Posts from a request body: Markdown text, {slug?, markdown}, {posts:[…]} or [...]. */
export function postsFromBody(text: string, contentType: string | undefined, slug?: string): Post[] {
  const t = text.trim();
  if (!t) throw new SyncError("NO_INPUT", "send a post: Markdown text, or JSON { slug, markdown }");
  const looksJson = (contentType ?? "").includes("json") || t.startsWith("{") || t.startsWith("[");
  if (!looksJson) return [{ markdown: text, slug }];
  let j: unknown;
  try { j = JSON.parse(t); } catch { throw new SyncError("INPUT_INVALID", "the body isn't valid JSON"); }
  const list = Array.isArray(j) ? j : Array.isArray((j as { posts?: unknown }).posts) ? (j as { posts: unknown[] }).posts : [j];
  return list.map((p) => {
    if (typeof p === "string") return { markdown: p, slug };
    const o = p as { markdown?: unknown; slug?: unknown };
    if (typeof o?.markdown !== "string") throw new SyncError("INPUT_INVALID", "each post needs a markdown string", { fix: 'send { "slug": "my-post", "markdown": "---\\ntitle: …\\n---\\n\\nBody" }' });
    return { markdown: o.markdown, slug: typeof o.slug === "string" ? o.slug : slug };
  });
}
