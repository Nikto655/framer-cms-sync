---
name: framer-cms-sync-config
description: The framer-cms-sync config file (framer-cms-sync.config.yaml) and .env - where they live, sites, syncs, secrets, defaults, and how to edit them safely by hand or with commands. Use when editing the config directly, adding a setting the terminal app doesn't expose, or diagnosing a CONFIG_INVALID error.
---

# Config

All settings live in one file, `framer-cms-sync.config.yaml`, with secrets kept in `.env` next to it. The tool finds the config by searching upward from the current folder; `-c <file>` overrides that.

Every key, with its default: [references/config.md](references/config.md).

## Shape

```yaml
projects:                       # sites, by short name
  blog:
    url: https://framer.com/projects/My-Site--abc123
    apiKey: ${FRAMER_API_KEY_BLOG}
    label: My blog              # shown in the app
    color: cyan

syncs:
  posts:
    project: blog               # only needed with several sites
    collection: { name: Blog, mode: unmanaged }
    source: { type: markdown, path: ./data/blog/posts }
    key: { field: slug }
    publish: on-change

defaults:
  publish: never

server:
  port: 8080
  tokens: []                    # managed with `framer-cms-sync tokens`
```

## Secrets

- **`${NAME}` is filled from `.env`, then from the environment.** API keys and token values always go there, and the config only holds the `${…}` reference.
- **Keep `.env` out of git.** The `.framer-cms-sync/` folder (local state, run log) is personal too.

## Editing

- **Commands and the terminal app edit the file in place and keep your comments**: `init`, `projects …`, `tokens …`, `map …`, `syncs remove`, and the wizard. Prefer them for the things they cover.
- **By hand is fine for everything else.** The running service and the terminal app pick changes up without a restart.
- **The config is checked when it loads.** Mistakes give `CONFIG_INVALID`, with the exact key and what's expected.
- **After hand edits, run `framer-cms-sync syncs` and `framer-cms-sync check <sync>`** to confirm.

## One site or several

The older single-site form still works:

```yaml
project:
  url: …
  apiKey: ${FRAMER_API_KEY}
```

It means a site called `default`. Adding a second site (`init --name …` or the app's Sites screen) converts it to `projects:`.

## For agents

- Edit with the commands where one exists.
- Never write a secret value into the config; put it in `.env` and reference it.
- Run `framer-cms-sync describe --json` for a compact list of keys and allowed values.
