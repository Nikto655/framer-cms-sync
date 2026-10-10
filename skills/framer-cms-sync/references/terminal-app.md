# Terminal app: screens and keys

Run `framer-cms-sync` with no arguments in a terminal (in Docker: `docker exec -it <container> sh` opens it straight away). Every screen explains itself, and each action shows the equivalent CLI command.

## Home

Your syncs for the current site. With several sites, a switcher bar across the top shows each site in its own colour.

| Key | Does |
|---|---|
| `enter` | open the highlighted sync (its preview) |
| `n` | new sync (the wizard) |
| `tab` | next site (with several sites) |
| `w` | Sites screen |
| `t` | Access tokens screen |
| `a` | add a site |
| `r` | redirects |
| `c` | collections and their fields |
| `h` | history of runs |
| `p` | publish the current site |
| `q` | quit |

## New sync (wizard)

**Collection → Data source → Connect → Review**, with a progress bar. `esc` goes back one step. Nothing is written until you confirm the review. Details: `framer-cms-sync-setup`.

## Sync preview

Shows counts (new, to update, to remove, unchanged), changes with old → new values, items in Framer but not in the data, and problems with fixes.

| Key | Does |
|---|---|
| `a` | apply: choose what to do, then whether to publish, then confirm. For an unmanaged collection, updating items first shows a warning that edits made in Framer will be replaced, with the option to download from Framer first |
| `r` | preview again |
| `s` | settings |
| `esc` | home |

A pass-through sync (data sent in, nothing stored locally) has no preview. Opening it shows the items in its collection and how to send data.

## Sync settings

| Setting | Does |
|---|---|
| Source | change the file, folder or URL (checked as you enter it; secrets in URLs move to `.env`) |
| Collection | point the sync at another collection |
| Key column | the column that identifies each item (becomes the slug) |
| Publish | default after applying: never, on change, always |
| Remove missing | always remove items not in the data (usually "Replace all" is used when needed instead) |
| Page path | URL prefix of these pages, e.g. `/blog/` (for redirects) |
| Delete this sync | remove it from the program; asks about source files; Framer isn't touched |
| Download from Framer | replace the sync's file or folder with Framer's items (backup kept) |

## Sites (`w`)

| Key | Does |
|---|---|
| `enter` | switch to the highlighted site |
| `r` | rename its short name (syncs follow) |
| `l` | change its display name |
| `a` | add a site |
| `x` | delete it and its syncs from the program (asks about source files; Framer isn't touched) |
| `c` | check each site's connection |

## Access tokens (`t`)

`n` creates a token: choose what will use it, optionally limit it, and see it once with ready-to-copy setup. `enter` shows details; `x` revokes. Details: `framer-cms-sync-tokens`.

## Collections, redirects, history

- **Collections (`c`):** every collection with what the tool can do with it; `enter` shows its fields.
- **Redirects (`r`):** import a `from,to` CSV, preview, apply.
- **History (`h`):** recent runs, who ran them (`cli`, `tui`, or the access token's name), and what changed.
