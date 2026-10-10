// Shared pieces of the terminal app: context, site helpers, header, source helpers.

import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { editConfig, relPath, setEnv, setIn } from "../config/write.ts";
import { loadSource } from "../sources/index.ts";
import type { Sync } from "../engine.ts";
import { Help, Keys, Select } from "./components.tsx";
import { formatFromPath } from "../core/filetypes.ts";

export type Screen =
  | { name: "setup" }
  | { name: "addsite" }
  | { name: "sites" }
  | { name: "tokens" }
  | { name: "home" }
  | { name: "sync"; sync: string; message?: string }
  | { name: "settings"; sync: string }
  | { name: "newsync"; firstRun?: boolean }
  | { name: "redirects" }
  | { name: "collections" }
  | { name: "history" };

export interface Ctx {
  dir: string;
  file: string | null;
  engine: Sync | null;
  /** The current site: the only one, or the one chosen on the Sites screen. */
  site: string | null;
  setSite: (name: string) => void;
  loadError: { message: string; fix?: string } | null;
  reload: () => void;
  go: (s: Screen) => void;
}

// Each site gets its own colour (in site order, or `color:` in the config) and a display string,
// so the current site is obvious at a glance and named in every confirmation.
export const SITE_COLORS = ["cyan", "magenta", "yellow", "blue", "green", "white"];
export function siteColor(ctx: Ctx, project: string | null | undefined): string | undefined {
  if (!project || !ctx.engine) return undefined;
  return ctx.engine.config.projects[project]?.color ?? SITE_COLORS[Math.max(0, ctx.engine.projectNames.indexOf(project)) % SITE_COLORS.length];
}
/** "Maya's Shop (shop)" when there are several sites; just the display name when there's one. */
export function siteName(ctx: Ctx, project: string | null | undefined): string {
  if (!project || !ctx.engine) return "the site";
  const label = ctx.engine.config.projects[project]?.label;
  if (ctx.engine.projectNames.length === 1) return label ? `"${label}"` : "the site";
  return label ? `"${label}" (${project})` : `"${project}"`;
}
export const errInfo = (e: unknown) => ({ message: String((e as Error)?.message ?? e), fix: (e as { fix?: string })?.fix });

// ---------------------------------------------------------------------------
export function Header({ ctx, title, project }: { ctx: Ctx; title?: string; project?: string }) {
  const [site, setSite] = useState<string | null>(null);
  const names = ctx.engine?.projectNames ?? [];
  const shown = project ?? ctx.site ?? (names.length > 1 ? null : names[0]);
  const multi = names.length > 1;
  useEffect(() => {
    if (!ctx.engine) return;
    const p = project ?? ctx.site ?? (multi ? null : names[0]);
    if (!p) { setSite(`${names.length} sites`); return; }
    const label = ctx.engine.config.projects[p]?.label;
    if (label) { setSite(multi ? `${label} (${p})` : label); return; }
    ctx.engine.project({ project: p }).then((r) => setSite(multi ? `${r.name} (${p})` : r.name)).catch(() => setSite(multi ? p : null));
  }, [ctx.engine, project, ctx.site]);
  return (
    <Box marginBottom={1}>
      <Text bold>framer-cms-sync</Text>
      {site ? <Text> · </Text> : null}
      {site ? (multi && shown ? <Text color={siteColor(ctx, shown)} bold>● {site}</Text> : <Text dimColor>{site}</Text>) : null}
      {title ? <Text> · {title}</Text> : null}
    </Box>
  );
}

/** "Which site?" picker, shown when the config has several projects. */
export function ProjectPicker({ ctx, purpose, onPick, onCancel }: { ctx: Ctx; purpose: string; onPick: (p: string) => void; onCancel: () => void }) {
  const names = ctx.engine!.projectNames;
  return (
    <Box flexDirection="column">
      <Text bold>Which site?</Text>
      <Help>{purpose}</Help>
      <Select items={names.map((n) => ({ label: n.padEnd(16), value: n, hint: ctx.engine!.config.projects[n].label ?? "" }))} onSelect={onPick} onCancel={onCancel} />
      <Keys keys={[["enter", "choose"], ["esc", "back"]]} />
    </Box>
  );
}

/** The selected project: the only one, or null until the person picks. */
export function useProject(ctx: Ctx): [string | null, (p: string | null) => void] {
  const names = ctx.engine?.projectNames ?? [];
  return useState<string | null>(names.length === 1 ? names[0] : ctx.site);
}


export const SECRET_QUERY = /[?&](token|key|api_key|apikey|secret|sig|signature|access_token)=/i;

export function sourceFields(text: string, dir: string, prevType: string): { source: Record<string, unknown>; env?: Record<string, string> } {
  // A pass-through sync that's given a file or URL takes that file's type (unknown → JSON).
  if (prevType === "none") prevType = "json";
  if (/^https?:\/\//i.test(text)) return { source: { type: prevType === "markdown" ? "json" : prevType, url: text } };
  const abs = path.resolve(dir, text);
  const isDir = existsSync(abs) && statSync(abs).isDirectory();
  const type = isDir ? "markdown" : formatFromPath(text) ?? prevType;
  return { source: { type, path: relPath(dir, text) } };
}

export async function validateSource(v: string, dir: string): Promise<string | null> {
  if (!v) return "enter a file, folder or URL";
  if (/^https?:\/\//i.test(v)) {
    try { const r = await fetch(v, { signal: AbortSignal.timeout(15000) }); return r.ok ? null : `the URL answered HTTP ${r.status}`; }
    catch (e) { return `couldn't reach it: ${(e as Error).message}`; }
  }
  return existsSync(path.resolve(dir, v)) ? null : "no such file or folder (paths start from the config folder)";
}

/** The `source:` block to store for a typed path/URL. Secrets in URLs go to .env. */
export function configSource(ctx: Ctx, name: string, text: string, prevType: string): Record<string, unknown> {
  const { source } = sourceFields(text, ctx.dir, prevType);
  const url = source.url as string | undefined;
  if (url && SECRET_QUERY.test(url)) {
    const envName = `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_SOURCE_URL`;
    setEnv(ctx.dir, { [envName]: url });
    return { type: source.type, url: `\${${envName}}` };
  }
  return source;
}

export function saveSource(ctx: Ctx, name: string, text: string, prevType: string) {
  const source = configSource(ctx, name, text, prevType);
  editConfig(ctx.file!, (doc) => {
    setIn(doc, ["syncs", name, "source", "type"], source.type);
    setIn(doc, ["syncs", name, "source", "path"], source.path);
    setIn(doc, ["syncs", name, "source", "url"], source.url);
    // Rows need a key; a former pass-through sync matched by exact slug, so keep doing that.
    if (prevType === "none" && source.type !== "markdown" && !doc.hasIn(["syncs", name, "key"])) setIn(doc, ["syncs", name, "key"], { field: "slug", transform: "none" });
  });
}

export async function discoverColumns(ctx: Ctx, name: string): Promise<string[]> {
  const sync = ctx.engine!.config.syncs[name];
  const loaded = await loadSource(sync, undefined, { baseDir: ctx.dir });
  const keys = new Set<string>();
  for (const r of loaded.records.slice(0, 200)) for (const k of Object.keys(r.data)) keys.add(k);
  return [...keys];
}

