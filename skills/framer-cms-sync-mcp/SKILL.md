---
name: framer-cms-sync-mcp
description: Connect an AI agent (Claude Code, Claude Desktop, Cursor or any MCP client) to framer-cms-sync over MCP - stdio or HTTP setup, which tools each scope gets, and the preview → apply → publish rules an agent must follow. Use when wiring up MCP, when a tool is missing, or when acting as the agent driving a sync.
---

# MCP

There are two ways to connect. Both offer the same tools.

## Local: stdio

The agent runs the tool on the same machine:

```json
{
  "mcpServers": {
    "framer-cms-sync": {
      "command": "npx",
      "args": ["-y", "framer-cms-sync", "mcp", "--scope", "write",
               "--config", "/absolute/path/to/framer-cms-sync.config.yaml"]
    }
  }
}
```

- **No token is needed:** whoever can start the process can already read the config.
- **`--scope` sets what the agent may do**, and defaults to `write`.

Claude Code:

```bash
claude mcp add framer-cms-sync -- npx -y framer-cms-sync mcp --scope write --config /abs/path/framer-cms-sync.config.yaml
```

## Remote: HTTP

The service is running (`serve`, or Docker), and the agent connects to `POST /mcp`:

```json
{
  "mcpServers": {
    "framer-cms-sync": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

- **The token's scope decides which tools appear.**
- **The token must not be limited to particular sites or syncs.** Make a separate token for MCP (see `framer-cms-sync-tokens`).
- **`tokens add` prints a ready-made snippet** for this.

## Tools by scope

| Scope | Tools |
|---|---|
| read | `list_projects`, `list_collections`, `get_fields`, `list_syncs`, `list_items`, `check_sync`, `get_mappings`, `inspect_source`, `plan_sync`, `plan_redirects`, `describe` |
| write | adds `apply_sync`, `add_posts`, `update_posts`, `remove_item`, `set_mappings`, `apply_redirects` |
| publish | adds `publish_site`, and `publish` on `apply_sync` |
| admin | adds `setup_collection`, `allowMassRemove`, and `inspect_source` with any `url` |

There's also a resource, `framer-cms-sync://describe`, with the same content as `describe`.

**Input:** `plan_sync`, `apply_sync` and `check_sync` take `sync`, plus one of:
- `records`: JSON
- `text`: CSV or Markdown
- `files`: paths, local only
- nothing, to use the sync's own source

They also take the run options `complete`, `partial`, `createOnly`, `updateOnly` and `replace` (see `framer-cms-sync-syncing`).

## Rules for agents

1. **Preview first.** Call `plan_sync` and read `issues`. Errors block the apply, and each one has a `fix`.
2. **Fix and preview again.** Fix the data, or the mapping with `set_mappings`, then preview again.
3. **Apply with the planId.** Call `apply_sync` with the `planId` from the latest plan, using the same input and options. `apply_sync` refuses without it (`PLAN_REQUIRED`), or if anything changed since (`PLAN_STALE`). Then preview again.
4. **Single Markdown posts skip the preview.** `add_posts` and `update_posts` write straight away. They only touch the posts given, and refuse a slug that exists (add) or doesn't (update). `remove_item` deletes the file too.
5. **Data you pass is partial.** It never removes anything unless you set `complete` or `replace`. Only set those when you're passing the whole data set and the person wants missing items removed.
6. **Publish only when the person asked.** Publishing ships the whole site, not just this collection.
7. **Never pass `allowMassRemove` without the person's explicit go-ahead.** The same goes for anything that removes many items.
8. **Report back to the person:** what was added, updated and removed, and whether the site was published.
