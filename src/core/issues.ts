// Issues (per-record problems) and SyncError (operation-level failures).
// Every issue and error has a stable code and, where possible, a plain-words fix,
// so a person or an agent can act on it without guessing.

export type Level = "error" | "warning";

export interface Issue {
  level: Level;
  code: IssueCode;
  message: string;
  fix?: string;
  record?: string;
  field?: string;
  rule?: string;
}

export const ISSUE_CODES = {
  KEY_MISSING: "The record has no value for the key field, so it can't be identified.",
  SLUG_INVALID: "The slug isn't lowercase words joined by single hyphens.",
  DUPLICATE_KEY: "Two records produce the same slug. The later one wins.",
  DUPLICATE_SLUG_IN_COLLECTION: "Two items in the Framer collection share a slug, so records can't be matched to them.",
  UNKNOWN_KEY: "A record key doesn't match any field in the collection.",
  NUMBER_EMPTY: "A number field was empty. Framer can't store an empty number, so the current value is kept.",
  NUMBER_INVALID: "A number field got a value that isn't a number.",
  BOOLEAN_INVALID: "A boolean field got a value that isn't true/false.",
  DATE_INVALID: "A date field got a value that isn't a date.",
  DATE_AMBIGUOUS: "A date like 10/08/2026 could be day/month or month/day; set fields.dateOrder.",
  ENUM_NO_MATCH: "An option field got a value that isn't one of its options.",
  ENUM_EMPTY: "An option field was empty. Framer can't clear an option field, so the current value is kept.",
  IMAGE_NOT_ABSOLUTE: "Images and files must be full URLs starting with http:// or https://.",
  FIELD_NOT_SETTABLE: "This field type can't be set by the sync (array, divider or unsupported).",
  REQUIRED_FIELD_UNMAPPED: "A required title/body field couldn't be found in the collection.",
  FRONTMATTER_INVALID: "The Markdown frontmatter isn't valid YAML.",
  BODY_EMPTY: "The Markdown body is empty.",
  LINT: "A check failed: a Markdown lint rule, or a redirect check (chains, duplicates, live pages).",
  PRUNE_GUARD: "Pruning was blocked by a safety guard.",
  TRANSFORM_FAILED: "The sync's transform function threw an error.",
} as const;
export type IssueCode = keyof typeof ISSUE_CODES;

export function issue(level: Level, code: IssueCode, message: string, extra: Partial<Issue> = {}): Issue {
  return { level, code, message, ...extra };
}

// Operation-level errors. exitCode is what the CLI exits with.
export const ERROR_CODES = {
  CONFIG_INVALID: { status: 400, exit: 3 },
  CONFIG_NOT_FOUND: { status: 400, exit: 3 },
  AUTH_MISSING: { status: 500, exit: 3 },
  UNAUTHORIZED: { status: 401, exit: 3 },
  FORBIDDEN: { status: 403, exit: 3 },
  SYNC_NOT_FOUND: { status: 404, exit: 3 },
  COLLECTION_NOT_FOUND: { status: 404, exit: 3 },
  COLLECTION_FOREIGN_PLUGIN: { status: 409, exit: 2 },
  COLLECTION_NOT_MANAGED: { status: 409, exit: 2 },
  INPUT_INVALID: { status: 400, exit: 1 },
  NO_INPUT: { status: 400, exit: 1 },
  VALIDATION_FAILED: { status: 422, exit: 1 },
  PLAN_STALE: { status: 409, exit: 2 },
  PLAN_REQUIRED: { status: 428, exit: 2 },
  ITEM_NOT_FOUND: { status: 404, exit: 1 },
  ITEM_EXISTS: { status: 409, exit: 1 },
  SOURCE_FAILED: { status: 502, exit: 4 },
  FRAMER_ERROR: { status: 502, exit: 4 },
  APPLY_PARTIAL: { status: 502, exit: 4 },
  TIMEOUT: { status: 504, exit: 4 },
  INTERNAL_ERROR: { status: 500, exit: 4 },
  NOT_FOUND: { status: 404, exit: 1 },
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

export class SyncError extends Error {
  code: ErrorCode;
  status: number;
  exitCode: number;
  fix?: string;
  details?: unknown;
  constructor(code: ErrorCode, message: string, opts: { fix?: string; details?: unknown } = {}) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    this.status = ERROR_CODES[code].status;
    this.exitCode = ERROR_CODES[code].exit;
    this.fix = opts.fix;
    this.details = opts.details;
  }
  toJSON() {
    return { ok: false, error: { code: this.code, message: this.message, fix: this.fix, details: this.details } };
  }
}

/** Remove anything that looks like a secret from an error message before it's shown or logged. */
export function scrub(text: string, secrets: (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  return out.replace(/(api[_-]?key|token|authorization)(["'\s:=]+)([A-Za-z0-9._\-]{12,})/gi, "$1$2[redacted]");
}
