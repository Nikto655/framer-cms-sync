// Lint rules run on parsed Markdown posts. Each rule returns zero or more messages.
// Levels come from the sync config (off | warn | error); plugins can add rules.

export interface PostView {
  file: string;
  frontmatter: Record<string, unknown>;
  body: string; // Markdown, after the leading H1 is removed
  html: string;
}

export interface RuleResult { message: string; fix?: string }
export type LintRule = (post: PostView, options: Record<string, unknown>) => RuleResult[] | RuleResult | string | string[] | null | undefined;

export const BUILTIN_RULES: Record<string, LintRule> = {
  "no-wikilinks": ({ body }) => {
    const hits = [...new Set(body.match(/\[\[[^\]]+\]\]/g) || [])];
    return hits.length ? { message: `unresolved wiki-links: ${hits.slice(0, 5).join(", ")}`, fix: "replace [[links]] with normal Markdown links" } : null;
  },
  "absolute-images": ({ body }) => {
    const md = [...body.matchAll(/!\[[^\]]*\]\((?!https?:\/\/)([^)\s]+)/g)].map((m) => m[1]);
    const html = [...body.matchAll(/<img[^>]+src="(?!https?:\/\/)([^"]+)"/g)].map((m) => m[1]);
    const all = [...md, ...html];
    return all.length ? { message: `images must use full URLs: ${all.slice(0, 3).join(", ")}`, fix: "upload images somewhere public and use their https:// address" } : null;
  },
  "no-placeholders": ({ body }) => {
    const m = body.match(/\b(PLACEHOLDER|TODO|TBC|TK|XXX)\b/);
    return m ? { message: `body contains "${m[1]}"`, fix: "finish or remove the placeholder" } : null;
  },
  "no-em-dash": ({ body }) => {
    const n = (body.match(/—/g) || []).length;
    return n ? { message: `${n} em dash${n === 1 ? "" : "es"} in body`, fix: "use a comma, colon or full stop instead" } : null;
  },
  "max-length": ({ frontmatter }, opts) => {
    const out: RuleResult[] = [];
    for (const [k, max] of Object.entries(opts)) {
      if (k === "level" || typeof max !== "number") continue;
      const v = frontmatter[k];
      if (v != null && String(v).length > max) out.push({ message: `${k} is ${String(v).length} characters (aim for ${max} or fewer)`, fix: `shorten ${k}` });
    }
    return out;
  },
  required: ({ frontmatter }, opts) => {
    const keys = Array.isArray(opts.keys) ? opts.keys.map(String) : [];
    const missing = keys.filter((k) => frontmatter[k] === undefined || frontmatter[k] === null || frontmatter[k] === "");
    return missing.length ? { message: `missing ${missing.join(", ")}`, fix: `add ${missing.join(", ")} to the frontmatter` } : null;
  },
};

/** Applied to Markdown syncs unless the config overrides them. */
export const DEFAULT_MARKDOWN_LINT: Record<string, "off" | "warn" | "error"> = {
  "no-wikilinks": "error",
  "absolute-images": "error",
  "no-placeholders": "warn",
};

export function normaliseResults(r: ReturnType<LintRule>): RuleResult[] {
  if (!r) return [];
  const arr = Array.isArray(r) ? r : [r];
  return arr.map((x) => (typeof x === "string" ? { message: x } : x)).filter((x) => x && x.message);
}
