---
name: framer-cms-sync-syncing
description: Preview and apply framer-cms-sync syncs - the four apply choices (only add new, only update existing, add new and update changed, replace all), publishing, removals and their safety limits, bringing edits made in Framer back into the file (pull / Download from Framer), adding, updating or removing a single Markdown post (add / update / remove), and deleting syncs or sites from the program. Use when asked to sync, publish, add or update items, remove items, or when a preview looks wrong.
---

# Syncing and publishing

## Preview

```bash
framer-cms-sync plan <sync>        # MCP: plan_sync · HTTP: POST /syncs/<sync>/plan
```

It changes nothing. It shows:
- **new:** slugs not in Framer yet
- **to update:** items that changed, with old → new values per field
- **unchanged**
- **in Framer but not in your data:** what "replace all" would remove
- **problems:** errors block the apply and warnings don't; each comes with a fix

Every field type is compared: text, numbers, dates, options, yes/no, image URLs, and rich text. Rich text is compared by its content, so formatting Framer adds when storing it doesn't count as a change. Unchanged items are never rewritten.

## The four apply choices

Everything is matched by slug.

| Choice | CLI | HTTP / MCP | Does |
|---|---|---|---|
| Only add new | `--create-only` | `createOnly` | adds new slugs; existing items untouched |
| Only update existing | `--update-only` | `updateOnly` | updates changed items; new slugs left out |
| Add new and update changed | `--partial` | `partial` | both; never removes |
| Replace all | `--replace` | `replace` | both, and **removes items whose slug isn't in the data** |

In the terminal app: open the sync, press `a`, choose, choose whether to publish, then confirm. The confirmation names everything that will be removed.

**Defaults when you choose nothing:**
- The CLI with the sync's own source adds and updates, and removes only if the sync has `prune` on.
- Data sent over HTTP or MCP is **partial** unless the request says `complete=true` or `replace=true`.

## Removals are guarded

Items are only removed by **replace all**, or by a sync with `prune` on. Even then:
1. **Only with the complete data set:** never for a single post, data sent in, `--partial`, `--limit` or `--only`.
2. **Only if the data has at least `prune.minItems` records** (default 1).
3. **Never more than `prune.maxRemove`** (default 20%) in one run without explicit confirmation (`--allow-mass-remove`). The terminal app asks in its confirmation instead.

## Publishing

- **Applying** changes the CMS in the Framer editor. Your live site is unchanged.
- **Publishing** puts **the whole site** live as it is in the editor right now: every page, every collection, and unpublished changes by anyone.

You can publish in several ways:
- `apply … --publish`
- `framer-cms-sync publish`
- "Yes, publish" in the app's apply flow, or `p` on the home screen
- MCP `publish_site`

`--publish-on-change` publishes only if the apply changed something, and `--no-deploy` makes a preview deployment without going live.

## Bringing Framer edits back

Syncing only goes from your data into Framer. If someone edits an item in Framer, the preview shows a difference, and applying would put your data's value back.

Unmanaged collections are the ones people edit in Framer, so the tool warns about this:
- **In the terminal app:** choosing an apply that updates items shows a warning with the affected items. You must choose "Replace with my data", "Download from Framer first" (opens Settings) or "Go back".
- **In the CLI:** `plan` prints the same warning.

To keep the Framer edit:

```bash
framer-cms-sync pull <sync>        # or Settings → Download from Framer
```

This:
- replaces the sync's file or folder with every item in Framer, in the same format
- saves the previous version next to it first (`….before-download-<date>…`)
- sets the key to exact slugs

The next preview shows no changes. It isn't available for Google Sheets or endpoints, since the tool can't write to them.

## Single Markdown posts

For a Markdown sync, add, update or remove one post at a time. It's written to Framer straight away (no preview step), nothing else in the collection is touched, and the sync's folder is kept in step, so the next full sync doesn't undo it.

```bash
framer-cms-sync add blog ~/Desktop/new-post.md          # new post; copied into the folder too
framer-cms-sync update blog ./posts/new-post.md         # existing post, matched by slug
framer-cms-sync remove blog new-post                    # from Framer, and its file from the folder
framer-cms-sync add blog ./draft.md --publish           # and put the site live
```

- **`add` refuses a slug that's already in Framer**, and **`update` refuses one that isn't.** Each error names the other command.
- **The slug** comes from the frontmatter `slug:`, or the file name.
- **Updating saves over the file that already holds that slug**, even if its file name is different.
- **`remove --keep-file`** leaves the file in place. `--redirect-to <slug>` redirects the old page.
- **A post with errors writes nothing**, in Framer or in the folder.
- **HTTP:** `POST /syncs/<sync>/items` adds, `PUT /syncs/<sync>/items` updates, and `DELETE /syncs/<sync>/items/<slug>` removes. The body is Markdown text (slug in `?slug=` or the frontmatter) or `{ "slug", "markdown" }`.
- **MCP:** `add_posts`, `update_posts`, `remove_item`.

These are for Markdown syncs only. For a spreadsheet, edit the file and run `apply <sync> --partial`.

## Deleting from the program

```bash
framer-cms-sync syncs remove <sync> [--delete-files]
framer-cms-sync projects remove <site> --with-syncs [--delete-files]
```

In the app: Settings → Delete this sync, or Sites → `x`.

- **Removed:** the sync's or site's settings, secrets saved for it in `.env`, and access tokens limited to it.
- **Source files are kept** unless you choose otherwise, and only files inside the project folder are ever deleted.
- **Deleting the last site** resets the app to first-time setup.
- **Framer is never changed.**

## Other operations

```bash
framer-cms-sync items <sync>                                   # slugs in the collection
framer-cms-sync remove <sync> <slug> --redirect-to <slug>      # delete one item (any sync), redirect its page
framer-cms-sync redirects plan ./redirects.csv                 # from,to; then `redirects apply`
framer-cms-sync history                                        # what ran, who ran it, what changed
```
