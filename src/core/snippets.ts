// Ready-to-copy setup text for a new token: MCP client config, a curl test, n8n settings.

export interface TokenUse { value: string; scope: string; limited: boolean; baseUrl: string; exampleSync?: string }

export function tokenSnippets(u: TokenUse) {
  const sync = u.exampleSync ?? "<sync>";
  const out: { title: string; text: string }[] = [];
  if (!u.limited) {
    out.push({
      title: "AI agent (MCP client config, e.g. Claude Desktop, Claude Code, Cursor)",
      text: JSON.stringify({ mcpServers: { "framer-cms-sync": { type: "http", url: `${u.baseUrl}/mcp`, headers: { "x-sync-token": u.value } } } }, null, 2),
    });
  }
  out.push({
    title: "Test it from a terminal",
    text: `curl -s -H "x-sync-token: ${u.value}" ${u.baseUrl}/syncs`,
  });
  out.push({
    title: "n8n (HTTP Request node)",
    text: [
      `Authentication: Generic Credential Type → Header Auth`,
      `  Name: x-sync-token`,
      `  Value: ${u.value}`,
      `Method: POST   URL: ${u.baseUrl}/syncs/${sync}/${u.scope === "read" ? "plan" : "apply"}`,
    ].join("\n"),
  });
  return out;
}

export const SCOPE_HELP: Record<string, string> = {
  read: "look at collections and syncs, and preview changes; never writes",
  write: "preview and write changes to the CMS, delete items; can't publish",
  publish: "everything write can do, plus publish the site live",
  admin: "everything, including creating collections and overriding safety limits",
};
