# Phase 2 + 3 contracts (binding)

Implements the rest of [07 — Roadmap](../07-roadmap.md): herdr workers,
worker MCP tools, PR watcher, the PR feedback loop, close on merge, and phase
3 (agent follow-ups, SOC2 change records + evidence export, Web Push, herdr
quick capture, morning digest, stale sweep). Read
[contracts.md](contracts.md) (phase 1) and docs 03/04 first; this file only
adds. Where 03/04 and this file differ, **this file wins**.

Conventions are the phase 1 ones: Node 22 ESM, plain JS + JSDoc, zod 4,
pino, Jest tests next to the code (`x.test.js`, ≥90% lines), copyright
header `Copyright NorthernCaptain, 2026 / MIT license.`
(see AGENTS.md), Prettier 4 spaces / no semicolons / double quotes, bash scripts
macOS-safe with `#!/usr/bin/env bash`. Every external process (herdr socket,
`gh`, `git`, `osascript`) goes through an injected function so tests never
touch the real tools.

## Spike results (2026-11-08, herdr 0.9.5, protocol 22)

- Socket `~/.config/herdr/herdr.sock`, newline-delimited JSON.
  Request `{"id","method","params"}` → one line `{"id","result"}` or
  `{"id","error":{"code","message"}}`.
- **A connection that ran `events.subscribe` only streams events**; requests
  sent on it get no answer. So: one long-lived subscription connection,
  plus a short-lived connection per request (what the CLI does).
- `pane.agent_status_changed` **requires `pane_id`** (one subscription per
  tracked pane). `workspace.closed`, `pane.exited`, `pane.closed`,
  `pane.agent_detected` take no params. To change the tracked pane set,
  reconnect with the new list.
- Methods used: `ping`, `workspace.create {cwd, env, focus:false, label}` →
  `.result.workspace/.tab/.root_pane`, `workspace.close {workspace_id}`,
  `workspace.report_metadata {workspace_id, source, tokens, ttl_ms?}`,
  `agent.start {name, kind, pane_id, args?, timeout_ms?}`,
  `agent.prompt {target, text, wait?:{until?:[...], timeout_ms?}}`,
  `agent.get {target}`, `agent.list {}`, `agent.focus {target}`,
  `agent.read {target, ...}`. `target` accepts the agent name or pane id.
- `agent.get` → `.result.agent = { agent:"claude"|"codex", agent_status,
  agent_session:{value} | null, pane_id, workspace_id, cwd, ... }`.
  `agent_status ∈ idle | working | blocked | done | unknown`. The Claude
  and Codex integrations are installed: both report `agent_session.value`.
- Errors seen: `agent_not_found`, `agent_not_ready`, `agent_blocked`,
  `agent_prompt_stalled`, `timeout`.
- `gh` is logged in (ssh). Review orchestrator archive:
  `<reviewsDir>/<basename(repoRoot)>:<branch with / → __>/<ts>.json` with
  `{ timestamp, context:{repo, branch, repoRoot}, result:{ status, ... } }`;
  `reviewsDir` = `~/work/review/reviews` (config `review.archiveDir`).

## Config additions (`server/src/config/config.js` defaults)

```js
herdr:  { socketPath: "~/.config/herdr/herdr.sock", requestTimeoutMs: 15000,
          startTimeoutMs: 60000, promptTimeoutMs: 120000, pollMs: 10000 },
github: { org: "acme", pollMinutes: 15, ghBin: "gh" },
review: { archiveDir: "~/work/review/reviews", dashboardUrl: "http://127.0.0.1:7777/" },
push:   { vapidFile: "<configDir>/vapid.json", subject: "mailto:owner@example.com" },
```
`treeDir` already exists. Runtime settings (whitelisted in app.js, done):
`workers.default_kind`, `github.poll_minutes`, `digest.enabled`,
`digest.time` ("HH:MM"), `stale.days`, `push.enabled`.

## Extension points (done in phase 1 code)

