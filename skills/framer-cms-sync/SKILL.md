---
name: framer-cms-sync
description: Start here for anything involving framer-cms-sync, the tool that keeps Framer CMS collections in sync with Excel/CSV files, Markdown folders, Google Sheets or APIs. Use when asked to add, update or publish CMS content (blog posts, products, prices, listings) on a Framer site, to sync data into Framer, or to set the tool up. Covers the core ideas, the safe workflow, the rules, and which skill to use next.
---

# framer-cms-sync

framer-cms-sync copies data from your own source (an Excel or CSV file, a folder of Markdown files, a Google Sheet, or a URL that returns JSON/CSV) into a Framer CMS collection. You always see a preview first, choose what to apply, and publish only when you decide to.

You can use it through:
- the **terminal app**: `framer-cms-sync` with no arguments
- the **CLI**: `framer-cms-sync <command>`
- the **HTTP API**: `framer-cms-sync serve`
- **MCP**: tools for AI agents

## Core ideas

- **Site**: one Framer project (URL and API key). It has a short name (`blog`) and a display name. With several sites, one is current.
- **Sync**: connects one source of data to one Framer collection, saved in `framer-cms-sync.config.yaml`.
- **Collections come in three kinds:**
  - **regular** (hand-built): filled as it is
  - **managed** (created by this tool): full control, including fields
  - **owned by another plugin**: can't be written to, so the tool makes your own managed copy
- **Everything is matched by slug**, as in Framer. The sync's key column becomes the slug: a known slug updates that item, a new slug becomes a new item.
- **Preview → apply → publish:**
  - a preview changes nothing
  - apply writes to the CMS in the Framer editor; unchanged items aren't written
  - publish puts the **whole site** live, exactly as it is in the editor
- **One way:** data → Framer. Edits made in Framer show up as differences, and applying puts the data's value back. "Download from Framer" (`pull`) is the one way back.

## The workflow

1. **Preview:** `framer-cms-sync plan <sync>` (MCP `plan_sync`). Read what's new, changed, unchanged and in Framer but not in the data.
2. **Fix problems.** Every issue has a `fix`. Fix the **source data**, not Framer, then preview again until there are no errors.
3. **Choose what to apply:**
   - only add new (`--create-only`)
   - only update existing (`--update-only`)
   - add new and update changed (`--partial`)
   - replace all (`--replace`): also removes items whose slug isn't in the data
4. **Publish only if asked.** Add `--publish`, or publish later.

## Rules for agents

- Preview before every apply. Over MCP, `apply_sync` needs the `planId` from `plan_sync` on the same data, with the same options.
- Never choose **replace all**, `--allow-mass-remove` or `setup --force` without the person explicitly asking.
- Never publish unless the person asked to. Publishing ships the whole site.
- Tell the person before applying anything that removes items.
- Never read, print or move `.env`: it holds API keys.
- Fix data problems in the source (the file, folder or sheet), never by editing Framer directly.

## Which skill next

| Task | Skill |
|---|---|
| First setup, adding sites, creating a sync | `framer-cms-sync-setup` |
| Working with a kind of data (Excel, Markdown, Sheets, API), dates, downloads | `framer-cms-sync-sources` |
| Previewing, applying, publishing, pulling Framer edits, deleting | `framer-cms-sync-syncing` |
| A column doesn't match a field | `framer-cms-sync-mapping` |
| Exact commands and options | `framer-cms-sync-cli` |
| Calling it over HTTP | `framer-cms-sync-http` |
| Connecting an agent over MCP | `framer-cms-sync-mcp` |
| Tokens for agents, n8n, scripts | `framer-cms-sync-tokens` |
| Scheduling, n8n, Docker | `framer-cms-sync-automation` |
| A config setting | `framer-cms-sync-config` |
| An error or warning | `framer-cms-sync-troubleshooting` |

The terminal app's screens and keys: [references/terminal-app.md](references/terminal-app.md).
