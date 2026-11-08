# 02 — Options and recommendation

Fixed constraint: **herdr is where agents run and where I talk to them.**
Every option below keeps that. The options differ in where the task store and
artifact pages live, and in what runs the center agent.

## A. Where tasks and artifacts live

### A1. Custom local service (recommended)

Node service on localhost. SQLite holds tasks, schedules and events, with
FTS5 for search. Each task's artifact is a Markdown file on disk. Web UI,
HTTP API and an MCP endpoint for agents.

- ✅ Exactly the workflow wanted: reminders, statuses, inline comments,
  herdr state, follow-ups.
- ✅ Same stack and patterns as the review orchestrator (Node ESM, Express,
  MCP HTTP, Jest), so it is familiar and its pieces can be reused.
- ✅ Agents (center and herdr workers) read and write through one API.
- ❌ We build the UI, including the comment layer.

### A2. Obsidian vault as the store, thin UI on top

One note per task with frontmatter for status, area and schedule. The
Obsidian MCP is already installed.

- ✅ Good editor, mobile app, notes already live there.
- ❌ Inline "comment to the agent" does not exist. Statuses, scheduling and
  herdr state turn into frontmatter hacks. Concurrent writes from agents and
  the Obsidian app are risky.
- Verdict: worth having as an **export target**, for example "send finished
  task summary to vault". Not as the store.

### A3. Asana as the source of truth, command center as a view

- ✅ No second system for the team.
- ❌ Personal reminders and half-formed requests would clutter team
  projects. The API is slow for a live page. Asana has no artifact or
  inline-comment model, and offline is impossible.
- Verdict: Asana stays a **mirror** for tasks that need it (create, comment,
  complete). The local store is canonical.

### A4. claude.ai Artifacts / Claude Docs for the artifact pages

- ✅ Comments and sharing built in. Good when I need to share a write-up
  with the team.
- ❌ Cloud, not local. herdr worker agents would need those connectors.
  Status, search and scheduling still need a local service anyway.
- Verdict: optional **"publish/share" action** later (export one artifact as
  a shared page). Not the primary store.

### A5. herdr-tsk

Rejected after evaluation. Not considered further.

### A6. Fork / extend herdr-web-ui

It already renders agent chats and runs over Tailscale. But it is
third-party, agent-centric rather than task-centric, and coupling to its
internals would break on updates.
- Verdict: **deep-link** into it from task pages ("open agent chat on
  phone"). Do not fork.

## B. What runs the center agent

The center agent does short jobs: classify, draft and edit an artifact,
answer a comment, call Brain for Slack, create and update Asana, decide what
to do when a follow-up fires.

### B1. Claude Agent SDK in-process (recommended)

The TypeScript/JS Agent SDK runs inside the Node service, on Haiku by
default with Sonnet when a job needs it.

- Tools: our own task and artifact tools (in-process MCP), `tracebot-mcp`
  (Brain for Slack, wiki), Asana, and read-only repo exploration
  (Read/Grep/Glob under `~/work/trace`).
- ✅ Streams into the UI. Per-job tool allow-lists. Cost and latency are
  under our control. Jobs can be cancelled.
- Auth: **my Claude login** (decided). Spike needed to confirm the SDK
  uses it from a launchd process. Asana goes through a PAT + REST, not
  the claude.ai connector. See [05](05-center-agent.md#runtime-and-auth).

### B2. `claude -p` headless subprocess per job

- ✅ Inherits my whole Claude Code config: MCP servers, auth. Almost zero
  setup.
- ❌ Seconds of startup per job, coarser control, output parsing.
- Verdict: **fallback** if the SDK cannot use my Claude login, behind the
  same internal `runJob()` interface.

### B3. A long-lived "concierge" Claude in a herdr pane

The center talks to it with `herdr agent prompt` / `agent read`.
- ✅ The center agent is visible in herdr and I can talk to it.
- ❌ Scraping terminal output for structured results is fragile. It also
  competes for my attention with the real workers.
- Verdict: no. Only the *worker* agents live in herdr.

## C. Frontend

- **C1. Vite + React SPA (recommended).** Inline comments (text selection,
  anchors, popovers), live updates over SSE, and a task list with filters
  are interactive enough to justify it.
- C2. Server-rendered + htmx. Simpler, but the comment and highlight layer
  would be JS-heavy anyway.

## D. How herdr workers talk back

- **D1. MCP tools served by the command center (recommended).** Same
  pattern as the review orchestrator's `request_review`: an HTTP MCP
  endpoint registered at user level. Workers call `cc_update_artifact`,
  `cc_add_link`, `cc_report` and so on.
- **D2. `cc` CLI** wrapping the same HTTP API. Works for any agent kind
  (codex, gemini) and from hooks. **Build both:** the CLI is cheap once the
  API exists.
- D3. Center scrapes pane output. Only as a last-resort signal. herdr
  lifecycle *events* are used, not text scraping.

## Recommendation

**A1 + B1 (B2 fallback) + C1 + D1/D2.** One local Node service that:

1. owns tasks, artifacts, comments and schedules: content in a git-versioned
   `tasks/` worktree, index and runtime state in SQLite;
2. runs the center agent (Haiku, many concurrent short jobs) through the
   Agent SDK for paperwork;
3. drives herdr through its CLI and socket API (`herdr workspace create`,
   `agent start`, `agent prompt`, `events.subscribe`) to launch and watch
   workers in `~/work/tree`;
4. exposes an MCP endpoint and CLI so workers report back;
5. mirrors to Asana only for tasks that need it.

This keeps herdr exactly as it is today. The command center sits beside it as
the "where is everything" layer.