- `createApp({ mounts, taskExtras, boardExtras })`:
  - `mounts: [(api, helpers) => void]` registers routes on the `/api` router
    after the core routes. `helpers = { mode, tailnet, ACTOR, isViewer,
    parse, parseTaskId }`. Owner-only by default (the router already enforces
    roles: viewers only get whitelisted GETs).
  - `taskExtras: [async (id, task) => object]`, merged into the owner's
    `GET /api/tasks/:id`.
  - `boardExtras: [async () => object]`, merged into the owner's
    `GET /api/board`.
- `createApp({ mcpHandler })` mounts `/mcp` on the **local** listener, bearer
  token only.
- Migration 3 (done): tables `agent_outbox`, `pr_claims`,
  `push_subscriptions`; `pr_watch` + `head_sha`, `closed_at`,
  `last_review_at`; index `agent_sessions_task`.
- `FeedbackItemSchema.verify_failures` (done).

Module wiring in `server/src/system.js` is done by the integrator, not by the
module owners. Each module exports a factory and (where it has routes) a
`mount*` function.

---

## A. herdr bridge — `server/src/herdr/`

### `herdrClient.js`
```js
createHerdrClient({ socketPath, connect = net.createConnection, log,
                    timeoutMs = 15000 }) -> {
  request(method, params, { timeoutMs }?) -> Promise<result>   // one connection per call
  ping() -> { version, protocol }        // throws HerdrError("protocol", ...) unless protocol === 22
  workspaceCreate({ cwd, label, env, focus = false }) -> { workspaceId, tabId, paneId }
  workspaceClose(workspaceId)
  reportMetadata(workspaceId, tokens, { ttlMs }?)   // source "command-center"
  agentStart({ name, kind, paneId, args = [], timeoutMs })
      // resolves only when the agent is ready for a prompt: herdr acks
      // agent.start on queue admission, so it polls agent.get(pane) until
      // interactive_ready (not launch_pending); agent_not_ready on a startup
      // dialog or after timeoutMs; agent_pane_busy (the new pane's shell is
      // still starting) is retried within the same timeoutMs
  agentPrompt(target, text, { wait = true, timeoutMs }?) -> result
  agentGet(target) -> AgentInfo | null   // null on agent_not_found
  agentList() -> AgentInfo[]
  agentFocus(target)
  agentRead(target, { lines = 80 }?) -> string
}
class HerdrError extends Error { code, method }   // code from the error object, or "timeout" | "socket"
AgentInfo = { name?, kind, status, sessionId: string|null, paneId, workspaceId, cwd }
```
- Never retries a prompt after an error or timeout (callers read state first).
- `agentPrompt` with `wait` sends `wait: { timeout_ms }`; `agent_prompt_stalled`
  and `timeout` are thrown as HerdrError (callers treat the delivery as
  *uncertain*, see C).

### `herdrEvents.js`
```js
createHerdrEvents({ socketPath, connect, clock, log, client, pollMs = 10000,
                    backoffMs = [1000, 2000, 5000, 15000, 30000] }) -> EventEmitter & {
  start(), stop(),
  track(paneIds: string[])   // replaces the set; reconnects to resubscribe when it changed
}
emits "status"  { paneId, workspaceId, status }      // pane.agent_status_changed
      "exited"  { paneId }                           // pane.exited / pane.closed
      "closed"  { workspaceId }                      // workspace.closed
      "resync"  {}                                   // after (re)connect and on each poll tick
```
- Subscriptions: `workspace.closed`, `pane.exited`, `pane.closed`, plus one
  `pane.agent_status_changed {pane_id}` per tracked pane.
- While the socket is down: poll `client.agentList()` every `pollMs` and emit
  `status` for tracked panes whose status changed, `exited` for tracked panes
  that vanished.

### `agentSessionsRepo.js` (SQLite `agent_sessions`)
```js
createAgentSessionsRepo(db, { clock }) -> {
  create({ task_id, name, workspace_id, pane_id, kind, session_id, state }) -> row
  current(task_id) -> row | null          // newest row with ended_at IS NULL
  byPane(pane_id) -> row | null           // live row for that pane
  live() -> row[]                         // ended_at IS NULL
  update(id, { state?, session_id?, last_seen_at? })
  end(id, state = "gone")                 // ended_at = now
  history(task_id) -> row[]
}
row = { id, task_id, name, workspace_id, pane_id, session_id, kind, state,
        started_at, last_seen_at, ended_at }
```
(Columns: `herdr_agent_name` → name, `herdr_workspace_id`, `herdr_pane_id`,
`claude_session_id` → session_id, for either kind.)

