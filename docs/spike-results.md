# Phase 0 spike results (2026-11-07)

| # | Spike | Result | Decision |
|---|---|---|---|
| 1 | **Agent SDK with Claude login** | ✅ `@anthropic-ai/claude-agent-sdk` 0.3.x `query()` with `model: "claude-haiku-5-5"`, `outputFormat: {type:"json_schema"}`, `settingSources: []`, `allowedTools: []`. `init.apiKeySource` was `none`, i.e. the Claude login (team account). The result arrives in `result.structured_output`. ~5 s end to end (~2.8 s to first message), ~$0.003 per call. | `claude-sdk` is the default provider. Check the launchd context (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`) when the plist is first installed. |
| 2 | **Codex provider** | ✅ `codex exec -m gpt-6-luna --skip-git-repo-check --sandbox read-only --ephemeral --output-schema <file> -o <out>` returned schema-valid JSON in ~8 s. **Stdin must be `/dev/null`**: otherwise it blocks forever on "Reading additional input from stdin". The model id for "luna" is `gpt-6-luna` (from `~/.codex/models_cache.json`; the default heavy model is `gpt-6.1-sol`). | Codex provider defaults: light `gpt-6-luna`, heavy `gpt-6.1-sol`. |
| 3 | **Brain from the service** | Config verified: `~/.claude.json` → `mcpServers["tracebot-mcp"]` = `{type:"http", url, headers:{x-api-key}}`. Codex has the same server in `~/.codex/config.toml`. No live `brain_do` call yet (needs a real Slack thread). | Brain client reads the entry at runtime and never logs headers. Verify the result format on the first real enrich job. |
| 4 | **Asana** | ✅ PAT in the Keychain (`command-center-asana`), read-only `GET /projects/1111111111111111/sections` works. Live section names include `Nov 2 - Nov 8`, `August 3 - August 7`, `April 20 - 26` (no end month), `March 30 - April 3rd` (ordinal), non-date sections (`Backlog`, `Security Updates`, `tasks from onsite`) and Friday-ending weeks. | The parser handles all of these. Task create sends `memberships` (with section) **or** `projects` (no section), never both. No write test against the real project yet. The first real "Create in Asana" is the live test. |
| 5 | **Inline comment anchoring** | Implemented as a text-quote selector (`exact` + 32-char `prefix`/`suffix` + section) with fallback to exact-only and a diff-match-patch fuzzy match. | `web/src/lib/anchoring.js` |
| 6 | **Task data repo** | Originally an orphan-branch worktree of the code repo; now a standalone repo (`install/setup-tasks-repo.sh`) so task content can never be pushed with the code. The committer refuses to commit unless `tasksDir` is the root of its own work tree on branch `git.branch` (default `tasks`). | As designed. |

## Changes vs the original design

- **Center-agent tools:** phase 1 jobs use **structured output + deterministic apply**
  instead of an internal `/mcp/center` tool server. The model returns a
  schema-validated object (`edits`, `actions`, `reply`, …) and service code
  validates it and applies it through the store. This is faster (no tool
  round-trips), behaves the same on Claude and Codex, and gives least
  privilege by construction. Only `assist` with intent "ask" gets an MCP
  server (`tracebot-mcp`, for Brain) on the Claude providers.
- **Jest:** two configs. `jest.config.js` covers server and CLI (native ESM,
  `--experimental-vm-modules`) and `jest.web.config.js` covers web (babel +
  jsdom). `npm test` runs both.
