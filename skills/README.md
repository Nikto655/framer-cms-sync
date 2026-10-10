# framer-cms-sync skills

Everything about using framer-cms-sync, written once for both people and AI agents. Each folder is an [Agent Skill](https://agentskills.io) (an open format AI agents such as Claude Code and Cursor can load): a `SKILL.md` with a short description of when it applies, plus `references/` for longer detail. People can read them here; agents load the right one when a task matches its description.

## Start here

- **New to framer-cms-sync?** Read [framer-cms-sync](framer-cms-sync/SKILL.md), then [setup](framer-cms-sync-setup/SKILL.md).
- **Looking for a command?** [CLI](framer-cms-sync-cli/SKILL.md) and its [full command reference](framer-cms-sync-cli/references/commands.md).
- **Something went wrong?** [Troubleshooting](framer-cms-sync-troubleshooting/SKILL.md).
- **Setting up an AI agent?** [MCP](framer-cms-sync-mcp/SKILL.md) and [access tokens](framer-cms-sync-tokens/SKILL.md).

## The skills

| Skill | Use it for |
|---|---|
| [framer-cms-sync](framer-cms-sync/SKILL.md) | What it is, the core ideas, the safe workflow, and which skill to use next |
| [framer-cms-sync-setup](framer-cms-sync-setup/SKILL.md) | First setup, sites, choosing a collection, the new-sync wizard |
| [framer-cms-sync-sources](framer-cms-sync-sources/SKILL.md) | Excel/CSV, Markdown folders, Google Sheets, endpoints; inspecting data; dates; downloads and templates |
| [framer-cms-sync-syncing](framer-cms-sync-syncing/SKILL.md) | Previewing, the four apply choices, publishing, bringing Framer edits back, deleting |
| [framer-cms-sync-mapping](framer-cms-sync-mapping/SKILL.md) | How columns are matched to fields, and changing it |
| [framer-cms-sync-cli](framer-cms-sync-cli/SKILL.md) | Using the command line; every command and option |
| [framer-cms-sync-http](framer-cms-sync-http/SKILL.md) | The HTTP API: routes, bodies, scopes |
| [framer-cms-sync-mcp](framer-cms-sync-mcp/SKILL.md) | Connecting AI agents over MCP, locally or remotely |
| [framer-cms-sync-tokens](framer-cms-sync-tokens/SKILL.md) | Access tokens for agents, n8n, scripts and CI |
| [framer-cms-sync-automation](framer-cms-sync-automation/SKILL.md) | Keeping it updated: cron, GitHub Actions, n8n, Make; running in Docker |
| [framer-cms-sync-config](framer-cms-sync-config/SKILL.md) | Every setting in `framer-cms-sync.config.yaml` |
| [framer-cms-sync-troubleshooting](framer-cms-sync-troubleshooting/SKILL.md) | Common problems; every error and issue code with its fix |

## Giving these skills to an agent

- **Claude Code:** copy the folders into `.claude/skills/` in your project (or `~/.claude/skills/` for all projects).
- **Other agents:** point them at this folder, or paste the relevant `SKILL.md`. Agents connected over MCP can also call the `describe` tool for a compact reference.
- **From the command line:** `framer-cms-sync skills` lists these skills, and `framer-cms-sync skills <name>` prints one.
