# 03 — Architecture

## Component map

```
                ┌──────────────── browser / phone (Tailscale serve) ──────────────┐
                │  Home (Now / Active / PRs / Waiting / Inbox) · Task page        │
                └───────────────▲──────────────────────────────┬──────────────────┘
                                │ SSE (live)                   │ REST
┌───────────────────────────────┴──────────────────────────────▼───────────────────────┐
│ command-center service (Node 22+, ESM, Express)        127.0.0.1:7788 (proposed)     │
│                                                                                      │
│  api/          REST for UI + `cc` CLI                                                │
│  mcp/          HTTP MCP endpoint for herdr worker agents (cc_* tools)                │
│  store/        tasks/ (git, canonical content) + SQLite (index, FTS5, runtime state) │
│  agent/        center agent: job runner (Agent SDK, Haiku), lanes, per-task locks    │
│  herdr/        bridge: CLI wrapper + socket event subscriber                         │
│  scheduler/    durable timers → reminders, follow-ups                                │
│  watchers/     PR watcher (gh): comments, CI, merge                                  │
│  integrations/ asana (PAT/REST) · brain (tracebot-mcp) · gh · review-orchestrator    │
│  notify/       macOS notifications (herdr notification show / osascript), web push   │
└──────┬──────────────┬───────────────────┬──────────────────┬─────────────────────────┘
       │              │                   │                  │
       ▼              ▼                   ▼                  ▼
  herdr server   tracebot-mcp         Asana REST          gh CLI / GitHub
  (workspaces,   (brain_do → Slack    (create/comment/    (PR discovery by branch,
   agents,        threads, wiki)       complete)           comments, CI, merge)
   events)
       │
       ▼
  Claude worker agents, started in ~/work/tree, following its AGENTS.md
  (task folders <repo>--<branch>--<slug>, review orchestrator loop, PR on command)
       └──(cc_* MCP tools / cc CLI)──► command-center
```

## Process model

- One long-running Node process, kept alive by a **launchd** user agent
  so reminders and watchers run even when no terminal is open.
