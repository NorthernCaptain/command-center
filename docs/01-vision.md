# 01 — Vision and requirements

## Problem

Work arrives from many channels: Slack threads, Asana, phone calls, hallway
asks. It spans many areas:

- backend: lambdas, beans, services
- mobile (iOS / Android)
- web UI (occasionally; `web-trace` repo)
- infrastructure
- access management: AWS and Tailscale permissions for teams
- security
- SOC2 documentation and change tracking

The real work happens on this Mac, in Claude agents running inside **herdr**.
The *tracking* of that work is scattered across Slack, Asana and memory. Nothing
connects "the request" → "the agent session doing it" → "the PR" → "the
Asana task closed with results".

## Goal

A **local command center**: one web page that holds and tracks every task I
have. A small, fast "center agent" (Haiku-class) runs the paperwork. Real work
is delegated to Claude agents in herdr, which I talk to directly.

## Principles

1. **herdr stays the execution layer.** The command center never replaces
   herdr panes or the conversation with a worker agent. It launches agents,
   watches them, and links to them.
2. **Capture costs nothing.** Creating a task must take under 5 seconds. A
   Slack link alone is a valid task.
3. **The artifact is the memory.** Each task has a living page: context,
   plan, decisions, links, results. Agents write to it, I comment on it.
4. **Not everything is a project.** A reminder ("talk to Ron about 123
   tomorrow") has no Asana task, no agent, no artifact ceremony.
5. **Local-first, mine.** Runs on this Mac, data on disk (task history in
   git), reachable from my phone over Tailscale. Tailnet colleagues can
   *read* shared task pages. Only I can create or edit.
6. **Agent-native.** Anything I can do in the UI, an agent can do through
   the API/MCP tools, and the other way round.
7. **Dark and mobile-first.** The UI is designed for a dark theme and for
   the phone first.

## Core user stories

### Capture
- **C1** Paste a Slack thread link, hit Enter. The center agent fetches the
  thread through Brain (`tracebot-mcp` → `brain_do`). It writes a proper title,
  description and area, and drafts the artifact.
- **C2** Type free text ("check why lambda X times out for team Y"). Center
  agent classifies area, suggests repo(s), drafts the artifact.
- **C3** Type a reminder ("remind me to talk to Ron about 123 tomorrow
  10am"). It becomes a *waiting* task that pops up on the home page at that
  time, with a macOS notification.
- **C4** Capture from inside herdr or the terminal (keybinding / CLI), not
  only from the browser.

### Shape
- **S1** Open the task's artifact page and tell the center agent, in a chat
  box, what to change ("add that this also affects staging").
- **S2** Select a sentence or words and leave an inline comment, like in
  Google Docs. It is either an *instruction* ("rewrite this as a checklist")
  or a *question* ("which account is this?"). The agent applies or answers it
  and resolves the comment.
- **S3** Decide per task whether it needs an Asana task and/or a herdr agent.
  The center agent proposes; I confirm.

### Execute
- **E1** Press **Start**. The center creates the Asana task (if wanted:
  Apps Project Sprints 2026, current week's section, assigned to me). It
  opens a herdr workspace in `~/work/tree` and starts Claude with a
  kickoff prompt that names the repos, branch and slug. The agent follows
  `~/work/tree/AGENTS.md` to fetch and name its folders.
- **E2** While working, the herdr agent updates the artifact: progress,
  decisions, branches, PRs. It does this through command-center tools.
- **E3** The task list shows the live herdr state of each agent: working,
  blocked on approval, idle/done.
- **E4** One click from the task jumps to the agent: focus it in herdr, or
  open it in herdr-web-ui on the phone.
- **E5** When the code is ready (tests pass, review orchestrator
  GOOD_TO_GO, changes staged), the agent reports back. The task moves to
  **ready_for_pr**, and I click **Create PR**.
- **E6** While the PR is open, the center watches it: new review comments or
  red CI → **pr_feedback**. The agent is prompted automatically to fix,
  test, commit, push and reply on GitHub. Every comment and how it was
  handled is recorded on the task. When the PR **merges**, the task is done,
  and the Asana task gets the results and PR links and is completed. Not
  before.

### Follow up
- **F1** "Remind me in a week" on any task → task sleeps and resurfaces.
- **F2** "Check PR comments in 2 hours" → at that time the center prompts
  the existing herdr agent. If that agent is gone, it starts a new one,
  resuming the old Claude session when possible.
- **F3** The home page has a **Now** lane: due reminders, blocked agents,
  tasks in review, follow-ups that fired.

### Find
- **R1** Full-text search across titles, artifacts, comments and links.
- **R2** Filter by area, status, source, repo, has-PR, date.
- **R3** SOC2: list every change task in the security/infra/access areas,
  with its change record, for a date range.

## Out of scope (for now)

- Multi-user editing. The only "sharing" is read-only access for tailnet
  users.
- Replacing Asana for the team (Asana stays the team-facing system).
- Replacing herdr-web-ui (we deep-link into it instead).
- Doing the coding work inside the command center process.
- Code review. The **review orchestrator** (`~/work/review`) already
  runs inside herdr agents. The command center only reads its result and
  links to it (see [04](04-herdr-integration.md#review-orchestrator)).
- herdr-tsk. Evaluated and rejected. The command center owns its own task
  model.

## Success criteria

- Every work request I accept ends up as a task here within a minute.
- I can answer "what am I doing / waiting on / owing people?" from one page.
- No agent-produced PR ends up "lost". Every PR links back to a task, and
  every task closes with its Asana counterpart updated.
- SOC2 change evidence for a quarter can be exported from here.