### `outboxRepo.js` (SQLite `agent_outbox`)
```js
createOutboxRepo(db, { clock }) -> {
  enqueue({ task_id, text, reason, dedupe_key? }) -> row   // same (task, dedupe_key) pending → existing row
  pending(task_id) -> row[]          // FIFO
  markSent(id), markFailed(id, error), cancel(id)
  list(task_id, { limit }) -> row[]
}
```

---

## B. Worker identity + prompts — `server/src/workers/`

### `identity.js`
```js
slugify(title, maxWords = 4) -> "fix-upload-retry"          // [a-z0-9-], ≤ 40 chars
defaultBranch(task) -> "t123-fix-upload-retry"
agentName(task) -> "t123-fix-upload-retry"                  // [a-z][a-z0-9_-]{0,31}, truncated
createIdentity({ store, treeDir, fs, exec, random, org = "acme" }) -> {
  newSlug() -> "k7q2"   // 4 × [a-z0-9]; unique vs treeDir entries "*--<slug>" and all tasks' slug
  checkBranch(repo, branch, taskId) -> { ok: true } | { ok: false, reason, suggestion }
      // unique per repo across every other task (task.branch + deliverables[].branch),
      // and not on the remote: `git ls-remote --heads git@github.com:<org>/<repo>.git <branch>` empty
  scanFolders(slug) -> [{ folder, repo, branch, role?, status?, pr? }]
      // treeDir/*--<slug>, parsing .git/agent-task.md when present
}
```
`store.query` returns every task (limit 1000) for the uniqueness check.

### `prompts.js`
Pure functions returning strings; texts exactly as in doc 04 (kickoff,
Create PR, PR feedback, Clean, Send to agent), plus:
```js
kickoffPrompt({ task, repos, branch, slug })
createPrPrompt({ task })                    // includes "Command-Center-Task: T-<id>"
feedbackPrompt({ task, pr, round, items, branch })
cleanPrompt({ task })
sendToAgentPrompt({ task, quote?, comment })
resumePrompt({ task, folder, action })      // "Resuming T-123. cd back into <folder>, then: <action>"
freshContextPrompt({ task, artifact, feedback }) // relaunch without a session (kind switch)
```
Untrusted text (comments, review bodies) is never pasted raw into prompts;
the feedback prompt lists item ids, kinds, paths and URLs only.

---

## C. Worker service — `server/src/workers/workerService.js`

```js
createWorkerService({ store, herdr, events, sessions, outbox, identity,
  settingsRepo, jobRunner, notifier, bus, config, clock, log, localToken }) -> {
  start(), stop()                           // subscribe to herdr events, resync, flush outboxes
  startTask(taskId, { kind? }) -> { session }
  deliver(taskId, text, { reason, dedupeKey? }) -> { status: "sent"|"queued"|"blocked" }
  revive(taskId, { action? }) -> { session }
  action(taskId, name, body?) -> result     // create-pr | address-feedback | clean | focus
                                            //  | send | relaunch-codex | stop
  agentState(taskId) -> { state, kind, name, session_id, pane_id, outbox: n } | null
  states() -> { [taskId]: state }           // for the board overlay
}
```
**startTask** (owner click):
1. Preconditions: status ∈ `inbox | ready | active(no live session)`;
   `task.repos` has a main repo (role main, else first). 409 otherwise.
2. If `wants_asana` and no `asana.gid`: `enqueueOnce(jobRunner,"asana_create")`.
3. `slug = task.slug || identity.newSlug()`, `branch = task.branch ||
   defaultBranch(task)`; `checkBranch` for every `work` repo (main repo is
   work, others ref) → 409 `branch_conflict` with the suggestion.
4. Deliverable for the main repo (`role:"work"`, `disposition:"pending"`,
   `created_at: now`) unless present. `updateTask({ slug, branch,
   deliverables, worker_kind: kind })`.
