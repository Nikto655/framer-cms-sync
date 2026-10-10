// `framer-cms-sync skills [name] [reference]`: list the bundled skills, or print one.
// The skills/ folder ships with the package, next to dist/ (and next to src/ in a checkout).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SyncError } from "../core/issues.ts";

const PREFIX = "framer-cms-sync";

export function skillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(here, "../../skills");
  if (!existsSync(dir)) throw new SyncError("NOT_FOUND", "the skills folder isn't installed with this copy of framer-cms-sync");
  return dir;
}

export interface SkillInfo { name: string; description: string; dir: string; references: string[] }

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  for (const line of m?.[1].split("\n") ?? []) {
    const kv = line.match(/^([a-z_-]+):\s*(.*)$/i);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

export function listSkills(): SkillInfo[] {
  const root = skillsDir();
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, "SKILL.md")))
    .map((d) => {
      const dir = path.join(root, d.name);
      const fm = frontmatter(readFileSync(path.join(dir, "SKILL.md"), "utf8"));
      const refDir = path.join(dir, "references");
      const references = existsSync(refDir) ? readdirSync(refDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")) : [];
      return { name: fm.name ?? d.name, description: fm.description ?? "", dir, references };
    })
    .sort((a, b) => (a.name === PREFIX ? -1 : b.name === PREFIX ? 1 : a.name.localeCompare(b.name)));
}

/** Find a skill by its full name or its short name ("cli" = framer-cms-sync-cli). */
export function findSkill(name: string): SkillInfo {
  const all = listSkills();
  const want = name.toLowerCase();
  const hit = all.find((s) => s.name === want || s.name === `${PREFIX}-${want}` || (want === "overview" && s.name === PREFIX));
  if (!hit) throw new SyncError("NOT_FOUND", `no skill named "${name}"`, { fix: `one of: ${all.map((s) => shortName(s.name)).join(", ")}` });
  return hit;
}

export const shortName = (name: string) => (name === PREFIX ? "overview" : name.replace(`${PREFIX}-`, ""));

/** The text of a skill's SKILL.md, or one of its references. */
export function readSkill(name: string, reference?: string): { skill: SkillInfo; file: string; text: string } {
  const skill = findSkill(name);
  if (reference) {
    const ref = reference.replace(/\.md$/, "");
    if (!skill.references.includes(ref))
      throw new SyncError("NOT_FOUND", `skill "${skill.name}" has no reference "${reference}"`, { fix: skill.references.length ? `one of: ${skill.references.join(", ")}` : "this skill has no references" });
    const file = path.join(skill.dir, "references", `${ref}.md`);
    return { skill, file, text: readFileSync(file, "utf8") };
  }
  const file = path.join(skill.dir, "SKILL.md");
  return { skill, file, text: readFileSync(file, "utf8") };
}