- Listens on `127.0.0.1` only, on two ports. The **tailnet listener**
  (7789) sits behind `tailscale serve --https=8443`: the owner
  `owner@example.com` has full access, other tailnet users read only
  (tasks linked to Asana). The **local listener** (7788) is
  for the CLI, herdr agents (MCP, bearer token) and my desktop browser. See
  [06 — Access](06-ui-artifacts-comments.md#access-owner-edits-tailnet-reads).
- Center-agent work runs as many short **jobs** on a lane-based queue, not
  one long conversation. See
  [05 — Concurrency](05-center-agent.md#concurrency-and-responsiveness).

## Storage

Two stores with a clear split:

### 1. `tasks/`: canonical task content, versioned in git

Task content lives in its **own git repo**, separate from the code repo
(`tasksDir`, e.g. a private `command-center-data` repo next to this one;
`install/setup-tasks-repo.sh` creates it). The store commits on one branch
there (`git.branch`, default `tasks`) and never pushes.

```bash
install/setup-tasks-repo.sh ~/work/command-center-data main
```

Why a separate repo rather than files in the code repo:
- Task content (Slack threads, comments, names) must never be published with
  the code, which is public. A separate repo can't be pushed by accident
  with a code branch.
- The service commits often and automatically. In the code repo that would
  mix with code commits and pick up staged changes.
- History stays clean and separate. `git -C <tasksDir> log -- T-0123/` is the
  full audit trail of one task, which is good SOC2 change evidence.

Layout:

```
tasks/
  T-0123/
    task.json        # metadata: title, kind, area, status, visibility, source, repos, branch, slug,
                     #   deliverables (see "Deliverables"), asana_gid, links, flags
    artifact.md      # the living page
    comments.jsonl   # one JSON object per comment/reply/resolution (append-only)
    feedback.jsonl   # PR feedback items and their resolution (append-only)
    events.jsonl     # activity log (append-only): status changes, agent reports, PR events
    files/           # attachments (screenshots, exports)
```

Commit policy:
- The service is the only writer. Agents and the UI go through the API.
- Writes are **debounced per task** (~15 s after the last write) into one
  commit: `T-0123: agent:t123-upload-retry updated Progress; status → pr_open`.
  Author is `git.authorName` / `git.authorEmail` from config, with an `Actor:`
  trailer (me / center / agent name).
- **Automated commits are allowed on the `tasks` branch only**. The service
  never commits anywhere else and **never pushes**. Backup to a private
  remote is a later, explicit decision.

### 2. SQLite (`data/cc.db`, gitignored): index and runtime state

- **Index (rebuildable from `tasks/`)**: `tasks` table mirroring
  `task.json`, `tasks_fts` (FTS5 over title, artifact, comments, links).
  `cc reindex` rebuilds it.
- **Runtime state** (not in git):

```
agent_sessions   task_id, herdr_agent_name, herdr_workspace_id, herdr_pane_id,
                 claude_session_id, kind, state (working|blocked|idle|done|unknown|gone),
                 started_at, last_seen_at, ended_at
schedules        id, task_id, fire_at, action (surface|prompt_agent|launch_agent|center_job),
                 payload, status (pending|fired|cancelled|failed)
center_jobs      id, task_id, type, lane, status, model, input, output, cost, started_at, ended_at
pr_watch         task_id, repo, number, url, state, last_comment_at, last_checked_at,
                 ci_state, merged_at
```

Artifact **history** comes from git commits, so no separate revisions table
is needed. The UI's history drawer reads `git log -p -- T-0123/artifact.md`.

**Concurrency revisions are content hashes, not counters.** Git commits are
debounced, so they can't serve as the concurrency token. A counter kept in
memory could be reused after a restart, for different content.
- `revision` = the first 16 hex chars of `sha256(artifact.md bytes)`, the
  same idea as an HTTP ETag. It is computed from the file **on disk**, so
  it always matches the current content, committed or not. It survives
  restarts without any state, and different content can never get the same
  revision.
- Every artifact write takes the per-task lock, re-reads the file, compares
  its hash with the caller's `base_revision` (mismatch → `stale_revision`
  with the current hash and content), then writes atomically (temp file +
  `fsync` + `rename`) and returns the new hash. The check and the write
  happen under one lock, so nothing can slip in between.
- Reverting to an identical earlier text gives an identical hash. That is
  correct: the caller's view matches what is on disk.
- `task.json` writes use the same hash + lock + atomic-rename scheme.
  `comments.jsonl` / `feedback.jsonl` / `events.jsonl` are append-only (`O_APPEND` under the
  lock) and need no revision.

**Restart recovery.** On startup the service runs `git -C tasks status
--porcelain`. Uncommitted changes from writes that happened before a crash
get a **recovery commit** (`Actor: recovery`), and the index is
re-synced. Leftover temp files from an interrupted rename are deleted:
the target file is either fully old or fully new.

## Task lifecycle

**Areas** (`task.json.area`): `backend` · `mobile` · `web` (web UI, `web-trace`)
· `batch` (`aws-batch`, the game-processing pipeline in AWS Batch) · `infra` · `access` (AWS / Tailscale permissions) · `security` · `soc2` · `other`.
The center agent suggests the area from content and repos, and I can change it.

Statuses follow the real engineering flow. A code task is **done only when
its PR(s) are merged**, the same rule as the Asana task.

```
 capture
    │
    ▼
  inbox ──► ready ──Start──► active ──agent: GOOD_TO_GO, staged──► ready_for_pr
    │         │                │                                       │ [Create PR] (my click)
    │         │                │                                       ▼
    │         │                │          pr_feedback ◄──new comments / CI red── pr_open
    │         │                │               │                                   ▲  │
    │         │                │               └── agent: fix, test, review, ──────┘  │
    │         │                │                   commit, push, reply on GitHub      │
    │         │                │                                                       │ all deliverables merged
    │         │                └── non-code deliverable ──► review ──[Accept]──► done ◄┘
    │         │
    └─────────┴──► waiting (until time / person) ──fires──► back + "Now" lane
                     any ──► cancelled
```

| Status | Meaning | Who moves it |
|---|---|---|
| `inbox` | captured; enrichment may still run (badge) | capture |
| `ready` | shaped, ready to start | me / center agent proposal |
| `waiting` | parked until a time or a person; reminders live here | me, schedules |
| `active` | herdr agent (or I) working. The watcher keeps polling it (so `ready` and `waiting`) while a claimed PR is open or a deliverable still waits for its PR: a PR opened mid-work is claimed, and new review feedback moves the task to `pr_feedback` | Start |
| `ready_for_pr` | agent finished: tests pass, review orchestrator GOOD_TO_GO, changes staged. Waiting for my **Create PR** | agent `cc_report` |
| `pr_open` | PR(s) open, watcher polling comments / CI / merge | PR discovered |
| `pr_feedback` | new actionable review comments or red CI. The agent is prompted automatically to fix, test, commit, push and reply on GitHub. Returns to `pr_open` when every feedback item is resolved. The "PR feedback" Now flag clears then, in any status, and a `feedback_addressed` event is logged. | PR watcher / agent `cc_feedback` |
| `review` | non-code deliverable done, waiting for my accept. With a claimed PR: new feedback moves it to `pr_feedback`; the agent working again moves it to `active` (`pr_open` while a claimed PR is open, so the watcher keeps polling), and its next `review` report brings it back | agent `cc_report` |
| `done` | every deliverable resolved (merged PR or confirmed no-change), or accepted | PR watcher / me |
| `cancelled` | dropped | me |

- **reminder** tasks: `inbox → waiting(due) → Now → done`.
- **todo** tasks (manual, no agent): `ready → active → done`, with optional
  Asana and follow-ups.
- **PR closed without merge**: notify and show in Now. The status stays
  `pr_open` with a "closed" badge until I decide (reopen / cancel).
- The **herdr agent state** (working / blocked / idle / done / gone) is an
  *overlay* on the row, not a status. "Blocked on approval" goes to Now.
- **Creating the PR** happens only on my click (**Create PR**), sent to the
  agent as an explicit instruction, as the tree `AGENTS.md` §5 requires.
- **Review feedback on an open PR** is handled automatically. This is my
  standing instruction (decided 2026-11-07): the agent fixes, tests,
  commits, pushes to the existing PR branch, and replies to the comments
  on GitHub. Each feedback prompt states that instruction explicitly, so the
  agent is acting on my command per the tree AGENTS.md. The agent never
  pushes to a default branch and never force-pushes.

## Key flows

### Capture from Slack link
1. `POST /api/tasks {text:"https://acme.slack.com/archives/..."}` creates
   `tasks/T-0123/` (`inbox`, `source=slack`) and returns at once. No LLM in
   this path.
2. Background `enrich` job: `brain_do` "read this thread, return JSON
   {summary, asks, people, systems, links, deadline}". The job **parks**
   while Brain works and resumes when the scheduler sees the result, so it
   does not hold a worker slot.
3. Haiku classifies area/kind, suggests repos (using the repo table in
   `~/work/tree/AGENTS.md` §0), proposes `wants_asana` /
   `wants_agent` and a branch name, and writes `artifact.md` from the
   template.
4. SSE pushes updates and the "enriching" badge clears.

### Start (code task)
1. If `wants_asana` and no `asana_gid` yet: create the Asana task (see
   [05 — Asana](05-center-agent.md#asana)).
2. Assign a unique 4-char `slug` (checked against
   `~/work/tree/*--<slug>` and existing tasks) and a **unique
   branch**: `t<id>-<2–4 word kebab summary>` (e.g. `t123-fix-upload-retry`).
   The task id prefix makes it unique across tasks. Before saving, check it
   against every other task's branches for the same repo and against the
   remote (`git ls-remote --heads git@github.com:acme/<repo>.git
   <branch>` must be empty). Save both in `task.json`. See
   [Branch and PR identity](#branch-and-pr-identity).
3. herdr: workspace with `cwd=~/work/tree`, env `CC_TASK_ID`,
   `CC_URL`, `CC_TOKEN`. Start the worker (**Claude by default, Codex
   when switched**, see [04 — Worker kind](04-herdr-integration.md#worker-kind-claude-or-codex))
   and send the kickoff prompt with
   repo(s), branch and slug (see [04](04-herdr-integration.md)). The agent
   then follows the tree `AGENTS.md`.
4. Status `active`. Record the `agent_sessions` row.

### Worker reports back
- During the work: `cc_update_artifact`, `cc_log_decision`, `cc_add_link`.
- Finished with code: `cc_report(status:"ready_for_pr", summary, checks)`.
  The skill requires tests to pass and review GOOD_TO_GO first. The task
  shows up in Now with **Create PR**.
- Finished without code: `cc_report(status:"review", summary)` → **Accept**.

### PR open → merged (PR watcher)
1. **Create PR** click → `herdr agent prompt <agent> "Create the PR now …"`.
2. The watcher finds **candidate** PRs by branch (`gh pr list --repo
   acme/<repo> --head <branch> --state all --json
   number,url,headRefName,headRepository,createdAt,body,state,mergedAt`) for
   every deliverable repo, so discovery does not depend on the agent
   calling `cc_add_link`. A candidate becomes the deliverable's PR only
   after it passes the **claim checks** in
   [Branch and PR identity](#branch-and-pr-identity). Status → `pr_open`.
   The Asana comment gets the PR links.
3. Polls every **15 min** (configurable) per open PR: new reviews, review
   comments and issue comments since `last_comment_at`, CI rollup, state.
4. New feedback is recorded as **feedback items** (see below), each
   classified as actionable or not by the center agent (bot noise,
   approvals and "LGTM" are recorded as `no_action`). If any item is
   actionable or CI is red: status `pr_feedback`, a notification, and the
   agent is prompted **automatically**. If it is busy, the prompt is queued
   until it goes idle. If it is gone, it is revived (see 04). The prompt
   lists the item ids and URLs and instructs: read them with `gh`, fix,
   run tests and the review loop until GOOD_TO_GO, commit, push to the PR
   branch, reply to each comment on GitHub (what changed + commit, or why
   not), then `cc_feedback` for each item.
5. When every item of the round is resolved (`fixed` / `answered` /
   `declined` / `no_action`), the status goes back to `pr_open`. The watcher
   verifies the agent's claims on the next poll, checking only what that
   item's kind and status require (see the table in
   [PR feedback items](#pr-feedback-items)). `no_action` items are never
   verified.
6. **Closing** is evaluated against **deliverables**, not "whatever PRs
   we've seen so far" (see below). When every deliverable is resolved:
   `done` and the `close_out` job writes the artifact Result (only when it
   is still empty: a written Result is kept), posts the conclusion on the
   Asana task (rich text: outcome, details with PR / doc links, what is
   still open), completes the Asana task, and commits. Then **Clean folders** is offered (prompt the agent to run tree
   AGENTS.md §6). Default is to leave the folders.

### PR feedback items

Every review comment, review and failed CI run on a claimed PR is recorded
on the task, so the task page and the Asana trail show what feedback came
in and how each piece was handled. Items live in `tasks/T-0123/feedback.jsonl`
(append-only; the latest record per item id wins) and are rendered in the
artifact's **PR feedback** section:

```json
{ "id": "gh-rc-2401", "pr": ".../pull/812", "round": 2, "kind": "review_comment",
  "author": "ron", "url": "https://github.com/…#discussion_r2401", "path": "src/upload.js", "line": 42,
  "summary": "retry should back off exponentially", "actionable": true,
  "status": "fixed", "commit": "a1b2c3d", "reply_url": "https://github.com/…#discussion_r2410",
  "note": "switched to exponential backoff with jitter", "verified": true, "at": "…" }
```

- `status`: `open` → `fixed` | `answered` | `declined` | `no_action`.
  `declined`: the agent replies on GitHub right away (decided, no approval
  gate), and the item is surfaced in Now with a notification so I see what
  it pushed back on.
- **What each resolution requires** (and what the watcher verifies), by
  item kind:

  | Kind | `fixed` | `answered` / `declined` | `no_action` |
  |---|---|---|---|
  | `review_comment` (inline thread) | commit on the PR + reply in that thread | reply in that thread | — |
  | `review` (review body, changes requested) / `issue_comment` | commit on the PR + a PR conversation comment referencing the item | PR conversation comment referencing the item | — |
  | `ci_failure` | commit on the PR **and** the check passing on the new head SHA. No reply needed. | `declined` only (e.g. flaky or unrelated check): a PR conversation comment explaining why | — |

  - `no_action` is set **only by the watcher** (approvals, LGTM, bot noise,
    the agent's own replies, comments outside the PR's scope), never by the
    agent. It needs no commit or reply and is **never re-verified**, so it
    can't loop. I can flip a `no_action` item to `open` from the task page
    if the classifier got it wrong.
  - Verification checks only what the table requires for that kind and
    status. A missing requirement reopens the item **once** and flags it in
    Now. A second failure leaves it flagged for me instead of re-prompting
    the agent.
  - "Referencing the item" means the comment links the original comment
    URL (or check run URL) and starts with `Re:`. That is what lets the
    watcher match it.
- `round` groups the items from one `pr_feedback` cycle. The artifact shows
  "Round 2: 3 comments · 2 fixed, 1 answered".
- On close-out the Asana comment includes a one-line feedback summary per
  PR.

### Deliverables (multi-repo tasks)

Each code task tracks one **deliverable per work repo** in `task.json`:

```json
"deliverables": [
  { "repo": "aws-lambda",     "branch": "t123-fix-upload-retry", "role": "work",
    "created_at": "…", "disposition": "pr",
    "pr": "https://github.com/acme/aws-lambda/pull/812", "claimed_at": "…", "merged_at": "…" },
  { "repo": "infrastructure", "branch": "t123-fix-upload-retry", "role": "work",
    "created_at": "…", "disposition": "pending", "pr": null, "claimed_at": null, "merged_at": null }
]
```

- **Created** at Start for the main repo. Added when a `ref` repo is
  promoted to `work` (the agent reports it with `cc_add_link(type:"folder",
  role:"work")` after my OK, and the scan of
  `~/work/tree/*--<slug>/.git/agent-task.md` `folders:` cross-checks
  it).
- **Disposition:** `pending` → `pr` (a **claimed** PR, see below) →
  merged; or `no_change`. Only **I** can set `no_change`, either directly
  or by confirming an agent's suggestion.
- The agent's `cc_report(status:"ready_for_pr")` must list its work repos.
  If that list and `deliverables` differ, the task is flagged in Now and is
  not closed.
- **Close condition:** right before evaluating it, the watcher runs a
  fresh discovery and claim pass for **every** deliverable repo. The task
  closes only if every deliverable is `no_change` or has a **claimed,
  merged** PR. Otherwise it stays `pr_open` with a progress badge ("1 of 2
  merged"), and a merged PR alone completes nothing.
- Asana completion follows the same condition. Each individual PR merge
  only adds an Asana comment.

### Branch and PR identity

A branch name alone is not proof that a PR belongs to a task. Two tasks
can have similar titles, and `--state all` also returns old merged PRs. So:

**Unique branches.**
- Default branch is `t<id>-<summary>`. The task id makes it unique among
  command-center tasks.
- Every branch, the default and any override, is checked before being
  accepted. It must be unique **per repo** across all tasks in the SQLite
  index (a unique index on `(repo, branch)` over all tasks, done ones
  included), and it must not exist on the remote (`git ls-remote --heads`).
- **Overrides.** A repo's instructions may force another format (tree
  AGENTS.md §2a). The agent reports it with `cc_add_link(type:"branch",
  repo, url:<branch>)` *before* creating the branch. The service runs the
  same checks and answers `ok`, or `conflict` with a suggestion that keeps
  `t<id>` in it. A conflicting override is never recorded silently. The
  task is flagged and the agent is told to pick another name.

**Claiming a PR.** A candidate PR from discovery satisfies a deliverable
only if all of these hold:
1. `headRefName` equals the deliverable's recorded branch, and the head
   repository is `acme/<repo>` (not a fork).
2. `createdAt` is **after** the deliverable was created (Start, or
   promotion to `work`). This rules out old PRs on a reused name.
3. The PR body contains the task marker `Command-Center-Task: T-123`. The
   Create PR prompt tells the agent to add it, and the `pr` skill's body
   keeps it.
4. It is not already claimed by another task. Claims live in SQLite with a
   unique index on the PR URL, mirrored into `task.json`.

A candidate that fails a check is **not** used. It shows on the task page as
"unclaimed PR on this branch", with a reason, and I can claim it manually
(one click, recorded in events) or ignore it. A PR URL the agent reports
via `cc_add_link(type:"pr")` is named on purpose, so checks 2, 3 and the
branch half of 1 do not apply: a task may work on an existing PR on another
branch (addressing review on someone's PR, say). It must still be in
`acme/<repo>` (not a fork), match a pending deliverable for that repo, and
not be claimed by another task. Only claimed PRs count toward deliverables,
Asana comments and closing.

A claimed PR on another branch (agent-reported or manual) moves the
deliverable, and `task.branch` when it is the main repo, onto the PR's head
branch. Registering that branch afterwards (`type:"branch"`, or a work
folder with `branch`) is accepted without the remote check, and clears a
"Branch conflict: … in <repo>" Now flag. The Asana sync then removes the
`<repo> @ <old branch>` link it had attached; links with any other name
are left alone.

### Follow-up fires
The scheduler picks `schedules` where `fire_at <= now`:
- `surface`: back to the Now lane, with a notification.
- `prompt_agent`: `herdr agent prompt` if the agent is alive and idle.
  Otherwise queue it until idle (event-driven), or revive.
- `launch_agent`: revive with `--resume <claude_session_id>` or start fresh
  with the artifact.
- `center_job`: Haiku does it alone (e.g. "summarize what changed on PR
  #812").

## API surface (sketch)

REST (UI + CLI):
```
GET    /api/tasks?status=&area=&q=           list/search
POST   /api/tasks                            capture (text, url, hints)
GET    /api/tasks/:id                        task + artifact + comments + links + sessions + PRs
PATCH  /api/tasks/:id                        status/fields
GET    /api/tasks/:id/history                git log for the task (owner-only)
POST   /api/tasks/:id/chat                   instruction/question to center agent (streams)
POST   /api/tasks/:id/comments               inline/general comment
POST   /api/tasks/:id/schedules              follow-up / reminder
POST   /api/tasks/:id/asana                  create Asana task now
POST   /api/tasks/:id/start                  herdr launch                (phase 2)
POST   /api/tasks/:id/actions/:name          create-pr | address-feedback | clean | focus  (phase 2)
POST   /api/command                          home-page command bar ("remind me…", "move T-12 to waiting")
GET    /api/events (SSE)                     live updates
```

MCP (`/mcp`, for workers): see [04](04-herdr-integration.md#worker--center-mcp-tools).

## Repository layout (proposed)

```
server/src/            express app, api/, mcp/, store/, agent/, herdr/, scheduler/, watchers/, integrations/
server/src/**/x.test.js  tests next to code (jest)
web/                   Vite + React SPA
cli/cc.js              `cc` CLI
skills/command-center/SKILL.md   worker-agent protocol, installed at user level
install/               launchd plist, MCP registration, task data repo setup, tailscale serve helper
tasks/                 default tasksDir (a standalone git repo, gitignored); set tasksDir to keep it elsewhere
data/                  (gitignored) cc.db, logs
docs/                  these plans
```

Conventions follow the review orchestrator (Node ESM, Express 5, zod, pino,
Jest, Prettier 4-space/no-semi) and the global rules (copyright headers,
tests as `<function>.test.js` next to the code, ≥90% coverage, bash/node
only, macOS-compatible scripts).
