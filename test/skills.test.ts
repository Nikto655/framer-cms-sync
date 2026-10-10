import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { findSkill, listSkills, readSkill, skillsDir } from "../src/cli/skills.ts";

test("every skill has a SKILL.md whose name matches its folder and a description", () => {
  const skills = listSkills();
  assert.ok(skills.length >= 12);
  for (const s of skills) {
    assert.equal(s.name, path.basename(s.dir));
    assert.match(s.name, /^[a-z0-9-]{1,64}$/);
    assert.ok(s.description.length > 40 && s.description.length <= 1024, `${s.name}: description length`);
  }
});

test("skills are found by full or short name, and references by name", () => {
  assert.equal(findSkill("cli").name, "framer-cms-sync-cli");
  assert.equal(findSkill("framer-cms-sync-mcp").name, "framer-cms-sync-mcp");
  assert.equal(findSkill("overview").name, "framer-cms-sync");
  assert.match(readSkill("cli", "commands").text, /# Command reference/);
  assert.throws(() => findSkill("nope"), /no skill named/);
  assert.throws(() => readSkill("cli", "nope"), /no reference/);
});

test("relative links in the skills folder point at files that exist", () => {
  const root = skillsDir();
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".md") ? [path.join(d, e.name)] : []));
  const broken: string[] = [];
  for (const file of walk(root)) {
    for (const m of readFileSync(file, "utf8").matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split("#")[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      if (!existsSync(path.resolve(path.dirname(file), target))) broken.push(`${path.relative(root, file)} → ${m[1]}`);
    }
  }
  assert.deepEqual(broken, []);
});
