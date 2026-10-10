// Human-readable output for the CLI. (--json prints the raw report instead.)

import type { SyncReport } from "../core/report.ts";
import type { Issue } from "../core/issues.ts";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = c(1), dim = c(2), red = c(31), green = c(32), yellow = c(33), cyan = c(36);

const fmtVal = (v: unknown) => (v === null || v === undefined || v === "" ? dim("(empty)") : typeof v === "string" ? v : JSON.stringify(v));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function list(label: string, items: string[], color: (s: string) => string, max = 12) {
  if (!items.length) return [];
  const shown = items.slice(0, max).join(", ");
  return [`  ${color(label)} ${shown}${items.length > max ? dim(` … +${items.length - max} more`) : ""}`];
}

export function formatIssues(issues: { errors: Issue[]; warnings: Issue[] }, max = 20): string[] {
  const out: string[] = [];
  const block = (arr: Issue[], icon: string, color: (s: string) => string, word: string) => {
    if (!arr.length) return;
    out.push("", `  ${color(`${icon} ${plural(arr.length, word)}`)}`);
    for (const i of arr.slice(0, max)) {
      out.push(`    ${i.message}`);
      if (i.fix) out.push(`      ${dim("fix:")} ${i.fix}`);
    }
    if (arr.length > max) out.push(dim(`    … ${arr.length - max} more (use --json for all)`));
  };
  block(issues.errors, "✗", red, "error");
  block(issues.warnings, "⚠", yellow, "warning");
  return out;
}

export function formatReport(r: SyncReport): string {
  const it = r.items;
  const head = r.operation === "plan" ? dim("preview, nothing written") : r.applied ? green("applied") : red("not applied");
  const out = [
    `${bold(r.sync)} → "${r.collection.name}"  ${dim(`(${r.mode})`)}  ${head}`,
    `  ${r.source.records} record${r.source.records === 1 ? "" : "s"} from ${r.source.from === "url" ? "the URL" : r.source.from}  ${dim(`· ${r.run.description}`)}`,
    `  ${green(`${it.create.length} to create`)} · ${cyan(`${it.update.length} to update`)} · ${it.unchanged} unchanged` +
      (it.unverified.length ? ` · ${it.unverified.length} rewritten (images/rich text can't be compared)` : "") +
      ` · ${it.remove.length ? red(`${it.remove.length} to remove`) : "0 to remove"}` +
      (it.skipped.length ? ` · ${it.skipped.length} existing left alone` : "") +
      (it.skippedNew.length ? ` · ${it.skippedNew.length} new left out` : ""),
  ];
  if (r.prune.mode === "draft" && it.remove.length) out[out.length - 1] += dim(" (as drafts)");
  out.push(...list("create:", it.create, green));
  if (it.update.length) {
    out.push(`  ${cyan("update:")}`);
    for (const u of it.update.slice(0, 15)) {
      for (const [n, ch] of u.changes.slice(0, 4).entries())
        out.push(`    ${n === 0 ? u.slug.padEnd(24) : " ".repeat(24)} ${ch.field}: ${fmtVal(ch.from)} → ${fmtVal(ch.to)}`);
      if (u.changes.length > 4) out.push(`    ${" ".repeat(24)} ${dim(`… ${u.changes.length - 4} more fields`)}`);
    }
    if (it.update.length > 15) out.push(dim(`    … ${it.update.length - 15} more items`));
  }
  if (r.mode === "unmanaged" && it.update.length && r.operation === "plan")
    out.push(yellow(`  ⚠ applying replaces these items in Framer with your data; edits made in the Framer editor are lost.`) +
      dim(`\n    To keep them, run \`framer-cms-sync pull ${r.sync}\` first (or Settings → Download from Framer).`));
  out.push(...list("remove:", it.remove, red));
  if (it.missing.length && !it.remove.length) out.push(dim(`  ${it.missing.length} in Framer but not in your data (kept; --replace would remove them): ${it.missing.slice(0, 6).join(", ")}${it.missing.length > 6 ? " …" : ""}`));
  out.push(...formatIssues(r.issues));
  if (r.applied) out.push("", green(`  ✓ ${plural(r.applied.upserted, "item")} written` + (r.applied.removed ? `, ${r.applied.removed} removed` : "") + (r.applied.drafted ? `, ${r.applied.drafted} set to draft` : "")) + (r.publish ? "" : dim("   (site not published)")));
  if (r.publish) out.push(green(`  ✓ published${r.publish.deployed ? " and deployed" : " (preview only)"} → ${r.publish.hostnames.join(", ") || r.publish.deploymentId}`), dim(`    note: ${r.publish.note}`));
  if (r.operation === "plan") {
    const errs = r.issues.errors.length;
    out.push("", errs ? dim(`  fix the errors above, then plan again`) : dim(`  planId ${r.planId} · to write: framer-cms-sync apply ${r.sync} --plan-id ${r.planId}`));
  }
  return out.join("\n");
}

const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visible(s)));

export function table(rows: Record<string, unknown>[], cols: string[]): string {
  if (!rows.length) return dim("(none)");
  const w = cols.map((k) => Math.max(k.length, ...rows.map((r) => visible(String(r[k] ?? "")))));
  const line = (vals: string[]) => vals.map((v, i) => (i === vals.length - 1 ? v : pad(v, w[i]))).join("  ");
  return [bold(line(cols.map((k) => k.toUpperCase()))), ...rows.map((r) => line(cols.map((k) => String(r[k] ?? ""))))].join("\n");
}
