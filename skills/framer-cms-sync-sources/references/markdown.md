# Markdown folders

```yaml
source: { type: markdown, path: ./posts }
path: /blog/                                # page URL prefix (for redirects)
fields: { map: { content: Content } }       # which field the body goes to, if not found automatically
lint: { max-length: { level: warn, meta_description: 160 } }
```

## A post

```markdown
---
slug: packing-for-japan          # optional: defaults to the file name
title: Packing for Japan
date: 2026-10-05
author: Maya
thumbnail: https://example.com/japan.jpg
meta_description: What to bring for two weeks in Japan.
published: false                 # optional: false makes it a draft
---

Pack light. Trains have little luggage space.
```

- **Frontmatter keys match fields by name.** Common keys also match standard names:
  - `date` → "Publish Date" / "Date"
  - `meta_description` → "Meta Description"
  - `thumbnail` → "Image" / "Thumbnail"
  - `content` → "Content" / "Body"
- **The body** is converted to HTML (tables, raw HTML and embeds pass through) and goes to the collection's rich-text field.
- **A leading `# Title`** is dropped, since your page template shows the title. It's used as the title if there isn't one.
- **An empty body** is a warning: the body field will be empty.
- **Images** must be full `https://` URLs.

## Built-in checks (lint)

| Rule | Default | Catches |
|---|---|---|
| `no-wikilinks` | error | `[[links]]` left in |
| `absolute-images` | error | images without a full URL |
| `no-placeholders` | warning | TODO, TBC, PLACEHOLDER |
| `max-length` | off | e.g. `{ meta_description: 160 }` |
| `required` | off | e.g. `{ keys: [title, date] }` |
| `no-em-dash` | off | em dashes |

Set any rule to `off`, `warn` or `error` under `lint:`. Plugins can add rules (see `framer-cms-sync-config`).

## Downloads

`framer-cms-sync download Blog ./posts` writes one `.md` file per item:
- frontmatter keys are the field names, plus `slug`
- the rich text is converted back to Markdown, with line breaks kept as `<br>`
- the first preview afterwards shows no changes

## Publishing one post

```bash
framer-cms-sync add blog ./new-post.md --publish      # new post
framer-cms-sync update blog ./posts/new-post.md       # changed post
framer-cms-sync remove blog new-post                  # gone from Framer and the folder
```

These write straight away and keep the folder in step. See `framer-cms-sync-syncing`.
