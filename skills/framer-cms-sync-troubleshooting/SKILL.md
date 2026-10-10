---
name: framer-cms-sync-troubleshooting
description: Diagnose framer-cms-sync problems - previews that look wrong, validation errors, refused applies, connection and token failures - with what each issue or error code means and how to fix it. Use when a command fails, an exit code isn't 0, a preview shows unexpected updates or removals, or an issue code needs explaining.
---

# Troubleshooting

Every problem comes with a **code** and usually a **fix**. Start there. Every code is listed in [references/error-codes.md](references/error-codes.md).

There are two kinds:
- **Issues** are per record, and appear in previews. Errors block the apply, warnings don't.
- **Errors** stop the whole operation. They come with an exit code in the CLI, or an HTTP status.

## Common situations

**Everything shows as "to update" every time**
- Open one item in the preview and look at the old → new values per field.
- If they look identical, the difference is in formatting. Report it as a bug, with the field type.
- If someone edited it in Framer, use `pull` to keep their edits (see `framer-cms-sync-syncing`).

**Duplicates appeared**
- Items are matched by slug. Check the key column produces the exact slugs Framer has.
- `framer-cms-sync items <sync>` lists them.
- Set `key.transform: none` if your slugs are already exact.

**"doesn't match any field" (`UNKNOWN_KEY`)**
- Run `framer-cms-sync map <sync>`, then map or ignore the column (see `framer-cms-sync-mapping`).

**Dates rejected (`DATE_AMBIGUOUS`)**
- Set `fields.dateOrder: DMY` or `MDY`, or use `2026-08-10`.

**Images rejected**
- Images need full `https://` URLs. Upload them somewhere public first.

**Apply refused (exit 2)**
- **`PRUNE_GUARD`:** the run would remove more than `prune.maxRemove`, or the data is smaller than `minItems`. Check the data isn't truncated, then confirm with the person and use `--allow-mass-remove`.
- **`PLAN_STALE`:** something changed since the preview. Preview again.
- **`COLLECTION_FOREIGN_PLUGIN`:** another plugin owns that collection. Use a different collection.

**Can't connect (exit 3 or 4)**
- Run `framer-cms-sync projects --check`.
- **401 or `UNAUTHORIZED` from Framer:** the API key is wrong or revoked. Make a new one in Framer's site settings and put it in `.env`.
- **`AUTH_MISSING`:** a `${VAR}` in the config has no value in `.env`.

**HTTP 401 or 403**
- Check the token and its scope with `framer-cms-sync tokens`.
- A token limited to some syncs can't be used for MCP.

**Redirects fail**
- Redirects need a Framer plan that includes them.

**Markdown errors**
- `FRONTMATTER_INVALID`: the YAML between the `---` lines is broken. Quote values containing `:`.
- `BODY_EMPTY` is only a warning.
- Lint rules (`no-wikilinks`, `absolute-images`) can be turned down in `lint:`.

## Getting more detail

```bash
framer-cms-sync plan <sync> --json --full      # every item and change
framer-cms-sync check <sync>                   # data vs fields, without comparing items
framer-cms-sync inspect <sync>                 # what the source really contains
framer-cms-sync history                        # recent runs and results
```

## For agents

- Read the `code` and `fix`, and follow the fix if it doesn't need the person's decision.
- Retry only exit 4 (Framer or source) errors.
- Don't retry refused (exit 2) operations with stronger flags without asking.
