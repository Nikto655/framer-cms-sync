---
name: framer-cms-sync-automation
description: Run framer-cms-sync unattended - in Docker, as a long-running service, on a schedule (cron, CI), or behind n8n/Make/Zapier webhooks - with safe defaults for removals and publishing. Use when setting up Docker, scheduled syncs, CI jobs, or n8n workflows.
---

# Automation

There are three common setups:

| Setup | How |
|---|---|
| **Scheduled job** (cron, CI) | `framer-cms-sync apply <sync> --json`, using the sync's configured source |
| **Service** (Docker or `serve`) | apps send data to `POST /syncs/<sync>/apply` with a token |
| **Remote agent** | an MCP client connects to `POST /mcp` (see `framer-cms-sync-mcp`) |

Docker details: [references/docker.md](references/docker.md).

## Scheduled job

```bash
framer-cms-sync apply pricing --json --publish-on-change
```

- **The exit code tells your scheduler what happened** (0 ok, 1 data problem, 2 refused, 3 config, 4 Framer or source). See `framer-cms-sync-cli`.
- **It never prompts** when not in a terminal.
- **Removals still respect the sync's `prune` limits.** A run that would remove too much exits with code 2 rather than going ahead.
- **Keep the key in `.env` or the environment**, never in the config.

To require a preview before every write:

```bash
export FRAMER_CMS_SYNC_REQUIRE_PLAN=1
id=$(framer-cms-sync plan pricing --json | jq -r .planId)
framer-cms-sync apply pricing --plan-id "$id" --json
```

### GitHub Actions

```yaml
on:
  push: { paths: ["data/**"] }
  schedule: [{ cron: "0 6 * * *" }]
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx -y framer-cms-sync apply posts --json --publish-on-change
        env:
          FRAMER_API_KEY: ${{ secrets.FRAMER_API_KEY }}
```

The config is committed and `.env` isn't: secrets come from the environment, which `${VAR}` reads too.

## n8n, Make, Zapier, webhooks

1. **Run the service** with Docker.
2. **Create a token** limited to the sync: `tokens add n8n --scope write --syncs pricing`.
3. **Add an HTTP Request node:** `POST http://framer-cms-sync:8080/syncs/pricing/apply`, header `x-sync-token`, with the items as the JSON body.

n8n item wrappers (`[{ json: {…} }]`) are unwrapped automatically.

**Body data is partial**, so a webhook that sends one new row only adds or updates that row. If the workflow sends the whole data set and removals should follow, add `?complete=true`.

Ready-made workflows are in `examples/n8n/`:
- `scheduled-sync.json`: on a schedule, send rows and apply
- `webhook-proxy.json`: forward a webhook to the service

## Safe defaults

- **Nothing is removed** unless the run has the complete data set and `prune` or `replace` allows it.
- **A large removal is refused** without explicit permission, so a broken export can't empty a collection.
- **Nothing is published** unless asked (`defaults.publish: never`). `on-change` is a good choice for automation.
- **Every run goes in the run log**, so `framer-cms-sync history` shows who did what and when.