5. `herdr.workspaceCreate({ cwd: treeDir, label: "T-<id> <title≤40>", env:
   { CC_TASK_ID, CC_URL: "http://127.0.0.1:<localPort>", CC_TOKEN } })`,
   `agentStart({ name: agentName(task), kind, paneId, timeoutMs })`.
   `kind` = argument ‖ `task.worker_kind` ‖ setting `workers.default_kind`.
6. `agentPrompt(kickoff)`; `agentGet` → `session_id`; `sessions.create`;
   `reportMetadata(ws, { task: "T-<id>", status })` (best effort);
   status → `active`; event `agent_started`; `events.track(livePanes)`.
7. herdr failure after the workspace exists: record the session as `gone`
   with the error in `flags.error`; never close the workspace automatically.

**deliver**: always goes through the outbox (persisted first, then
flushed). Flush for a task: live session state `idle | done` → send the oldest
pending with `agentPrompt(text, { wait: false })` → `markSent`; `working` →
wait for the next idle `status` event; `blocked` → do not send, set
`flags.now` "Agent needs you (blocked)", notify; no live session → `revive`
then flush. A HerdrError on prompt → `markFailed` + `flags.error`, never
resent automatically (Leo can retry from the UI).

**Events**: `status` → `sessions.update(state)`, emit bus `agent.updated`
`{ task_id, state }`; `blocked` → Now + notification (once per transition);
`idle|done` → flush outbox. `exited`/`closed` → `sessions.end(gone)`, bus
event. Resync: reconcile `live()` sessions against `agentList()`.

**revive**: new workspace (same env), `agentStart` with resume args when the
session kind equals the target kind and a `session_id` exists
(`claude`: `["--resume", id]`, `codex`: `["resume", id]`); otherwise a fresh
agent plus `freshContextPrompt`. Then `resumePrompt` with the action.

**Usage limits**: after a `blocked`/`idle` status of a **claude** agent,
`agentRead(target, {lines: 40})`; text matching
`/usage limit|rate limit|out of (extra )?usage|credit balance/i` sets
`flags.error` "Claude unavailable: <line>" and `flags.now`; the UI offers
**Relaunch on Codex** (`action relaunch-codex` = set `worker_kind: codex`,
end the current session record, `revive` with a fresh Codex agent).

**Actions** (each logs an event; prompts go through `deliver`):
`create-pr` (status must be `ready_for_pr`) → `createPrPrompt`;
`address-feedback` → current round's open items → `feedbackPrompt`;
`clean` → `cleanPrompt` (status `done`); `close-agent` → `workspaceClose` of
the live agent's workspace, only while herdr reports it `idle`/`done` (409
`agent_busy` / `agent_not_found` otherwise), then the session ends (`gone`,
event `agent_closed`); `focus` → `herdr.agentFocus`;
`send` `{ text, quote? }` → `sendToAgentPrompt`; `stop` → end the session
record only (never closes herdr panes Leo did not ask to close).

Routes (`mountWorkers(api, helpers, { workerService })`):
```
POST /api/tasks/:id/start            { kind? }            -> 202 { session }
POST /api/tasks/:id/actions/:name    { text?, quote? }    -> { ok, delivery? }
GET  /api/tasks/:id/agent                                 -> agentState
```
`taskExtras`: `{ agent: agentState, outbox: [...pending] }`.
`boardExtras`: `{ agents: states() }`.

---

## D. Worker tools (MCP) — `server/src/mcp/`

