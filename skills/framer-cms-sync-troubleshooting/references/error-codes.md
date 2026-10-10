# Codes

## Issues (per record, in previews)

| Code | Means | Usual fix |
|---|---|---|
| `KEY_MISSING` | the record has no value in the key column | fill it in, or change `key.field` |
| `SLUG_INVALID` | the slug isn't lowercase words joined by hyphens | fix it, or let `key.transform: slugify` make it |
| `DUPLICATE_KEY` | two records give the same slug; the later one wins | make them unique |
| `DUPLICATE_SLUG_IN_COLLECTION` | two Framer items share a slug | fix it in Framer |
| `UNKNOWN_KEY` | a column matches no field | `map` it or `ignore` it |
| `REQUIRED_FIELD_UNMAPPED` | no title/body field found | map it in `fields.map` |
| `FIELD_NOT_SETTABLE` | the field type can't be set by the sync | ignore the column |
| `NUMBER_INVALID` | not a number | remove currency symbols and text |
| `NUMBER_EMPTY` | empty number; Framer keeps the current value | warning only |
| `BOOLEAN_INVALID` | not true/false | use true/false, yes/no, 1/0 |
| `DATE_INVALID` | not a date | use `2026-08-10` |
| `DATE_AMBIGUOUS` | `10/08/2026` could be either way | set `fields.dateOrder` |
| `ENUM_NO_MATCH` | not one of the field's options | use an option name, or add the option in Framer |
| `ENUM_EMPTY` | empty option; Framer keeps the current value | warning only |
| `IMAGE_NOT_ABSOLUTE` | image or file isn't a full URL | upload it, use the `https://` address |
| `FRONTMATTER_INVALID` | broken YAML frontmatter | fix the YAML (quote values with `:`) |
| `BODY_EMPTY` | empty Markdown body | warning only |
| `LINT` | a Markdown lint rule (`rule` says which) or a redirect check failed | fix, or change the rule's level in `lint:` |
| `PRUNE_GUARD` | removal refused by a safety guard (too many, too few records, or not the whole data set); the CLI exits with 2 | check the data is complete, then confirm with `--allow-mass-remove` |
| `TRANSFORM_FAILED` | the sync's transform threw | fix the plugin |

## Errors (whole operation)

| Code | HTTP | Exit | Means |
|---|---|---|---|
| `INPUT_INVALID` | 400 | 1 | bad argument or data format |
| `NO_INPUT` | 400 | 1 | no data and no configured source |
| `VALIDATION_FAILED` | 422 | 1 | the data has errors; see `issues` |
| `ITEM_NOT_FOUND` · `NOT_FOUND` | 404 | 1 | no such item or route (`update` on a new post: use `add`) |
| `ITEM_EXISTS` | 409 | 1 | `add` on a slug already in Framer: use `update` |
| `COLLECTION_FOREIGN_PLUGIN` | 409 | 2 | another plugin owns the collection |
| `COLLECTION_NOT_MANAGED` | 409 | 2 | needs a managed collection |
| `PLAN_STALE` | 409 | 2 | changed since the preview; preview again |
| `PLAN_REQUIRED` | 428 | 2 | a `planId` is required |
| `CONFIG_INVALID` · `CONFIG_NOT_FOUND` | 400 | 3 | config problem or missing; message names the key |
| `AUTH_MISSING` | 500 | 3 | a `${VAR}` has no value |
| `UNAUTHORIZED` | 401 | 3 | wrong token or Framer key |
| `FORBIDDEN` | 403 | 3 | scope too small or not allowed for this site/sync |
| `SYNC_NOT_FOUND` · `COLLECTION_NOT_FOUND` | 404 | 3 | no such sync or collection |
| `SOURCE_FAILED` | 502 | 4 | couldn't read the file or URL |
| `FRAMER_ERROR` | 502 | 4 | Framer returned an error |
| `APPLY_PARTIAL` | 502 | 4 | some writes failed; preview again to see what's left |
| `TIMEOUT` | 504 | 4 | took longer than `defaults.timeoutSeconds` |
| `INTERNAL_ERROR` | 500 | 4 | an unexpected error in framer-cms-sync itself; please report it |
