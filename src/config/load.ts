// Find, read, interpolate and validate the config file.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchema, type Config } from "./schema.ts";
import { SyncError } from "../core/issues.ts";

export const CONFIG_NAMES = ["framer-cms-sync.config.yaml", "framer-cms-sync.config.yml", "framer-cms-sync.config.json"];

export function findConfig(start = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    for (const n of CONFIG_NAMES) { const p = path.join(dir, n); if (existsSync(p)) return p; }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Load KEY=VALUE pairs from a .env file into process.env (existing values win). */
export function loadDotEnv(dir: string) {
  for (const [k, v] of Object.entries(readDotEnv(dir))) if (process.env[k] === undefined) process.env[k] = v;
}

/** Replace ${VAR} and ${VAR:-default} in every string. Missing vars become "" and are reported. */
export function interpolate(value: unknown, env: NodeJS.ProcessEnv, missing: Set<string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
      const v = env[name];
      if (v !== undefined && v !== "") return v;
      if (def !== undefined) return def;
      missing.add(name);
      return "";
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env, missing));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, missing)]));
  return value;
}

export interface LoadedConfig { config: Config; file: string; dir: string; missingEnv: string[] }

export function parseConfig(raw: unknown, file = "(inline)", env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const missing = new Set<string>();
  const data = interpolate(raw ?? {}, env, missing);
  const res = configSchema.safeParse(data);
  if (!res.success) {
    const lines = res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    const envHint = missing.size ? ` Missing environment variables: ${[...missing].join(", ")}.` : "";
    throw new SyncError("CONFIG_INVALID", `config problems in ${path.basename(file)}:\n  ${lines.join("\n  ")}${envHint ? "\n " + envHint : ""}`,
      { fix: missing.size ? `set ${[...missing].join(", ")} in .env next to the config` : "fix the listed settings", details: res.error.issues });
  }
  const config = res.data;
  // Projects: `project:` is shorthand for one project called "default".
  if (config.project && Object.keys(config.projects).length)
    throw new SyncError("CONFIG_INVALID", "the config has both project: and projects:", { fix: "move project: into projects: under a name, e.g. projects: { main: { url, apiKey } }" });
  if (config.project) { config.projects = { default: config.project }; delete config.project; }
  const projectNames = Object.keys(config.projects);
  if (!projectNames.length)
    throw new SyncError("CONFIG_INVALID", "the config has no project", { fix: "add project: { url, apiKey }, or several under projects:" });
  for (const [name, s] of Object.entries(config.syncs)) {
    if (!s.project) {
      if (projectNames.length > 1)
        throw new SyncError("CONFIG_INVALID", `syncs.${name}.project is required when the config has several projects`, { fix: `add project: <one of ${projectNames.join(", ")}>` });
      s.project = projectNames[0];
    } else if (!config.projects[s.project]) {
      throw new SyncError("CONFIG_INVALID", `syncs.${name}.project "${s.project}" isn't one of the projects`, { fix: `use one of: ${projectNames.join(", ")}` });
    }
  }
  for (const [name, s] of Object.entries(config.syncs)) {
    if (s.source.type !== "markdown" && s.source.type !== "none" && !s.key)
      throw new SyncError("CONFIG_INVALID", `syncs.${name}.key.field is required for ${s.source.type} syncs`, { fix: `add key: { field: "<column that makes each row unique>" }` });
  }
  return { config, file, dir: path.dirname(path.resolve(file)), missingEnv: [...missing] };
}

/** Read a .env file into a map without touching process.env. */
export function readDotEnv(dir: string): Record<string, string> {
  const p = path.join(dir, ".env");
  const out: Record<string, string> = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

/** Re-read the config and .env from disk (the .env file wins over earlier values), for live reloads. */
export function reloadConfig(file: string): LoadedConfig {
  const text = readFileSync(file, "utf8");
  const raw = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  return parseConfig(raw, file, { ...process.env, ...readDotEnv(path.dirname(file)) });
}

export function loadConfig(file?: string): LoadedConfig {
  const p = file ? path.resolve(file) : findConfig();
  if (!p || !existsSync(p))
    throw new SyncError("CONFIG_NOT_FOUND", file ? `config not found: ${file}` : "no framer-cms-sync.config.yaml found here or in any parent folder",
      { fix: "run `framer-cms-sync init`, or pass --config <file>" });
  loadDotEnv(path.dirname(p));
  const text = readFileSync(p, "utf8");
  let raw: unknown;
  try { raw = p.endsWith(".json") ? JSON.parse(text) : parseYaml(text); }
  catch (e) { throw new SyncError("CONFIG_INVALID", `couldn't read ${path.basename(p)}: ${(e as Error).message}`); }
  return parseConfig(raw, p);
}