### `tools.js`
Pure handlers, shared by MCP and REST:
```js
createAgentTools({ store, scheduler, identity, prWatcher, workerService, clock, log }) -> {
  cc_get_task({ task_id }),
  cc_update_artifact({ task_id, section, op, content, base_revision? }),
  cc_log_decision({ task_id, decision, rationale }),
  cc_add_link({ task_id, type, url, label?, role?, repo? }),
  cc_report({ task_id, status, summary, work_repos?, checks?, next_steps? }),
  cc_feedback({ task_id, item_id, status, commit?, reply_url?, note? }),
  cc_schedule({ task_id, at, action, prompt? }),
  cc_create_task({ title, details?, parent_id? }),
}
each: (args, { actor, callerTaskId }) -> plain JSON result; throws AppError
```
Rules (docs 03/04 are the spec):
- `callerTaskId` (header `X-CC-Task`) present and ≠ `task_id` → 403
  `wrong_task`. `actor` = `agent:<name>` (header `X-CC-Agent`, else the
  task's live session name, else `agent:unknown`).
- `cc_get_task` → `{ task, revision: artifactRevision, artifact, open_comments,
  links, deliverables, feedback_open, asana_url }`.
- `cc_update_artifact`: `replace` requires `base_revision` → `stale_revision`
  `{ revision, content }`; `append` may omit it.
- `cc_log_decision` appends `- <ISO date> · <actor> · <decision> · <rationale>`
  to **Decisions**.
- `cc_add_link`:
  - `branch` (with `repo`): `identity.checkBranch` → `{ ok }` or
    `{ ok:false, conflict, suggestion }` (also flags the task). On ok: set
    `task.branch` if it is the main repo's, or the deliverable's branch.
  - `folder` `role:"work"` → add a deliverable for that repo (pending,
    created_at now) if missing.
  - `pr` → `prWatcher.claim(taskId, url, { manual:false })` → claim result.
  - other types → link only.
- `cc_report`: `ready_for_pr` requires `work_repos`; mismatch with
  deliverables (as sets) → flag Now "work repos differ" and keep status
  `active`; else status `ready_for_pr`, `flags.now` "Ready for PR", notify.
  `review` → status `review`, Now. `blocked` → Now + notify. `progress` →
  append summary to **Progress**. Summary always appended to **Progress**.
- `cc_feedback`: item must exist and be `open`; status ∈ fixed | answered |
  declined; `fixed` needs `commit`; comment/review kinds need `reply_url`;
  `ci_failure` allows `fixed` (commit) or `declined` (reply_url). Appends
  the item record (`verified:false`). When every item of the round is
  resolved → `prWatcher.roundResolved(taskId)` (status back to `pr_open`).
- `cc_schedule`: `at` is ISO or a phrase (dateParser); `action ∈
  surface | prompt_agent | center_job`; `prompt` required for `prompt_agent`.
- `cc_create_task`: capture with `source_type:"manual"`, text = title +
  details, link back to the parent (`doc` link "spun off from T-<parent>").

### `mcpServer.js`
`createMcpHandler({ tools, log })` → Express handler for `/mcp` using
`@modelcontextprotocol/sdk` (`McpServer` + `StreamableHTTPServerTransport`,
**stateless**: a new server+transport per request). Tool input schemas in
zod; results as `{ content: [{ type: "text", text: JSON }] }`, errors as
`isError: true` with `{ error, message, details }`. Reads `X-CC-Task` /
`X-CC-Agent` headers.

### REST mirror (for the `cc` CLI and hooks)
`mountAgentTools(api, helpers, { tools })`:
`POST /api/agent/:tool` with the tool args as JSON → result. Owner/bearer
only (core auth). CLI: `cc task <id>`, `cc progress <id> <text…>`,
`cc decision <id> <decision> -- <rationale>`, `cc link <id> <type> <url>
[--role r] [--repo r]`, `cc report <id> <status> <summary…> [--repos a,b]`,
`cc feedback <id> <item> <status> [--commit sha] [--reply url] [--note t]`,
`cc schedule <id> <when> <action> [prompt…]`. They read `CC_TASK_ID` /
`CC_URL` / `CC_TOKEN` from the environment when present.

### Skill + registration
- `skills/command-center/SKILL.md`: the worker protocol (doc 04 kickoff
  rules, tool usage, the PR feedback rules, never commit/push/PR unless
  asked except the feedback standing instruction).
- `install/register-mcp.sh [--dry-run]`: idempotent. Claude: `claude mcp
  add --scope user --transport http command-center http://127.0.0.1:7788/mcp`
  with a `headersHelper` script `install/mcp-headers.sh` that prints
  `{"Authorization":"Bearer <token file>","X-CC-Task":"$CC_TASK_ID"}`.
  Codex: a marked block in `~/.codex/config.toml`
  (`# command-center:begin … # command-center:end`) with `url`,
  `http_headers = { Authorization = "Bearer <token>" }` and
  `env_http_headers = { "X-CC-Task" = "CC_TASK_ID" }`. Installs the skill to
  `~/.claude/skills/command-center/` and `~/.codex/skills/command-center/`
  (symlink). Prints what it changed; `--dry-run` prints only.

---

## E. PR watcher — `server/src/github/`

### `ghClient.js`
```js
createGhClient({ exec, ghBin = "gh", org, log }) -> {
  listPrsByHead(repo, branch) -> [{ number, url, headRefName, headRepository:{ name, owner }, isCrossRepository,
                                    createdAt, body, state, mergedAt, closedAt, headRefOid, author:{login} }]
  getPr(repo, number) -> same + { reviewDecision, statusCheckRollup: [{ name, status, conclusion, detailsUrl, ... }],
                                  reviews:[{ id, author:{login}, state, body, submittedAt, url? }],
                                  comments:[{ id, author:{login}, body, createdAt, url }] }
  reviewComments(repo, number, { since? }) -> [{ id, user:{login}, body, path, line, original_line,
                                    created_at, html_url, in_reply_to_id, commit_id }]
  commitsSince(repo, number, sinceIso?) -> [{ oid, committedDate }]
  prComment(repo, number, body)   // only for the close-out PR link comment? NOT used: agents reply
}
```
All via `exec(ghBin, args)` with `--json` / `gh api` and `JSON.parse`.
`repo` is the bare name; the full name is `${org}/${repo}`.

### `claims.js`
```js
createClaims(db, { clock }) -> { claimOf(url), claimsForTask(taskId), claim({url, task_id, repo, number, branch, manual}), release(url) }
checkCandidate({ task, deliverable, pr, claims, org }) -> { ok:true } | { ok:false, reason }
  // 1 head branch == deliverable.branch and head repo == org/repo (not cross-repo)
  // 2 pr.createdAt > deliverable.created_at
  // 3 body contains "Command-Center-Task: T-<id>"
  // 4 not claimed by another task
```

### `prWatcher.js`
```js
createPrWatcher({ store, gh, claims, db, workerService, jobRunner, asanaService,
                  settingsRepo, notifier, bus, clock, log, org }) -> {
  start(), stop(),                         // timer: settings github.poll_minutes (default 15)
  pollTask(taskId) -> summary              // also "Check now"
  pollAll() -> summary
  claim(taskId, url, { manual }) -> { ok, reason?, deliverable? }
  setNoChange(taskId, repo)                // Leo only
  reopenItem(taskId, itemId)               // no_action -> open (Leo)
  roundResolved(taskId)                    // from cc_feedback
  candidates(taskId) -> [{ repo, url, reason }]   // unclaimed PRs on the branch
}
```
Polled tasks: status ∈ `ready_for_pr | pr_open | pr_feedback`, and `review`
tasks with a claimed PR, until they leave `review` (they close out on merge
the same way, and a failed close-out is retried on the next poll); `done` tasks are never polled. A manual claim
(Leo) skips the candidate checks, so a PR from another branch can be
attached; a PR that is already merged is recorded as merged at claim time
(`merged_at`, `pr_merged`, Asana "Merged: <url>"). Per task:
1. **Discovery + claim** for every `pending` deliverable: `listPrsByHead`;
   the newest candidate passing `checkCandidate` is claimed (`pr_claims`,
   deliverable `{ disposition:"pr", pr:url, claimed_at }`, `pr` link,
   `pr_watch` row). Failed candidates are kept in memory for
   `candidates()`. First claim moves `ready_for_pr → pr_open`; an Asana
   comment "PR opened: <url>" is posted when the task has an Asana gid.
2. **Per claimed open PR** (`getPr`, `reviewComments`): new items since
   `last_comment_at`/`last_review_at`: inline review comments
   (`review_comment`, id `gh-rc-<id>`), reviews with a body or
   CHANGES_REQUESTED (`review`, `gh-rv-<id>`), PR conversation comments
   (`issue_comment`, `gh-ic-<id>`), failed checks on the head SHA
   (`ci_failure`, `ci-<slug40>-<hash10>-<headSha7>`, hash = sha256 of PR url + full
   check name + head; one per check per head). The PR's CI state is `failure`,
   `pending`, `incomplete` (finished but not passed: CANCELLED, ACTION_REQUIRED,
   …) or `success` (every check passed).
   **Classification (deterministic)**: `no_action` when the author is a bot
   (`[bot]` suffix or a known bot list), the comment is a reply from the
   PR author account that starts with `Re:` or replies in a thread (the
   agent's own replies), the review is APPROVED with an empty/LGTM body,
   or the body is only "LGTM"/":+1:"/"👍"/"thanks". Everything else is
   actionable. **Reviewer bots** listed in config `github.actionableBots`
   (default `["review-bot"]`, the AI reviewer on acme repos) are
   treated like people for their review comments and review bodies; their
   replies inside a thread stay `no_action` so agent ↔ bot replies can't
   loop.
3. Actionable new items → `round = max(round)+1`, append items (status
   `open`), status → `pr_feedback`, `flags.now`, notify, and
   `workerService.deliver(feedbackPrompt, { reason:"pr_feedback",
   dedupeKey:"round-<pr>-<round>" })`. If a round is still open, the new
   items join a **queued** round: delivered after the current one resolves
   (`roundResolved` triggers it).
4. **Verification** of agent-resolved items (`verified:false`, status
   fixed/answered/declined), per the doc 03 table: `fixed` → the commit
   exists on the PR (`commitsSince`), and for `ci_failure` the same check
   passed on the current head; replies: `review_comment` → a reply in that
   thread (`in_reply_to_id` == item id) by anyone after the item;
   `review`/`issue_comment`/declined `ci_failure` → a PR conversation
   comment that starts with `Re:` and contains the item URL. Pass →
   append `{ verified: true }`. Fail → `verify_failures+1`; first failure
   reopens the item (status `open`) and re-delivers the prompt; second
   failure leaves it `open`, flags Now "verification failed twice", no
   re-prompt.
5. **Merge / close**: `mergedAt` → deliverable `merged_at`, Asana comment
   "Merged: <url>". `closedAt` without merge → `flags.now` "PR closed
   without merge", notify, keep status. Closing cancels the PR's queued
   feedback prompts. **Reopen** (`state` OPEN after a recorded close; GitHub
   may keep the old `closedAt`, so `state` wins): event `pr_reopened`; the
   PR's oldest open round (minus items this poll's verification reopened)
   is sent again under `resume-<pr>-<round>-<ms>` (the round keys now point
   at cancelled outbox rows), status `pr_open` → `pr_feedback`, and the
   round is recorded as delivered (`via: "pr_reopened"`) or failed. When every deliverable is
   `no_change` or merged (after a fresh discovery pass):
   `enqueueCloseOut(jobRunner, taskId)`.
6. Record `pr_watch` (state, head_sha, ci_state, last_*_at). Errors per
   task are logged and stored in `flags.error`, never stop the loop.

Routes (`mountGithub(api, helpers, { prWatcher })`):
```
POST  /api/tasks/:id/prs/poll                       -> summary   ("Check now")
POST  /api/tasks/:id/prs/claim      { url }         -> claim result (manual)
POST  /api/tasks/:id/deliverables/:repo  { disposition: "no_change" } -> { task }
PATCH /api/tasks/:id/feedback/:item { status: "open" }  (only from no_action)
```
`taskExtras`: `{ prs: [pr_watch rows], pr_candidates: candidates(),
reviews: latest review-orchestrator result per work folder }` (reviews via
`reviewArchive.js`, see below).

### `reviewArchive.js`
`createReviewArchive({ dir, fs }) -> latest({ folder, branch }) -> { status,
timestamp, file, dashboardUrl } | null` — reads the newest
`<dir>/<folder>:<branch with / → __>/*.json`. Folder = `<repo>--<branch>--<slug>`.

---

## F. Phase 3 — `server/src/phase3/` (+ scheduler wiring)

1. **Scheduler actions** (`server/src/scheduler/scheduler.js`): replace the
   `PHASE2_ERROR` branch: `prompt_agent` → `workerService.deliver(task_id,
   payload.prompt, { reason: "follow-up", dedupeKey: "sched-<id>" })`;
   `launch_agent` → `workerService.revive(task_id, { action: payload.prompt
   })`. The scheduler gets `workerService` injected late (like `jobRunner`).
2. **SOC2 change record** (`soc2.js`): for tasks with `area ∈ SOC2_AREAS`
   the artifact's "Change record (SOC2)" section must contain non-empty
   `What:`, `Why:`, `Risk:`, `Rollback:`, `Tested:` lines before **done**.
   `assertChangeRecord(task, artifact)` throws 409 `change_record_missing`
   listing missing fields; called from `close_out.assertClosable` callers
   (app startCloseOut, close_out prepare/apply) and from the store's done
   check? **No** — store stays generic; app + close_out + command call it.
   `exportEvidence({ from, to, areas? })` → `{ generated_at, tasks: [{ id,
   title, area, status, done_at, change_record:{...}, prs:[{url, merged_at}],
   asana_url, decisions }] }`; routes `GET /api/soc2/export?from&to&format=json|md`.
3. **Web Push** (`push.js`): `web-push` npm package. VAPID keys created on
   first start in `config.push.vapidFile` (0600). `GET /api/push/key` →
   `{ publicKey }`; `POST /api/push/subscribe` `{ endpoint, keys }` (owner,
   paired device); `DELETE /api/push/subscribe` `{ endpoint }`;
   `sendAll({ title, body, url })` drops subscriptions after 404/410.
   The notifier fans out to push when `push.enabled`. Service worker
   (`web/public/sw.js`) shows the notification and focuses/opens `url`.
4. **Morning digest** (`digest.js`): daily at `digest.time` (local tz) when
   `digest.enabled`: `buildDigest()` = Now items, overdue reminders, PRs
   waiting on Leo (ready_for_pr, pr_feedback, closed-unmerged), blocked
   agents, stale tasks → notification ("Morning: 3 in Now, 2 PRs…") +
   `GET /api/digest` (latest + on demand). Deterministic, no LLM.
5. **Stale sweep** (`stale.js`): with the digest run (and on demand):
   tasks in `ready | active | waiting(no snooze)` untouched for
   `stale.days` get `flags.now` "Stale: no change in N days" once (event
   `stale_flagged`; not again until the task changes).
6. **herdr quick capture** (`install/herdr-plugin/command-center/`): a herdr
   plugin with a **Quick capture** action that opens a popup pane running
   `cc add` with the current pane's cwd as context. Follow the format of
   the installed plugins (`herdr-web-ui`, `herdr-bar`; inspect
   `~/.config/herdr/plugins*`). `install/install-herdr-plugin.sh` links it.

Routes for phase 3 are mounted with `mountPhase3(api, helpers, deps)`.

---

## G. Web UI (phase 2 + 3)

- **Board rows**: agent overlay chip from `board.agents[taskId]` (working ·
  blocked · idle · done · gone) and `ready_for_pr` / `pr_feedback` badges.
- **Task header actions** by status: **Start** (kind select Claude/Codex,
  default from settings / task), **Create PR** (ready_for_pr), **Address
  feedback** (pr_feedback), **Open in herdr** (live agent), **Relaunch on
  Codex** (when flagged "Claude unavailable"), **Clean folders** (done),
  **Check PRs now** (pr states), **Accept** (review → done, existing PATCH).
- **Agent panel**: state, kind, name, session id, queued prompts, last error.
- **Deliverables panel**: per repo branch / PR / merged / no_change button,
  unclaimed PR candidates with reason and **Claim**.
- **Feedback panel**: rounds → items (kind, author, path:line, status,
  verified, links); `no_action` items have **Reopen**.
- **Reviews**: latest review-orchestrator result per work folder with a link
  to the dashboard.
- **Selection popover**: 4th intent **Send to agent** (only with a live
  agent) → `POST actions/send { text, quote }`.
- **Settings**: worker default kind (exists), PR poll minutes, digest on/off
  + time, stale days, push on/off + "Enable on this device" (service worker
  + `PushManager.subscribe` with the VAPID key), SOC2 evidence export
  (date range → download JSON/MD).
- **Digest**: a "Morning digest" card on Home when today's digest exists.
- SSE events to handle: `agent.updated`, `pr.updated`, `feedback.updated`
  (refresh task data), `digest.updated`.

## Bus events (new)
`agent.updated {task_id, state}`, `pr.updated {task_id}`,
`feedback.updated {task_id}`, `digest.updated {}`. Viewer SSE filtering:
these are owner-only except `pr.updated` for shared tasks.
