import { createHash } from "node:crypto";

/** Lowercase, non-alphanumerics -> "-", trimmed. Same rule as the original framer-sync. */
export const slugify = (s: unknown): string =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Framer item ids are capped at 64 characters; slugs are not. Short slugs are their own id.
 * Longer ones get a stable id: the first 55 characters plus 8 hex characters of SHA-1(slug).
 */
export const itemId = (slug: string): string =>
  slug.length <= 64
    ? slug
    : `${slug.slice(0, 55).replace(/-+$/, "")}-${createHash("sha1").update(slug).digest("hex").slice(0, 8)}`;

/** Field id scheme for managed collections: $->usd, €->eur, non-alnum->_, f_ prefix, 64 chars max. */
export const fieldId = (name: string): string => {
  let id = String(name).toLowerCase().replace(/\$/g, "usd").replace(/€/g, "eur")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(id)) id = "f_" + id;
  return id.slice(0, 64);
};

/** Lowercase, alphanumerics only. Used for loose name matching. */
export const norm = (s: unknown): string => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

export function keyToSlug(value: unknown, transform: "slugify" | "none"): string {
  if (value === undefined || value === null) return "";
  return transform === "slugify" ? slugify(value) : String(value).trim();
}
