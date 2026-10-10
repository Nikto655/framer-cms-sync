---
name: framer-cms-sync-setup
description: Set up framer-cms-sync - connect a Framer site (project URL and API key), add or switch between several sites, pick a collection (new managed/regular, take over a hand-built one, or copy one another plugin owns) and create a sync with the wizard or the config. Use for first-time setup, "connect my Framer site", "add another site", or "create a sync for X".
---

# Setting up framer-cms-sync

## Connect a site

You need:
- **Node.js 22+**
- **A Framer API key:** Framer → Site Settings → API → create a key.
- **The project URL:** copy it from the browser in the Framer editor, e.g. `https://framer.com/projects/My-Site--abc123`. That's the editor address, not the published site.

```bash
npx framer-cms-sync              # terminal app: asks for URL, key and a short site name, then starts the wizard
# or without the app:
framer-cms-sync init --name blog --url https://framer.com/projects/My-Site--abc123 --key <API key>
```

The URL and key go into `.env` (git-ignored). The config only refers to them, e.g. `${FRAMER_API_KEY}`.

## Create a sync: the wizard

In the terminal app, press `n` (it also starts right after setup). Steps:

1. **Collection:**
   - **New collection**: name it and choose **managed** (your data is the source of truth; synced content is read-only in Framer) or **regular** (your team can still edit it in Framer).
   - **Existing collection**:
     - hand-built: filled as it is
     - created by this tool: used directly
     - owned by another plugin: you name **your own managed copy** (default "<name> Synced"), with the same fields
2. **Data source:** Excel/CSV file, folder of Markdown files, Google Sheets, an endpoint (URL), or **nothing** (pass-through: data is only sent in by agents, HTTP or commands, and nothing is saved locally). Details: `framer-cms-sync-sources`.
3. **Connect:**
   - For an existing collection, choose **download the current items** into a new file. The file starts identical to the CMS, and the first preview shows no changes.
   - For a new collection, choose a **template**, or use data you already have.
   - Then pick the key column (it becomes the slug; each candidate shows whether it's unique) and, for new collections, the fields: worked out from the data, a general template, or copied from another collection.
   - If dates like `10/08/2026` are ambiguous, it asks day-first or month-first once.
4. **Review:** a summary and exactly what Enter will do. Nothing is created or written before this.

After creating a **new** collection, add a CMS page or list for it in the Framer editor. After making a **copy** of another plugin's collection, switch your page template to the copy before publishing.

## Create a sync: the config

```yaml
syncs:
  products:
    collection: { name: Products }                 # existing collection, any kind (mode: auto)
    source: { type: excel, path: ./data/products.xlsx }
    key: { field: slug, transform: none }          # or { field: Name } to slugify a column
  team:
    collection: { name: Team, create: true, mode: managed }   # new; mode: unmanaged for regular
    source: { type: csv, path: ./data/team.csv }
    key: { field: Name }
```

For a new collection, run `framer-cms-sync setup team`. It creates the collection with fields worked out from the data, or copied from `schemaFrom: <collection>`. Settings: `framer-cms-sync-config`.

## Several sites

```bash
framer-cms-sync init --name shop --url … --key …   # add a site (or `a` in the app)
framer-cms-sync projects                           # list; • marks the current one
framer-cms-sync projects use shop                  # switch (or Tab / `w` in the app)
framer-cms-sync projects rename shop store
framer-cms-sync projects label store "Maya's Shop"
```

Each sync belongs to one site (`project: shop`). Site-wide commands use the current site unless you pass `--project`. The first time you add a second site, your existing site gets a name and its syncs stay attached to it. Each site has its own colour in the app, and every confirmation names the site.

## Check it worked

```bash
framer-cms-sync projects --check     # each site's connection
framer-cms-sync collections          # what's in the site and what the tool can do with each
framer-cms-sync plan <sync>          # the first preview
```
