---
name: framer-cms-sync-cli
description: Use the framer-cms-sync command line - running commands, output as JSON, exit codes, and the full list of commands and options. Use when a task needs an exact command (plan, apply, inspect, download, pull, map, tokens, projects, redirects, publish, serve, mcp) or when scripting the tool.
---

# Command line

```bash
framer-cms-sync                      # terminal app (interactive terminals)
framer-cms-sync <command> [options]
framer-cms-sync --help               # short list of commands
```

The full reference, with every option and example: [references/commands.md](references/commands.md).

## Most used

```bash
framer-cms-sync plan blog                       # preview; writes nothing
framer-cms-sync apply blog --partial            # add new and update changed
framer-cms-sync apply blog --create-only        # only add new
framer-cms-sync apply blog --update-only        # only update existing
framer-cms-sync apply blog --replace            # replace all (removes slugs not in the data)
framer-cms-sync apply blog --partial --publish
framer-cms-sync add blog ./post.md              # one Markdown post, straight away
framer-cms-sync update blog ./post.md           # one existing post
framer-cms-sync remove blog old-post            # one item (and its file)
framer-cms-sync inspect <url|file|folder|sync>  # what data looks like
framer-cms-sync pull blog                       # bring Framer's items into the sync's file (backup kept)
framer-cms-sync projects use shop               # switch site
```

## Conventions

- **Input** for `plan`, `apply`, `check` and `inspect` is files, folders, globs, or `-` for stdin. Without input, the sync's configured source is used.
- **Output** is human-readable in a terminal, and JSON when piped or with `--json`. Scripts and agents should use `--json`.
- **`-p, --project <site>`** picks a site for site-wide commands (collections, fields, redirects, publish, download). It's only needed with several sites and no current one.
- **`-c, --config <file>`** uses a specific config; by default the tool searches upward for `framer-cms-sync.config.yaml`.
- **No prompts** when not in a terminal, so it's safe for scripts, CI and agents.

## Exit codes

| Code | Meaning | Do |
|---|---|---|
| `0` | ok | |
| `1` | validation failed | fix the data (each issue has a fix), run again |
| `2` | refused by a safety guard | check the message; usually needs the person's go-ahead |
| `3` | config or auth problem | check the config, `.env`, the key |
| `4` | Framer or source error | check the connection or URL; retrying is safe |

## Guarding writes with a plan id

`plan` returns a `planId`. `apply --plan-id <id>` refuses if the data or the collection changed since, so what you previewed is exactly what gets written. Set `FRAMER_CMS_SYNC_REQUIRE_PLAN=1` to require it for non-interactive use.
