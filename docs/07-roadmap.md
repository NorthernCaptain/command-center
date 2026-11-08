# 07 — Roadmap

Each phase ends with something I can use every day.

## Phase 0 — Spikes for phase 1 (1–2 days)

Only the unknowns phase 1 depends on:

1. **Agent SDK with my Claude login**: interactive login and the
   `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` path from a launchd
   process. Haiku round-trip latency, streaming, prompt caching. If it
   fails, check the `claude -p` subprocess fallback.
2. **Codex provider**: `codex exec -m <light model> --json --output-schema` with the internal `/mcp/center` tools and `tracebot-mcp`. Compare latency and quality with Haiku on the same `enrich` / `edit_artifact` inputs.
3. **Brain from the SDK**: connect `tracebot-mcp` and run one `brain_do`
   "read this Slack thread → JSON" job. Measure latency and result shape.
4. **Asana**: PAT (already in the Keychain as `command-center-asana`),
   sprint-section resolution against the real project, and on a throwaway
   task: create with `html_notes`, update only the managed block,
   external link attachments, comment, complete.
5. **Inline comment anchoring**: text-quote selector re-anchoring over a
   Markdown file that changes between renders. Pick the library.
6. **Task data repo**: standalone git repo for task content, debounced commits,
   `git log -p` per task for the history drawer.

Output: `docs/spike-results.md`, with decisions folded back into these
docs.

## Phase 1 — UI server + center agent  ← build first

**Server & storage**
- Express service, launchd plist, config, pino, Jest + coverage.
- `tasks/` git worktree store (task.json, artifact.md, comments.jsonl,
  feedback.jsonl, events.jsonl), content-hash revisions, debounced
  automatic commits on the `tasks` branch (never pushed), restart recovery. SQLite index + FTS5 + runtime tables.
  `cc reindex`.
- Task lifecycle with all statuses from [03](03-architecture.md#task-lifecycle).
  In phase 1 the PR statuses are set manually.
- Scheduler: reminders and `surface` follow-ups ("remind me in a week"),
  rule-based date parser, macOS notifications.

**UI** (Vite + React), **dark mode by default and mobile-first**
- Phone/tailnet access from day one: tailnet listener behind `tailscale
  serve --https=8443`. Owner (`owner@example.com`) gets full
  access, other tailnet users read **Asana-linked** tasks only. Server-side
  role middleware, installable PWA (no push yet).
- Home: capture box, Now / Active / PRs / Ready / Inbox / Waiting / Done
  lanes, filters, FTS search, `Cmd+K`, home command bar.
- Task page: rendered artifact, direct Markdown edit, history drawer (git),
  links, schedules, status controls.
- Inline comments: selection popover (Comment / Ask / Change), anchoring,
  threads, resolve, orphaned.
- Live updates over SSE.

**Center agent**
- Job runner with interactive and background lanes, per-task locks, parked
  jobs, persistence, cancel, usage tracking.
- Provider layer: `claude-sdk` (default), `claude-cli`, `codex` (light
  model). Switch in Settings, optional auto-fallback on credit/usage-limit
  errors. Internal `/mcp/center` tool endpoint shared by all providers.
- Jobs: `parse_quick`, `command`, `edit_artifact`, `answer`, `enrich`
  (Slack via Brain, free text, Asana link), `asana_create`, `close_out`
  (manual trigger in phase 1).
- Asana: **Create in Asana** button (project, current-week section,
  assignee Leo). Good description drafted from the artifact, a managed
  tracking block (artifact link, repos/branches, PRs), external link
  attachments, `asana_sync` on changes. Comment and complete on Done.

**CLI**: `cc add`, `cc ls`, `cc show`, `cc done`, `cc remind`.

✅ Usable: paste a Slack link → a well-written task page, shaped by chat
and inline comments. Reminders work. Asana tasks are created correctly. I
start herdr agents by hand for now and paste the task brief.

## Phase 2 — herdr workers + PR loop

- Spikes from [04](04-herdr-integration.md#spike-checklist-start-of-phase-2).
- herdr bridge: CLI wrapper, event subscriber, agent sessions, row overlay,
  blocked → Now.
- Start: assign branch/slug, workspace in `~/work/tree`, `agent
  start`, kickoff prompt per the tree AGENTS.md.
- MCP `/mcp` with `cc_*` tools, user-level registration, `command-center`
  skill.
- Action buttons: Create PR, Address feedback (manual re-trigger), Clean folders, Open in herdr,
  Send to agent. Queued delivery on idle. Revive with `--resume`.
- PR watcher (every 15 min): discovery by branch + claim checks,
  comments/CI/merge polling, feedback items (`feedback.jsonl`), automatic
  feedback prompt (fix, test, commit, push, reply on GitHub), `cc_feedback`
  verification, deliverables-based close → `done` + Asana close-out.
- Worker kind switch: Claude (default) / Codex, global and per task,
  "relaunch on Codex" when Claude limits hit. Codex MCP + skill install.
- Review orchestrator result links.

✅ Usable: request → agent → PR → feedback → merge → Asana closed, fully
tracked.

## Phase 3 — Polish & SOC2

- Follow-up actions `prompt_agent` / `launch_agent` / `center_job` ("check
  PR comments in 2h") and `cc_schedule` from workers.
- SOC2 change-record enforcement for infra/access/security/soc2 areas.
  Export a date range as evidence (later: push to Vanta).
- Phone: Web Push notifications.
- herdr **Quick capture** plugin action.
- Morning digest, stale-task sweep.

## Later / maybe

- Slack thread replies are **not allowed** for now; revisit after living
  with the center for a while. Asana inbox import. Obsidian
  export. Publish an artifact as a shareable claude.ai page.
- Recurring tasks. Workers on other machines (herdr `--machine`).
- Auto-capture from Slack (emoji reaction → task).
- Backing up the `tasks` branch to a private remote (explicit decision).
