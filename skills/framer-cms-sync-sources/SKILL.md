---
name: framer-cms-sync-sources
description: Work with framer-cms-sync data sources - Excel/CSV files, folders of Markdown files, Google Sheets, and endpoints/APIs (including nested JSON). Use to see what a file, sheet or URL contains (inspect), to set up or fix a source, to handle dates like 10/08/2026, or to download a collection to a file or create a template.
---

# Data sources

New syncs keep their files in one folder per site: `data/<site>/<sync>.xlsx` (or `.csv`), and a folder of posts at `data/<site>/<sync>/` for Markdown. Any other path works too; it's just the wizard's default.

| Source | Config | Notes |
|---|---|---|
| Excel | `{ type: excel, path: ./data/x.xlsx, sheet: Prices }` | first sheet unless `sheet` is set |
| CSV | `{ type: csv, path: ./data/x.csv }` | header row = column names |
| JSON file | `{ type: json, path: ./data/x.json, rows: data.items }` | `rows` only if the list is nested |
| Markdown folder | `{ type: markdown, path: ./posts }` | one `.md` per item; slug from `slug:` or the filename |
| Google Sheets | `{ type: csv, url: <the sheet's normal link> }` | must be shared "Anyone with the link → Viewer"; read-only |
| Nothing (pass-through) | `{ type: none }` | no source of its own: data is sent in (posts or rows); nothing saved locally |
| Endpoint | `{ type: json, url: https://…, headers: { Authorization: "${MY_TOKEN}" }, rows: data.items }` | fetched with GET each time |

Paths are relative to the folder that holds the config. Secrets (URL tokens, headers) belong in `.env`, referenced as `${NAME}`.

Each kind of source has its own reference:
- [references/excel-csv.md](references/excel-csv.md)
- [references/markdown.md](references/markdown.md)
- [references/google-sheets.md](references/google-sheets.md)
- [references/endpoints.md](references/endpoints.md)

## Pass-through: no source

A sync with `source: { type: none }` stores nothing locally. It's for AI agents, the HTTP API and single commands:
- **Posts:** `add`, `update` and `remove`, or MCP `add_posts` and `update_posts`, behave as they do for a Markdown sync, without saving files.
- **Rows** (JSON or CSV sent to `apply`, or `POST /syncs/<sync>/apply`) are matched by their exact `slug` column, unless the sync sets `key:`.
- **Reading** works as usual: `items`, `fields`, `download` and `inspect` of the data you send.
- **Not available:** a preview or apply without data, and `pull`, since there's nothing local to compare or download into.

When the wizard creates a new collection for a pass-through sync, it starts with basic fields (Title, Date, Image, Description, Content) or copies another collection's fields.

## Inspect any data first

Before writing a sync, or when something doesn't match, look at the data:

```bash
framer-cms-sync inspect https://api.example.com/plans [--header "Authorization: Bearer …"]
framer-cms-sync inspect ./data/products.xlsx
framer-cms-sync inspect ./posts
framer-cms-sync inspect products          # an existing sync's source
```

It shows:
- the format, and where the records are (for wrapped JSON)
- each field's type, how many records have it, and example values
- a ready-to-paste `source:` line and a suggested key

URLs are fetched with one GET request, and nothing is stored. Over MCP, use `inspect_source`. Over HTTP, `POST /inspect` takes data in the body; an arbitrary `?url=` needs admin scope.

## Nested JSON

Many APIs wrap their records (`{ "data": { "items": [...] } }`) and nest values (`"price": { "amount": 21 }`).
- **Where the records are:** set `rows: data.items`.
- **Nested values** arrive as dotted names you can map: `fields: { map: { "price.amount": "Price" } }`.
- **If the records aren't found,** the error names the likely path.

## Dates

- **ISO dates** (`2026-08-10`) always work.
- **Dates like `10/08/2026`** can mean 10 August or October 8, so the tool never guesses:
  - If the data settles it (a value like `25/08`), that order is used.
  - Otherwise set `fields: { dateOrder: DMY }` (day first) or `MDY` (month first). The wizard asks once.
  - Ambiguous dates are refused until it's set.

## Start from the CMS, or a template

```bash
framer-cms-sync download Blog ./data/blog.xlsx       # every item, exact slugs (.csv, .json, or a folder for Markdown)
framer-cms-sync template ./data/new.xlsx [--from Blog]   # columns plus one example row
```

- **A download** includes a `slug` column (`slug:` in Markdown files). A sync with `key: { field: slug, transform: none }` then matches every item, and the first preview shows no changes.
- **A template's** example row lets field types be worked out when a new collection is created.
