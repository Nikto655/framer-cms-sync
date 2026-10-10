import { z } from "zod";

const publishMode = z.enum(["never", "always", "on-change"]);
const level = z.enum(["off", "warn", "error"]);

const lintRule = z.union([
  level,
  z.object({ level: level.default("warn") }).catchall(z.unknown()),
]);

const percentOrCount = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+(\.\d+)?%$/, 'use a number or a percentage like "20%"')]);

/** Names of sites, syncs and tokens: letters, digits, - and _. */
export const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/** Access-token scopes, smallest first. */
export const SCOPES = ["read", "write", "publish", "admin"] as const;

export const projectSchema = z.object({
  url: z.string().min(1, "url is required"),
  apiKey: z.string().min(1, "apiKey is required (use ${FRAMER_API_KEY})"),
  label: z.string().optional(),
  /** Colour for this site in the terminal app: cyan, magenta, yellow, blue, green, red, white (or a #hex). */
  color: z.string().optional(),
});

export const syncSchema = z.object({
  description: z.string().optional(),
  /** Which project (site) this sync writes to. Optional when the config has only one. */
  project: z.string().optional(),
  collection: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    mode: z.enum(["auto", "managed", "unmanaged"]).default("auto"),
    create: z.boolean().default(false),
  }).refine((c) => c.id || c.name, { message: "set collection.id or collection.name" }),
  schemaFrom: z.string().optional(),
  schemaIds: z.enum(["slugify", "keep"]).default("slugify"),
  source: z.object({
    /** "none": no source of its own. Data is only sent in (agents, HTTP, MCP, CLI); nothing is saved locally. */
    type: z.enum(["json", "csv", "excel", "markdown", "none"]),
    /** Excel: which sheet (tab) to read; the first one if not set. */
    sheet: z.string().optional(),
    path: z.string().optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Where the list of records is in a JSON document, as a dotted path, e.g. "data.items". */
    rows: z.string().optional(),
  }),
  key: z.object({
    field: z.string(),
    transform: z.enum(["slugify", "none"]).default("slugify"),
  }).optional(),
  /** Page path prefix for items of this sync, e.g. "/blog/". Used by redirects. */
  path: z.string().optional(),
  fields: z.object({
    map: z.record(z.string(), z.string()).default({}),
    ignore: z.array(z.string()).default([]),
    unknown: z.enum(["warn", "error", "ignore"]).default("warn"),
    nulls: z.enum(["clear", "skip"]).default("clear"),
    alt: z.record(z.string(), z.string()).default({}),
    formattedText: z.enum(["html", "markdown", "auto"]).default("html"),
    /** How to read dates like 10/08/2026: DMY (10 August) or MDY (October 8). Only needed when it's ambiguous. */
    dateOrder: z.enum(["DMY", "MDY"]).optional(),
  }).prefault({}),
  markdown: z.object({
    stripLeadingH1: z.boolean().default(true),
    dedupeThumbnail: z.union([z.string(), z.literal(false)]).default("thumbnail"),
    draftField: z.string().default("published"),
    aliases: z.union([z.enum(["default", "none"]), z.record(z.string(), z.array(z.string()))]).default("default"),
    typographer: z.boolean().default(false),
    linkify: z.boolean().default(false),
  }).prefault({}),
  lint: z.record(z.string(), lintRule).default({}),
  prune: z.union([
    z.literal(false),
    z.object({
      minItems: z.number().int().nonnegative().default(1),
      maxRemove: percentOrCount.default("20%"),
      mode: z.enum(["delete", "draft"]).default("delete"),
    }),
  ]).default(false),
  publish: publishMode.optional(),
  transform: z.string().optional(),
});

export const tokenSchema = z.object({
  name: z.string(),
  token: z.string().min(16, "tokens must be at least 16 characters"),
  scope: z.enum(SCOPES),
  syncs: z.array(z.string()).optional(),
  projects: z.array(z.string()).optional(),
  /** What uses this token, e.g. "Claude (MCP)" or "n8n weekly pricing". */
  description: z.string().optional(),
  created: z.string().optional(),
});

export const configSchema = z.object({
  /** One site. Shorthand for projects: { default: … }. */
  project: projectSchema.optional(),
  /** Several sites, by short name. */
  projects: z.record(z.string().regex(NAME_RE, "project names: letters, digits, - and _"), projectSchema).default({}),
  server: z.object({
    port: z.number().int().default(8080),
    host: z.string().default("127.0.0.1"),
    tokens: z.array(tokenSchema).default([]),
    maxBodyMb: z.number().positive().default(15),
  }).prefault({}),
  defaults: z.object({
    publish: publishMode.default("never"),
    deploy: z.boolean().default(true),
    chunkSize: z.number().int().positive().max(1000).default(100),
    timeoutSeconds: z.number().positive().default(600),
  }).prefault({}),
  syncs: z.record(z.string().regex(NAME_RE, "sync names: letters, digits, - and _"), syncSchema).default({}),
  redirects: z.object({
    allowChains: z.boolean().default(false),
  }).prefault({}),
  plugins: z.array(z.string()).default([]),
  runLog: z.boolean().default(true),
});

export type Config = z.infer<typeof configSchema>;
export type SyncConfig = z.infer<typeof syncSchema>;
export type TokenConfig = z.infer<typeof tokenSchema>;
export type PublishMode = z.infer<typeof publishMode>;
export type Scope = TokenConfig["scope"];

/** Each scope includes everything below it. */
export const hasScope = (have: Scope, need: Scope) => SCOPES.indexOf(have) >= SCOPES.indexOf(need);
