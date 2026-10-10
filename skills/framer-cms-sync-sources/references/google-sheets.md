# Google Sheets

```yaml
source: { type: csv, url: https://docs.google.com/spreadsheets/d/<id>/edit#gid=0 }
key: { field: slug, transform: none }
```

- **Paste the sheet's normal link.** The tab in the link (`gid=`) is the one that's read; without one, the first tab.
- **The sheet must be shared:** Share → General access → **Anyone with the link → Viewer** (or File → Share → Publish to web → CSV).
- **If it isn't shared,** the error says exactly that, with the steps.
- **Read-only.** The tool reads the sheet but can't write to it, since that would need Google sign-in.

## Starting a sheet from the CMS, or from a template

The wizard offers "Not yet: give me a file to import". It writes a CSV and shows the steps:

1. In Google Sheets: **File → Import → Upload**, choose the file, then **Replace spreadsheet**.
2. **Share → Anyone with the link → Viewer.**
3. Paste the sheet's link into the wizard.

Without the wizard: `framer-cms-sync download Blog ./data/blog.csv`, then import it the same way.

## Things to watch

- **Dates** like `10/08/2026`: set `fields.dateOrder` (DMY or MDY). The wizard asks.
- **Formulas** come through as their results.
- **Extra columns** that aren't fields produce a warning. Add them to `fields.ignore`, or map them.
- **Edits made in Framer** can't be written back to the sheet. Download a CSV and re-import it if you need the sheet to catch up.
