# Changelog

## 0.1.0

First release.

**Syncing**
- Keep Framer CMS collections in sync with Excel/CSV files, folders of Markdown posts, Google Sheets, JSON or CSV endpoints, or data sent in by agents and apps (pass-through syncs that store nothing locally).
- Managed collections (created and owned by the tool) and unmanaged ones (built by hand in Framer), including taking over an existing collection or making a managed copy of one another plugin owns.
- Everything is matched by slug. Previews compare every field type (text, numbers, dates, options, yes/no, images, rich text) and show old → new values; unchanged items are never rewritten.
- Four ways to apply: only add new, only update existing, add new and update changed, replace all. Removals only happen with the complete data set and are capped per run.
- Single Markdown posts: `add`, `update` and `remove` write straight away and keep the sync's folder in step.
- Download a collection to Excel, CSV, JSON or Markdown, start from a template, or pull Framer's current content back into a sync's file.
- Field mapping with automatic matching, viewable and changeable from the config, CLI, HTTP and MCP; `inspect` shows the shape of any file, folder or URL, including nested JSON.
- Date handling for day/month and month/day formats; ambiguous dates are refused rather than guessed.
- Publishing is always a separate, explicit choice: never, always, or only when something changed.
- Bulk redirects from a CSV, with checks for chains and live pages.

**Interfaces**
- Terminal app with a setup wizard, several sites (named, coloured, switchable), access tokens, previews and settings. Unmanaged collections warn before replacing edits made in Framer.
- Command line with JSON output and stable exit codes.
- HTTP API and MCP (stdio and HTTP) for agents, with scoped access tokens that can be limited to sites or syncs.
- Docker image: the service waits in setup mode on a fresh volume; opening a shell in the container opens the terminal app.
- Guides for people and agents as Agent Skills in `skills/`, also available as `framer-cms-sync skills`.
