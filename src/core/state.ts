// Small per-folder state that isn't configuration: which site is "current".
// Stored in .framer-cms-sync/state.json next to the config (git-ignored), so it's personal.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface LocalState { currentProject?: string }

const file = (configDir: string) => path.join(configDir, ".framer-cms-sync", "state.json");

export function readState(configDir: string): LocalState {
  try { return existsSync(file(configDir)) ? JSON.parse(readFileSync(file(configDir), "utf8")) : {}; } catch { return {}; }
}

export function writeState(configDir: string, patch: LocalState) {
  const p = file(configDir);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ ...readState(configDir), ...patch }, null, 2));
}
