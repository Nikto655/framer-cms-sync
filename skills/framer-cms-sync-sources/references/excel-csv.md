# Excel and CSV

```yaml
source: { type: excel, path: ./data/products.xlsx }            # first sheet
source: { type: excel, path: ./data/products.xlsx, sheet: Prices }
source: { type: csv, path: ./data/products.csv }
key: { field: Name }                  # slugified: "Pro Monthly" → pro-monthly
key: { field: slug, transform: none } # an exact slug column (downloads have one)
```

- **Columns:** the first row holds the column names, and each further row is one item. Columns are matched to fields by name (see `framer-cms-sync-mapping`).
- **Excel cells:** dates become ISO dates, links become their address, formulas become their result. Rich text in a cell is read as plain text.
- **Empty cells:**
  - text fields: become empty
  - yes/no fields: become false
  - dates, links and images: are cleared
  - numbers and options: are kept as they were (Framer can't store an empty number or option), with a warning
- **Yes/no values:** `true/false`, `yes/no`, `1/0`, `y/n`, `on/off`.
- **Options (dropdowns):** use the option's name. Matching ignores case. A value that isn't an option is an error, listing the valid ones.
- **Images and files:** must be full `https://` URLs. Framer copies them and hosts them itself.
- **Rich text:** HTML in the cell (`<p>…</p>`). Downloads write the CMS's HTML.
- **A column called `published`:** `false` makes the item a draft.

## Excel tips

- **Keep the header row unchanged,** or update the sync's key and mappings to match.
- **Several sheets:** the wizard asks which one; in the config, set `sheet`.
- **Excel locks files it has open,** so save before you preview.

## Pick up edits made in Framer

`framer-cms-sync pull <sync>` (Settings → Download from Framer) replaces the file with Framer's items, saving a backup next to it first. See `framer-cms-sync-syncing`.
