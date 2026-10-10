---
name: framer-cms-sync-mapping
description: How framer-cms-sync matches columns (CSV/Excel headers, JSON keys, Markdown frontmatter) to Framer collection fields, and how to change it. Use when a preview warns that a column "doesn't match any field", a value lands in the wrong field, or a column should be ignored.
---

# Field mapping

Each column in the data goes to one field in the collection. Columns are matched automatically, in this order:

1. **Your mapping** (`fields.map`)
2. **Standard names**, for Markdown only: `date` → "Publish Date", `meta_description` → "Meta Description", `content` → the body field, `thumbnail` → "Image"…
3. **The same name**
4. **A similar name**, ignoring case and punctuation: `publish-date` = "Publish Date"
5. **The field's internal id**

A column missing from a record leaves that field untouched in Framer, while an empty value clears it. The key column, `slug` and `published` are used by the sync itself, so they never produce warnings.

## See how it's matched

```bash
framer-cms-sync map <sync>          # MCP: get_mappings · HTTP: GET /syncs/<sync>/mappings
```

For every column it shows the field it goes to, how it matched, and an example value. It also flags:
- columns that match nothing
- columns that match several fields
- two columns filling one field
- mappings to fields that no longer exist
- fields nothing writes to

## Change it

In the config:

```yaml
syncs:
  products:
    fields:
      map:
        "Price (USD)": "Price"          # column → field name
        "price.amount": "Price"         # nested JSON value
        content: "Article"              # Markdown body → a differently named rich-text field
      ignore: [Internal notes, SKU]     # never sent, never warned about
      unknown: warn                     # columns with no field: warn | error | ignore
```

Or without editing the file:

```bash
framer-cms-sync map products "Price (USD)" "Price"
framer-cms-sync map products "Internal notes" --ignore
framer-cms-sync map products "Price (USD)" --auto     # back to automatic
```

Agents can do the same remotely: MCP `set_mappings` (write scope), or HTTP `POST /syncs/<sync>/mappings` with `{ "changes": [{ "column": "Price (USD)", "to": "Price" }] }`. `to` is a field name, `"ignore"` or `"auto"`, and field names are checked against the collection.

## For agents

When a preview warns `UNKNOWN_KEY`:
- **If the right field is obvious** ("Price (USD)" → "Price"), map it.
- **If the column clearly isn't wanted** (internal notes), ignore it.
- **Otherwise ask the person.**

Preview again afterwards.

## How values are converted

| Field type | Accepts |
|---|---|
| Text | anything (lists joined with commas) |
| Rich text | HTML (Markdown bodies are converted) |
| Number | numbers, or text like `"4.99"` (no currency symbols) |
| Yes/no | true/false, yes/no, 1/0, y/n, on/off |
| Date | `2026-08-10`, or `10/08/2026` with `fields.dateOrder` |
| Option | the option's name (any case) or id |
| Image, file | a full `https://` URL |
| Link, colour | text |
| Reference | item ids |
