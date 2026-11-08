# 08 — Open questions

## Decided (2026-11-07)

| # | Topic | Decision |
|---|---|---|
| 1 | Asana destination | Apps Project Sprints 2026 (`1111111111111111`), current week's section, assigned to me (`asana.assigneeGid`). Good description drafted from the artifact, plus a managed tracking block (artifact link, repos/branches, PRs) and external link attachments. See [05 — Asana](05-center-agent.md#asana). |
| 2 | When is a task done | When its PR(s) **merge**, same as the Asana task. Statuses `ready_for_pr`, `pr_open`, `pr_feedback`. See [03](03-architecture.md#task-lifecycle). |
| 3 | Center-agent auth | My **Claude login** (team account), not an API key. Verified in the phase 0 spike. |
| 3b | Asana auth | Personal Access Token, **already stored** in the Keychain as `command-center-asana`. |
| 4 | Task storage | A separate private git repo (`tasksDir`, e.g. `command-center-data`), never the code repo. **Automatic commits on its branch are authorized; never pushed.** See [03 — Storage](03-architecture.md#storage). |
| 5 | Where workers run | `~/work/tree`, following its `AGENTS.md`. See [04](04-herdr-integration.md#where-workers-run-worktracetree). |
| 6 | PR feedback | **Automatic.** The agent is prompted to fix, test, commit, push to the PR branch and reply on GitHub. Every item and its resolution is recorded on the task (`feedback.jsonl`, artifact "PR feedback" section, Asana summary). See [03 — PR feedback items](03-architecture.md#pr-feedback-items). |
| 7 | Create PR | Always my click (tree AGENTS.md §5). |
| 8 | PR watcher interval | **15 minutes** per open PR. |
| 9 | Tailnet port | `tailscale serve --https=8443` → tailnet listener `127.0.0.1:7789`. Local listener `127.0.0.1:7788`. |
| 10 | What viewers see | Tasks **linked to Asana** are shared (colleagues see them in Asana anyway). Everything else is private, with a per-task override. History, comments, agent chat and herdr details are always owner-only. |
| 11 | Slack replies | **Not allowed** for now. Maybe later. |
| 12 | Worker kind | **Claude by default.** Switchable to **Codex** at any time (global + per task), e.g. when out of Claude credits. See [04 — Worker kind](04-herdr-integration.md#worker-kind-claude-or-codex). |
| 13 | Center-agent provider | **Claude (Haiku) by default.** Switchable to **Codex with a light model**, or another light model, with optional auto-fallback on limit errors. See [05 — Providers](05-center-agent.md#providers-claude-by-default-codex-when-needed). |
| 14 | Codex light model | **luna** for the center agent on Codex (exact id string confirmed in the phase 0 spike). |
| 15 | Areas | backend, mobile, **web** (web UI, `web-trace`, occasional), **batch** (`aws-batch` game-processing pipeline), infra, access, security, soc2, other. |
| 16 | Declined review comments | The agent replies on GitHub right away, then I get a notification (Now lane). No approval gate. |
| — | herdr-tsk | Not used. |
| — | UI | Dark mode by default, mobile-first, PWA, phone access from phase 1. |
| — | Access | Tailnet users read shared tasks. Owner = Tailscale login `owner@example.com` (or local token); pairing a device is optional. See [06 — Access](06-ui-artifacts-comments.md#access-owner-edits-tailnet-reads). |
| — | First stage | Phase 1 = UI server + center agent. herdr integration is phase 2. |

## Still open

Nothing blocking. New questions found during the spikes or the build go here.

## To verify in spikes (not decisions)

- Agent SDK with Claude login from launchd (`claude setup-token`).
- Codex `exec -m <luna id>` with `--output-schema` + internal MCP tools. Quality and
  latency vs Haiku.
- Brain latency and result format for Slack threads.
- Asana: managed `html_notes` block, external link attachments.
- Anchoring library choice.
- herdr items listed in [04](04-herdr-integration.md#spike-checklist-start-of-phase-2),
  plus Codex resume through `herdr agent start --kind codex`.
