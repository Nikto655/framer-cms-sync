# Config reference

Names of sites and syncs: letters, digits, `-` and `_`.

## `projects.<site>`

| Key | Default | Meaning |
|---|---|---|
| `url` | required | the Framer project URL |
| `apiKey` | required | `${VAR}` pointing at the key in `.env` |
| `label` | | display name in the app |
| `color` | | `cyan`, `magenta`, `yellow`, `blue`, `green`, `red`, `white` or `#hex` |

`project:` (singular) is shorthand for one site named `default`.

## `syncs.<sync>`

| Key | Default | Meaning |
|---|---|---|
| `description` | | shown in lists |
| `project` | the only site | which site it writes to |
| `collection.name` / `collection.id` | one required | target collection |
| `collection.mode` | `auto` | `managed`, `unmanaged`, or `auto` (detect) |
| `collection.create` | `false` | let `setup` create it |
| `schemaFrom` | | copy fields from this collection when setting up a managed one |
| `schemaIds` | `slugify` | field ids when copying: `slugify` or `keep` |
| `source.type` | required | `csv`, `excel`, `json`, `markdown`, or `none` (pass-through: data only sent in; rows keyed by `slug`) |
| `source.path` | | file, folder or glob (relative to the config) |
| `source.url` | | URL to fetch (endpoints, Google Sheets) |
| `source.headers` | | request headers; use `${VAR}` for secrets |
| `source.rows` | | where the records are in a JSON document, e.g. `data.items` |
| `source.sheet` | first sheet | Excel sheet name |
| `key.field` | Markdown: slug or filename | column that identifies a record |
| `key.transform` | `slugify` | `slugify` the key into a slug, or `none` (use as is) |
| `path` | | page prefix such as `/blog/`, used by redirects |
| `publish` | `defaults.publish` | `never`, `always` or `on-change` |
| `transform` | | name of a transform from a plugin |

### `fields`

| Key | Default | Meaning |
|---|---|---|
| `map` | `{}` | column → field name |
| `ignore` | `[]` | columns never sent |
| `unknown` | `warn` | columns with no field: `warn`, `error` or `ignore` |
| `nulls` | `clear` | empty values: `clear` the field, or `skip` (leave it) |
| `alt` | `{}` | image field → column holding its alt text |
| `formattedText` | `html` | rich-text input: `html`, `markdown` or `auto` |
| `dateOrder` | | `DMY` or `MDY`, for dates like `10/08/2026` |

### `markdown`

| Key | Default | Meaning |
|---|---|---|
| `stripLeadingH1` | `true` | drop a first `# Title` that repeats the title |
| `dedupeThumbnail` | `thumbnail` | drop a body image that repeats this frontmatter image; `false` to keep |
| `draftField` | `published` | frontmatter flag for published/draft |
| `aliases` | `default` | standard frontmatter names (`date` → "Publish Date"…); `none`, or your own map |
| `typographer` · `linkify` | `false` | smart quotes · auto-link URLs |

### `lint` (Markdown)

`rule: off | warn | error`, or `{ level, …options }`.

| Rule | Default | Checks |
|---|---|---|
| `no-wikilinks` | error | `[[links]]` left in the body |
| `absolute-images` | error | images without full URLs |
| `no-placeholders` | warn | TODO, TBC, TK, XXX, PLACEHOLDER |
| `no-em-dash` | off | em dashes |
| `max-length` | off | `{ title: 70, description: 160 }` |
| `required` | off | `{ keys: [title, date] }` |

### `prune`

`false` (default) or:

| Key | Default | Meaning |
|---|---|---|
| `minItems` | `1` | don't remove anything if the data has fewer records |
| `maxRemove` | `"20%"` | most to remove in one run (number or percentage) |
| `mode` | `delete` | `delete`, or `draft` (unpublish instead) |

## `defaults`

| Key | Default | Meaning |
|---|---|---|
| `publish` | `never` | default for syncs |
| `deploy` | `true` | publishing goes live (false: preview deployment) |
| `chunkSize` | `100` | items per write request |
| `timeoutSeconds` | `600` | per-run limit |

## `server`

| Key | Default | Meaning |
|---|---|---|
| `port` · `host` | `8080` · `127.0.0.1` | where `serve` listens |
| `tokens` | `[]` | access tokens (`name`, `token`, `scope`, `projects`, `syncs`, `description`, `created`); use `framer-cms-sync tokens` |
| `maxBodyMb` | `15` | request size limit |

## Other

| Key | Default | Meaning |
|---|---|---|
| `redirects.allowChains` | `false` | allow a redirect to point at another redirect |
| `plugins` | `[]` | JS modules adding `lintRules` and `transforms` |
| `runLog` | `true` | keep the run log (`history`) |

## Environment variables

| Name | Meaning |
|---|---|
| anything referenced as `${VAR}` | filled from `.env`, then the environment |
| `SYNC_TOKEN_<NAME>` | token values written by `tokens add` |
| `FRAMER_CMS_SYNC_REQUIRE_PLAN=1` | non-interactive applies need `--plan-id` |
| `FRAMER_CMS_SYNC_DEMO=<file>` | use a local file instead of Framer (demos, tests) |
