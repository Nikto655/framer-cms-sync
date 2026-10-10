// What kind of data a file name implies. One place, so every interface agrees.

import path from "node:path";

export type FileKind = "csv" | "excel" | "json" | "markdown";

const MARKDOWN = /\.(md|markdown)$/i;

export const isMarkdownFile = (p: string) => MARKDOWN.test(p);

/** The format a file's extension implies, or undefined when it doesn't say. */
export function formatFromPath(p: string): FileKind | undefined {
  if (MARKDOWN.test(p)) return "markdown";
  if (/\.csv$/i.test(p)) return "csv";
  if (/\.xlsx$/i.test(p)) return "excel";
  if (/\.json$/i.test(p)) return "json";
  return undefined;
}

/** A Markdown file's name without its extension: the post's slug when its frontmatter has none. */
export const postName = (p: string) => path.basename(p).replace(MARKDOWN, "");
