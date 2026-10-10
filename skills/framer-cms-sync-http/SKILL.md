---
name: framer-cms-sync-http
description: Call framer-cms-sync over HTTP - starting the service, authenticating with a token, request bodies (JSON, CSV, Markdown), every route and the scope it needs, and partial vs complete data. Use when integrating with n8n, Make, Zapier, webhooks, scripts or any app over HTTP.
---

# HTTP API

```bash
framer-cms-sync serve                  # http://127.0.0.1:8080 (port and host in server: in the config)
```

The service:
- **won't serve anything without at least one access token** (see `framer-cms-sync-tokens`)
- **on a fresh Docker volume, waits in setup mode** until one exists (see `framer-cms-sync-automation`)
- **picks up config changes, including new tokens, without a restart**

## Authenticating

Send the token in `x-sync-token: <token>`, or `Authorization: Bearer <token>`.

## Bodies

| Content | Example |
|---|---|
| JSON records | `[{"Name":"Pro","Price":21}]` or `{"rows":[…]}` (n8n items are unwrapped) |
| CSV text | header row, then rows (`content-type: text/csv`) |
| Markdown | raw text, `{"markdown":"…"}` or `{"posts":[{"slug":"…","markdown":"…"}]}` |
| empty | uses the sync's configured source (file, folder or URL) |

**Data in the body is partial by default:** it adds and updates but never removes. Add `?complete=true` if it's the whole data set and items missing from it may be removed, or `?replace=true` to replace all. With an empty body, the sync's own source counts as complete.

## Routes

| Route | Scope |
|---|---|
| `GET /health` | none |
| `POST /mcp` | MCP over HTTP; tools follow the token's scope |
| `GET /projects` · `GET /collections?project=` · `GET /collections/:id/fields?project=` · `GET /syncs` | read |
| `POST /syncs/:sync/plan` | read |
| `GET\|POST /syncs/:sync/check` · `GET /syncs/:sync/items` · `GET /syncs/:sync/mappings` | read |
| `GET /syncs/:sync/inspect` (its source) · `POST /syncs/:sync/inspect` · `POST /inspect` (data in the body) | read |
| `POST /inspect?url=…` (any URL) | admin |
| `POST /syncs/:sync/apply` | write (publish if publishing; admin for `allowMassRemove`) |
| `POST /syncs/:sync/mappings` | write |
| `POST /syncs/:sync/items` · `PUT /syncs/:sync/items` (add · update Markdown posts; `?slug=&publish=`) | write (publish if publishing) |
| `DELETE /syncs/:sync/items/:slug?redirectTo=&publish=&keepFile=` | write |
| `GET /redirects` · `POST /redirects/plan` | read |
| `POST /redirects/apply?publish=` · `POST /redirects/remove` | write |
| `POST /publish?project=&deploy=false` | publish |
| `POST /syncs/:sync/setup?force=` | admin |

`apply` query options:

| Option | Does |
|---|---|
| `createOnly=true` · `updateOnly=true` · `replace=true` | what to apply (otherwise add and update) |
| `complete=true` · `partial=true` | whether body data is the whole set |
| `publish=true\|false\|on-change` · `deploy=false` | publishing |
| `planId=` | refuse unless it still matches that preview |
| `limit=` · `only=a,b` | a subset |
| `allowMassRemove=true` | allow a large removal (admin) |

## Examples

```bash
T=<token>
curl -s -H "x-sync-token: $T" http://127.0.0.1:8080/syncs
curl -s -H "x-sync-token: $T" -H "content-type: application/json" \
  -d '[{"Name":"Pro","Price":21}]' "http://127.0.0.1:8080/syncs/pricing/plan"
curl -s -H "x-sync-token: $T" -H "content-type: text/csv" --data-binary @prices.csv \
  "http://127.0.0.1:8080/syncs/pricing/apply?complete=true&publish=on-change"
```

## Single Markdown posts

```bash
curl -s -H "x-sync-token: $T" -H "content-type: text/markdown" --data-binary @kyoto.md \
  "http://127.0.0.1:8080/syncs/blog/items?slug=kyoto"                       # add
curl -s -X PUT -H "x-sync-token: $T" -H "content-type: application/json" \
  -d '{"slug":"kyoto","markdown":"---\ntitle: Kyoto\n---\nBody"}' http://127.0.0.1:8080/syncs/blog/items   # update
curl -s -X DELETE -H "x-sync-token: $T" http://127.0.0.1:8080/syncs/blog/items/kyoto     # remove
```

These are written straight away. Adding an existing slug gives 409 (`ITEM_EXISTS`), and updating a missing one gives 404. The post is saved in, or deleted from, the sync's folder on the server.

## Responses

- **Previews and applies** return the same report as `plan --json`: `items` (create, update, unchanged, missing…), `issues` (errors and warnings, each with a `fix`), `planId`, `applied` and `publish`.
- **Errors** look like `{ "ok": false, "error": { "code", "message", "fix" } }`, with these statuses:
  - 400: bad input
  - 401: no or wrong token
  - 403: scope too small
  - 404: not found
  - 409: refused or conflict
  - 428: a planId is required
  - 422: validation failed
  - 502: Framer or source error

Codes are explained in `framer-cms-sync-troubleshooting`.
