import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config/load.ts";
import { createSync } from "../src/engine.ts";
import { createMemoryFramer, type MemoryCollection } from "../src/framer/memory.ts";
import type { FieldDef } from "../src/types.ts";

export const PRICING_FIELDS: FieldDef[] = [
  { id: "title", name: "Title", type: "string" },
  { id: "price_usd", name: "Price ($)", type: "number" },
  { id: "tier", name: "Tier", type: "enum", cases: [{ id: "c1", name: "Free" }, { id: "c2", name: "Pro" }] },
  { id: "flag", name: "Flag", type: "image" },
  { id: "active", name: "Active", type: "boolean" },
];

export const BLOG_FIELDS: FieldDef[] = [
  { id: "title", name: "Title", type: "string" },
  { id: "date", name: "Publish Date", type: "date" },
  { id: "body", name: "Content", type: "formattedText" },
  { id: "desc", name: "Meta Description", type: "string" },
  { id: "thumb", name: "Thumbnail", type: "image" },
];

export function tmp() { return mkdtempSync(path.join(tmpdir(), "fcs-")); }

export function setup(opts: { collections: MemoryCollection[]; syncs: Record<string, unknown>; dir?: string; extra?: Record<string, unknown> }) {
  const dir = opts.dir ?? tmp();
  const mem = createMemoryFramer({ collections: opts.collections });
  const { config } = parseConfig({ project: { url: "https://framer.com/projects/x", apiKey: "test-key-123456" }, syncs: opts.syncs, runLog: false, ...opts.extra });
  const sync = createSync({ config, configDir: dir, connect: mem.connector, actor: "test" });
  return { sync, mem, dir, config };
}

export function write(dir: string, rel: string, text: string) {
  const p = path.join(dir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

export const rows = (n: number, f: (i: number) => Record<string, unknown> = (i) => ({ Title: `Plan ${i}`, "Price ($)": i })) =>
  Array.from({ length: n }, (_, i) => f(i + 1));
