// Small runtime helpers: the write queue, timeouts, the run log, and plugin loading.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SyncError } from "./issues.ts";
import type { LintRule } from "../lint/rules.ts";

/** One write at a time per process: applies, setups, redirect imports, publishes. */
export function createQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

export async function withTimeout<T>(p: Promise<T>, seconds: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new SyncError("TIMEOUT", `${what} took longer than ${seconds}s`, { fix: "raise defaults.timeoutSeconds, or sync fewer items per run" })), seconds * 1000); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
}

export interface RunLogEntry {
  at: string;
  actor: string;
  op: string;
  project?: string;
  sync?: string;
  ok: boolean;
  counts?: Record<string, number>;
  deploymentId?: string;
  error?: string;
}

export function runLogPath(configDir: string) { return path.join(configDir, ".framer-cms-sync", "runs.jsonl"); }

export async function appendRunLog(configDir: string, entry: RunLogEntry) {
  const p = runLogPath(configDir);
  await mkdir(path.dirname(p), { recursive: true });
  await appendFile(p, JSON.stringify(entry) + "\n");
}

export async function readRunLog(configDir: string, limit = 100): Promise<RunLogEntry[]> {
  try {
    const lines = (await readFile(runLogPath(configDir), "utf8")).trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
  } catch { return []; }
}

export type Transform = (record: Record<string, unknown>, ctx: { sync: string; origin: string }) => Record<string, unknown> | null | undefined | Promise<Record<string, unknown> | null | undefined>;
export interface Plugin { lintRules?: Record<string, LintRule>; transforms?: Record<string, Transform> }

export async function loadPlugins(paths: string[], configDir: string): Promise<Required<Plugin>> {
  const out: Required<Plugin> = { lintRules: {}, transforms: {} };
  for (const p of paths) {
    let mod: { default?: Plugin } & Plugin;
    try { mod = await import(pathToFileURL(path.resolve(configDir, p)).href); }
    catch (e) { throw new SyncError("CONFIG_INVALID", `couldn't load plugin ${p}: ${(e as Error).message}`); }
    const plugin = mod.default ?? mod;
    Object.assign(out.lintRules, plugin.lintRules ?? {});
    Object.assign(out.transforms, plugin.transforms ?? {});
  }
  return out;
}
