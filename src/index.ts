// Public library API.
export {
  createSync, type Sync, type EngineOptions, type PlanOptions, type ApplyOptions, type PostOptions, type ProjectOption,
  type MappingChange, type MappingReport, type CollectionView,
} from "./engine.ts";
export type { Post, PostFile } from "./core/posts.ts";
export { loadConfig, parseConfig, findConfig } from "./config/load.ts";
export type { Config, SyncConfig } from "./config/schema.ts";
export type { SyncReport } from "./core/report.ts";
export type { Issue, IssueCode, ErrorCode } from "./core/issues.ts";
export { SyncError, ISSUE_CODES, ERROR_CODES } from "./core/issues.ts";
export type { FramerClient, Connector } from "./framer/client.ts";
export { framerConnector } from "./framer/adapter.ts";
export { createMemoryFramer, type MemoryCollection } from "./framer/memory.ts";
export type { SourceInput } from "./sources/index.ts";
export type { LintRule, PostView } from "./lint/rules.ts";
export type { Plugin, Transform } from "./core/runtime.ts";
export { slugify, itemId, fieldId } from "./core/identity.ts";
