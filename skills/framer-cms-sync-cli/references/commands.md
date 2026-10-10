# Command reference

## Setup and sites

| Command | Does |
|---|---|
| `framer-cms-sync` | open the terminal app (first-time setup if there's no config) |
| `init --name <site> --url <project URL> --key <key>` | create the config and `.env`, check the connection; with an existing config, add another site |
| `init … --key-env <VAR>` | read the key from `.env` / the environment instead of the command line |
| `projects [--check]` | list sites (• = current); `--check` connects to each |
| `projects use <site>` | make a site current |
| `projects rename <site> <new>` | change a site's short name (syncs and tokens follow) |
| `projects label <site> <display name>` | change the name shown for a site |
| `projects remove <site> [--with-syncs] [--delete-files]` | delete a site (and its syncs) from the program; Framer isn't touched |

```bash
framer-cms-sync init --name blog --url https://framer.com/projects/My-Site--abc123 --key-env FRAMER_API_KEY
framer-cms-sync projects remove shop --with-syncs
```

## Collections and syncs

| Command | Does |
|---|---|
| `collections` | every collection in the site, who owns it, writable or not |
| `fields <collection>` | a collection's fields, types and options |
| `syncs` | the syncs in the config |
| `setup <sync> [--force]` | create the sync's collection (`collection.create: true`) and its fields; `--force` replaces a managed collection's fields |
| `check <sync> [input…]` | compare the data with the collection's fields; slug check against `schemaFrom` |
| `syncs remove <sync> [--delete-files]` | delete a sync from the program; Framer isn't touched |

## Data

| Command | Does |
|---|---|
| `inspect <url\|file\|folder\|sync> [--rows <path>] [--header "K: V"]` | format, record location, fields with types and examples, suggested `source:`; one GET, nothing stored |
| `download <collection> <file\|folder> [--format csv\|excel\|json\|markdown] [--overwrite]` | every item, with exact slugs |
| `template <file\|folder> [--from <collection>] [--format …]` | a starter file with one example row |
| `pull <sync>` | replace the sync's file or folder with Framer's items; backup saved first; key set to `slug` |

```bash
framer-cms-sync inspect https://api.example.com/plans --rows data.items
framer-cms-sync download Blog ./posts                 # a folder → Markdown
framer-cms-sync template ./data/team.xlsx --from Team
```

## Previewing and applying

| Command | Does |
|---|---|
| `plan <sync> [input…] [--full]` | preview; writes nothing (`--full`: no list limits in JSON) |
| `apply <sync> [input…] [options]` | write changes |
| `items <sync>` | list items (slug, draft) |

Single Markdown posts. These are written straight away, and the sync's folder is kept in step:

| Command | Does |
|---|---|
| `add <sync> <post.md…> [--publish]` | add new posts; refuses slugs already in Framer; copies the files into the folder |
| `update <sync> <post.md…> [--publish]` | update existing posts by slug; saves over the file holding that slug |
| `add\|update <sync> - [--slug <slug>]` | one post from stdin |
| `remove <sync> <slug\|post.md…> [--keep-file] [--redirect-to <slug>] [--publish]` | delete items (any sync); for Markdown also deletes the file |

`plan` and `apply` options:

| Option | Does |
|---|---|
| `--create-only` | only add new slugs |
| `--update-only` | only update existing items |
| `--partial` | add and update; never remove |
| `--replace` | add, update, and remove slugs not in the data (needs the whole data set) |
| `--publish` · `--no-publish` · `--publish-on-change` | publish afterwards (default: the sync's setting, usually never) |
| `--no-deploy` | publish a preview deployment without going live |
| `--plan-id <id>` | refuse unless it still matches that preview |
| `--limit <n>` · `--only <slug,slug>` | a subset; never removes |
| `--allow-mass-remove` | allow removing more than the safety limit |

```bash
framer-cms-sync apply blog ./posts/new-post.md --partial
cat rows.json | framer-cms-sync apply products - --create-only --json
framer-cms-sync add blog ~/Desktop/kyoto.md --publish
framer-cms-sync apply products --replace --publish
```

## Field mapping

| Command | Does |
|---|---|
| `map <sync>` | each column → field, how it matched, examples, problems |
| `map <sync> <column> <field>` | send a column to a field |
| `map <sync> <column> --ignore` · `--auto` | never send it · back to automatic matching |

## Redirects

| Command | Does |
|---|---|
| `redirects list` | current redirects |
| `redirects plan <file.csv>` | preview a `from,to` CSV (full URLs or paths): adds, updates, problems |
| `redirects apply <file.csv> [--publish]` | apply it (nothing is written if there are errors) |
| `redirects remove <from…>` | remove redirects |

Redirects need a Framer plan that includes them.

## Access tokens

| Command | Does |
|---|---|
| `tokens` | list (never shows values) |
| `tokens add <name> --scope read\|write\|publish\|admin [--description "…"] [--sites a,b] [--syncs x,y]` | create one; the value is shown once |
| `tokens revoke <name>` | revoke; immediate, even on a running server |

## Publishing and other commands

| Command | Does |
|---|---|
| `publish [--no-deploy]` | publish the whole current site as it is |
| `history` | recent runs |
| `describe` | settings, field types, codes and workflow (compact; for agents) |
| `serve [--port <n>] [--host <h>]` | HTTP API and MCP over HTTP |
| `mcp [--scope read\|write\|publish\|admin]` | MCP server on stdio |
| `skills [name]` | list these skills, or print one |

## Global options

| Option | Does |
|---|---|
| `-c, --config <file>` | config file |
| `-p, --project <site>` | which site |
| `--json` | JSON output |
| `-h, --help` · `-v, --version` | help · version |
