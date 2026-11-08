# Command Center

A local web command center for my day-to-day work. One place to capture,
shape, track and follow up on every task. A small center agent (Haiku) does
the paperwork. Real work is delegated to Claude agents running in
**herdr**.

> Status: **planning**. No code yet.

## Plan documents

| Doc                                                               | What it covers                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------- |
| [01 — Vision & requirements](docs/01-vision.md)                   | Problem, principles, user stories, scope                |
| [02 — Options & recommendation](docs/02-options.md)               | Alternatives considered and why the chosen approach     |
| [03 — Architecture](docs/03-architecture.md)                      | Components, data model, lifecycle, key flows, API       |
| [04 — herdr integration](docs/04-herdr-integration.md)            | Launching/watching workers, MCP tools, kickoff protocol |
| [05 — Center agent](docs/05-center-agent.md)                      | Job types, tools, guardrails, artifact template         |
| [06 — UI, artifacts & comments](docs/06-ui-artifacts-comments.md) | Home, task page, inline comments and anchoring          |
| [07 — Roadmap](docs/07-roadmap.md)                                | Phases 0–5                                              |
| [08 — Open questions](docs/08-open-questions.md)                  | Decisions needed                                        |

## One-paragraph summary

A Node service on this Mac keeps each task as a folder in a git-versioned
`tasks/` worktree (metadata, Markdown artifact, comments, events), indexed
in SQLite. The dark, mobile-first web UI is reachable from my phone via
`tailscale serve` on port 8443. Tailnet users can read Asana-linked
tasks, only I can edit. Capture a Slack
link or a line of text. The center agent (Haiku, many concurrent short jobs)
pulls context (Slack through Brain/tracebot-mcp, Asana, repos) and drafts
the artifact; I shape it by chatting or with inline comments. **Start**
creates the Asana task (Apps Project Sprints 2026, current week), opens a
herdr workspace in `~/work/tree` and launches Claude with a kickoff
brief that names the repos, branch and slug. The worker follows the tree
`AGENTS.md` and updates the artifact through `cc_*` MCP tools. It reports
`ready_for_pr` once the review orchestrator is GOOD_TO_GO. I click
**Create PR**. A PR watcher (every 15 min) has the agent address review
comments automatically (fix, test, commit, push, reply on GitHub), records
how each one was handled, and closes the task and its Asana task when the
PRs merge. Workers and the center agent run on Claude by default and can
be switched to Codex at any time.

**Build order:** phase 1 is the UI server + center agent. herdr integration
is phase 2.

## Running it

```bash
npm install
npm run build                          # web UI -> web/dist
install/setup-tasks-repo.sh            # task data repo (standalone git repo, never this one)
npm start | npx pino-pretty            # 127.0.0.1:7788 (local) + 127.0.0.1:7789 (tailnet)
node cli/cc.js open                    # opens the UI with an owner session
install/tailscale-serve.sh on          # https://<mac>.<tailnet>.ts.net:8443 -> 7789
```

One-time setup for herdr workers (phase 2), after the server has started once
(it creates the API token):

```bash
install/register-mcp.sh --dry-run      # shows what it would change
install/register-mcp.sh                # command-center MCP + skill for Claude and Codex
install/install-herdr-plugin.sh        # optional: herdr "Quick capture" action
```

- Config: `~/.config/command-center/config.json`, never in this repo. Copy
  [`config.example.json`](config.example.json) and fill in your values:
  Tailscale login (`owner.tailscaleLogin`, owner access on the tailnet),
  `publicBaseUrl`, GitHub org, Asana gids (and the Status field), the Brain
  MCP server name, `treeDir`, area repo hints. Nothing identifying ships
  in the defaults: without a value the feature stays off (no GitHub org = no
  PR watch, no Asana project = no Asana, no Brain server = no Slack).
- Task data (artifacts, comments, events) lives in its own git repo
  (`tasksDir`, branch `git.branch`), created by
  `install/setup-tasks-repo.sh`; keep it private. The SQLite state in
  `data/` is git-ignored.
- Local API token: `~/.config/command-center/token` (created on first start).
- Phone: open the tailnet URL. Pair it once with `node cli/cc.js pair` and
  enter the code on the phone, or use Settings → Devices. Push notifications:
  Settings → "Enable notifications on this device" (needs the HTTPS tailnet
  URL, installed as an app on iOS).
- Workers start in `treeDir` (herdr workspace per task) and talk
  back through the `cc_*` MCP tools; the PR watcher polls GitHub with `gh`
  every 15 min (Settings).
- Tests: `npm test` (server/CLI native ESM + web jsdom). Coverage:
  `npm run test:coverage`.

**Status:** phases 1–3 implemented (UI + center agent, herdr workers, PR
loop, SOC2 change records, Web Push, digest). See
[contracts](docs/implementation/contracts.md) and
[phase 2/3 contracts](docs/implementation/phase2-contracts.md).

## License

MIT, see [LICENSE](LICENSE). Copyright NorthernCaptain, 2026.
