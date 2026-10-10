---
name: framer-cms-sync-tokens
description: Create, scope, limit, list and revoke framer-cms-sync access tokens for the HTTP API and MCP over HTTP - which scope to choose, limiting a token to sites or syncs, where values are stored. Use when connecting n8n, a webhook, a script or a remote agent, or when a request gets 401/403.
---

# Access tokens

Tokens let apps and agents use the HTTP API and MCP over HTTP. Each one has:
- **a name**
- **a scope**
- **optionally, a list of sites or syncs** it's limited to

Make one token per thing that connects. That way you can see what's used where and revoke one without breaking the others.

The local CLI, the terminal app and stdio MCP don't use tokens.

## Scopes

Each scope includes everything below it.

| Scope | Can |
|---|---|
| `read` | list, inspect, check, preview |
| `write` | also apply, change mappings, remove items, redirects |
| `publish` | also publish the site |
| `admin` | also create collections, allow large removals, inspect any URL |

Pick the smallest scope that works:
- **`write`** for a scheduled sync
- **`publish`** if it should also go live
- **`read`** for a dashboard

## Create

```bash
framer-cms-sync tokens add n8n-pricing --scope write --description "n8n weekly pricing" --syncs pricing
framer-cms-sync tokens add claude --scope write --description "Claude (MCP)"
```

You can also use the terminal app: Tokens → New token. It walks through name, scope and limits.

- **The value is shown once, with ready-to-paste snippets** (curl, n8n header, MCP config).
- **The value goes into `.env`** as `SYNC_TOKEN_<NAME>`, and the config refers to it as `${…}`, so the config never contains a secret.

Limits:
- **`--sites a,b`** and **`--syncs x,y`** restrict a token.
- **A limited token can't be used for MCP over HTTP**, so give MCP its own unlimited token with the scope it needs.

## List and revoke

```bash
framer-cms-sync tokens                  # name, scope, limits, what uses it, created (never values)
framer-cms-sync tokens revoke n8n-pricing
```

- **Revoking takes effect immediately**, even on a running server or in Docker.
- **New tokens work without a restart.**
- **Deleting a sync or site also revokes tokens limited to only it.**

## Using a token

Send it in either header:

```
x-sync-token: <token>
Authorization: Bearer <token>
```

| Status | Means |
|---|---|
| 401 | no token or wrong token |
| 403 | the scope is too small, or the token isn't allowed this site or sync; the message says which |
