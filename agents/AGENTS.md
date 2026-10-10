## framer-cms-sync

This project keeps a Framer CMS in sync with local data using framer-cms-sync (config: `framer-cms-sync.config.yaml`).

- Before writing a sync for new data, run `npx framer-cms-sync inspect <url|file|folder> --json` to see its shape (format, `rows` path for nested JSON, fields with types and samples).
- Always preview first: `npx framer-cms-sync plan <sync> [files] --json`. Fix every error (each issue has a `fix`) in the source files, then plan again.
- Apply with the plan's id: `npx framer-cms-sync apply <sync> [files] --plan-id <planId> --json`.
- Publish only when asked (`--publish`). Publishing ships the whole site.
- Tell the person before applying a plan that removes items.
- Never use `--allow-mass-remove` or `setup --force` without explicit approval. Never read or print `.env`.
- With several sites, pass `--project <name>` for collections, redirects and publish (`projects` lists them).
- Run `npx framer-cms-sync describe` for config keys and issue codes.
- Full guides: `npx framer-cms-sync skills` (e.g. `skills syncing`, `skills cli commands`, `skills troubleshooting`), or the `skills/` folder in the package.
- Single Markdown post: `npx framer-cms-sync add <sync> post.md` / `update <sync> post.md` / `remove <sync> <slug>` write straight away (no plan) and keep the sync's folder in step.
