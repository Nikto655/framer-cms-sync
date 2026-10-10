// One Markdown post -> one record: frontmatter keys plus `content` (rendered HTML).

import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import type { SyncConfig } from "../config/schema.ts";
import type { SourceRecord } from "../types.ts";
import { issue, type Issue } from "../core/issues.ts";
import { flatten } from "../core/inspect.ts";
import { BUILTIN_RULES, DEFAULT_MARKDOWN_LINT, normaliseResults, type LintRule } from "../lint/rules.ts";

const renderers = new Map<string, MarkdownIt>();
function renderer(sync: SyncConfig) {
  const k = `${sync.markdown.typographer}:${sync.markdown.linkify}`;
  if (!renderers.has(k)) renderers.set(k, new MarkdownIt({ html: true, linkify: sync.markdown.linkify, typographer: sync.markdown.typographer, breaks: false }));
  return renderers.get(k)!;
}

const decode = (u: string) => { try { return decodeURIComponent(u).replace(/\+/g, " ").toLowerCase(); } catch { return u.toLowerCase(); } };

export function parsePost(text: string, file: string, sync: SyncConfig, plugins: Record<string, LintRule> = {}): { record?: SourceRecord; issues: Issue[] } {
  const issues: Issue[] = [];
  let fm: Record<string, unknown>, body: string;
  try {
    const parsed = matter(text.replace(/^﻿/, ""));
    fm = { ...(parsed.data as Record<string, unknown>) };
    body = parsed.content;
  } catch (e) {
    return { issues: [issue("error", "FRONTMATTER_INVALID", `${file}: frontmatter isn't valid YAML (${(e as Error).message.split("\n")[0]})`, { record: file, fix: "check the --- block at the top of the file" })] };
  }
  // gray-matter turns dates into Date objects; keep them as ISO strings.
  for (const [k, v] of Object.entries(fm)) if (v instanceof Date) fm[k] = v.toISOString();

  if (sync.markdown.stripLeadingH1) {
    const h1 = body.match(/^\s*#\s+(.+?)\s*#*\s*\n/);
    if (h1) {
      if (fm.title === undefined) fm.title = h1[1].trim();
      body = body.slice(h1[0].length);
    }
  }

  let html = renderer(sync).render(body).trim();
  const thumbKey = sync.markdown.dedupeThumbnail;
  if (thumbKey && typeof fm[thumbKey] === "string") {
    const th = decode(fm[thumbKey] as string);
    let removed = 0;
    html = html.replace(/(<p>\s*)?<img\b[^>]*\bsrc="([^"]+)"[^>]*>(\s*<\/p>)?/g, (m, _p, src: string) => (decode(src.replace(/&amp;/g, "&")) === th ? (removed++, "") : m)).trim();
    if (removed) issues.push(issue("warning", "LINT", `${file}: removed ${removed} body image(s) that repeat the ${thumbKey}`, { record: file, rule: "dedupe-thumbnail" }));
  }
  if (!html) issues.push(issue("warning", "BODY_EMPTY", `${file}: the body is empty, so the post's body field will be empty`, { record: file, fix: "write the post body below the frontmatter, if it should have one" }));

  // Lint
  const rules = { ...BUILTIN_RULES, ...plugins };
  const config = { ...DEFAULT_MARKDOWN_LINT, ...sync.lint };
  for (const [name, setting] of Object.entries(config)) {
    const level = typeof setting === "string" ? setting : (setting.level as string) ?? "warn";
    if (level === "off") continue;
    const rule = rules[name];
    if (!rule) { issues.push(issue("warning", "LINT", `unknown lint rule "${name}"`, { rule: name, fix: "check the rule name, or the plugin that provides it" })); continue; }
    const opts = typeof setting === "object" ? (setting as Record<string, unknown>) : {};
    let results;
    try { results = normaliseResults(rule({ file, frontmatter: fm, body, html }, opts)); }
    catch (e) { results = [{ message: `rule crashed: ${(e as Error).message}` }]; }
    for (const r of results) issues.push(issue(level === "error" ? "error" : "warning", "LINT", `${file}: ${r.message}`, { record: file, rule: name, fix: r.fix }));
  }

  const base = file.split(/[\\/]/).pop()!.replace(/\.(md|markdown|mdx)$/i, "");
  return { record: { data: { ...flatten(fm), content: html }, origin: file, slugHint: base }, issues };
}
