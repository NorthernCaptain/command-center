# Implementation contracts (phase 1)

This is the binding interface spec between modules. Implementers code
**against these signatures** and mock the other side in tests. If a contract
must change, change it here first and say so in your report.

Data shapes: `server/src/contracts/schemas.js` (zod 4). Lifecycle, lanes and
visibility: `server/src/contracts/lifecycle.js`. Shared utils:
`server/src/events/bus.js`, `server/src/util/{clock,errors,logger}.js`,
`server/src/config/config.js`.

## Conventions (all modules)

- Node ≥ 22 ESM, plain JavaScript with JSDoc. No TypeScript.
- Every source file starts with:
  ```js
  /**
   * Copyright NorthernCaptain, 2026
   * MIT license.
   */
  ```
- Prettier style: 4 spaces, no semicolons, double quotes, 80 columns.
- **Factories with injected dependencies**: `createX({ deps... })`. Never
  import a side-effecting singleton. Inject `fs`, `exec`, `fetch` and
  `clock` where needed. This keeps mocking trivial under native ESM Jest
  (`jest.unstable_mockModule` is not used).
- Tests: Jest, file `<module>.test.js` **next to** the module. Cover ≥90%
  of lines in your modules. Real filesystem/git/SQLite in a temp dir is
  fine and preferred over mocks for the store. **Never** call real
  network services, the real `claude`/`codex`/`herdr`/`security`/
  `osascript` binaries, or touch `~/.config`, `~/.claude*`, `~/.codex`
  or the repo's real `tasks/` and `data/` in tests.
- Run tests: `npm test` (server: `npm run test:server -- <path>`, native ESM; web: `npm run test:web -- <path>`, babel + jsdom).
- Times are ISO-8601 strings with offset (UTC `Z` is fine). Task ids are
  positive integers. Human key `T-123` via `taskKey(id)`. Folder
  `T-0123` via `taskDirName(id)`.
- Errors: throw the classes in `util/errors.js` (`NotFoundError`,
  `StaleRevisionError`, `ValidationError`, `ForbiddenError`, `LimitError`,
  `AppError`). The HTTP layer maps `.status` / `.code`.
- No new npm dependencies without asking the integrator. Installed:
  express 5, better-sqlite3, zod 4, pino, @modelcontextprotocol/sdk,
  @anthropic-ai/claude-agent-sdk, chrono-node, markdown-it,
  diff-match-patch, react 19, vite 8, jest 29, supertest, testing-library.

## Module ownership

| Area | Path | Owner |
|---|---|---|
| Store (files, git, sqlite, index) | `server/src/store/` | agent: store |
| Scheduler, date parsing, notifications | `server/src/scheduler/` | agent: scheduler |
| Center agent (runner, providers, jobs) | `server/src/agent/` | agent: center |
| Integrations (Asana, Brain, keychain, repo table) | `server/src/integrations/` | agent: integrations |
| HTTP (listeners, auth, routes, SSE), CLI, entry | `server/src/http/`, `cli/`, `server/src/index.js`, `install/` | agent: http |
| Web UI | `web/` | agent: web |
| Contracts, utils, config | `server/src/contracts/`, `util/`, `events/`, `config/` | integrator |

## Bus events

`bus.emit(type, { task_id, data })`. Types:

| type | data |
|---|---|
| `task.created` | `{ task }` |
| `task.updated` | `{ task, changed: string[] }` |
| `artifact.updated` | `{ revision, actor, sections?: string[] }` |
| `comment.added` | `{ comment }` (folded thread node, see store) |
| `comment.updated` | `{ comment }` |
| `event.added` | `{ event }` |
| `job.updated` | `{ job }` (public job view) |
| `job.delta` | `{ job_id, text }` (streamed text, best effort) |
| `schedule.updated` | `{ schedule }` |
| `settings.updated` | `{ settings }` |
| `task.hidden` | `{ task_id }` (SSE-only, viewers: task stopped being shared) |

The SSE layer filters per role. Viewers get only `task.created`/`task.updated`
for shared tasks (with `viewerTask()` applied) and `artifact.updated` for
shared tasks (without actor).

## Store — `server/src/store/`

### `createStore({ tasksDir, db, bus, clock, git, log })` → `store`

`git` is the committer (below). `db` is from `openDb`. The store owns all
writes to `tasks/` and the index tables.

```
store.createTask(input /* TaskCreateSchema + {title, kind, area, status?, due_at?,
                  source:{type,url,text}} already resolved by caller */, actor)
   -> { task, revision, artifact: { content, revision } }
   // allocates next id, writes T-xxxx/{task.json, artifact.md (template),
   // comments.jsonl, feedback.jsonl, events.jsonl}, indexes, emits task.created,
   // appends event {type:"created"}.
store.getTask(id) -> { task, revision }            // NotFoundError
store.updateTask(id, patch /* TaskPatchSchema */, { actor, baseRevision?, reason? })
   -> { task, revision }
   // validates, applies lifecycle.assertTransition when status changes,
   // sets prev_status when entering "waiting", done_at when entering "done",
   // clears flags.now when leaving now-worthy states only if patch says so.
   // baseRevision optional for task.json (when given, mismatch -> StaleRevisionError).
   // emits task.updated, appends event {type:"updated", data:{changed}}.
store.getArtifact(id) -> { content, revision }
store.writeArtifact(id, content, { actor, baseRevision /* required */ })
   -> { revision }          // StaleRevisionError({content, revision})
store.updateArtifactSection(id, { section, op: "replace"|"append", content,
                                   baseRevision /* required for replace */ }, actor)
   -> { revision }          // section = heading text of a "## " section;
                            // missing section on replace/append -> created at end
                            // (before "## Result" if present).
store.listSections(id) -> [{ name, start, end }]
store.appendComment(id, record /* CommentCreateRecord minus id/at */, actor)
   -> comment               // generates id "c_<random>", at
store.setCommentStatus(id, commentId, { status, resolution }, actor) -> comment
store.listComments(id) -> [thread]  // thread = { ...createRecord, status,
                                    //   resolution, replies: [create records] }
store.appendFeedback(id, item) / store.listFeedback(id) -> latest per item id
store.appendEvent(id, { type, data }, actor) -> event
store.listEvents(id, { limit = 50 }) -> newest first
store.getHistory(id, { limit = 50 }) -> [{ sha, at, actor, message }]
store.getCommitDiff(id, sha) -> string (diff limited to the task folder)
store.withTaskLock(id, async fn) -> result   // per-task async mutex (re-entrant)
// prev_status is service-owned: patches setting it are rejected (ValidationError);
// recorded only when entering waiting from an open status, cleared on leaving.
// jsonl files: a torn last line is repaired on recover() (moved to <file>.corrupt).
store.query({ status?: string[], area?: string[], kind?: string[], q?: string,
              lane?: string, shared_only?: boolean, done_since?: ISO,
              limit = 200, offset = 0 }) -> { tasks: [task], total }
   // via SQLite index; q uses FTS5 over title, artifact, comments, link labels
store.board({ shared_only?: boolean, done_days = 7 }) -> { now:[], active:[], prs:[],
              ready:[], inbox:[], waiting:[], done:[] }  // laneOf(); sorted
store.reindex() -> { count }           // rebuild index from tasks/ on disk
store.recover() -> { committed: boolean, removedTemp: number }  // startup
store.close()
```

Revisions are **content hashes**: first 16 hex chars of sha256 of the file
bytes (`artifact.md` / `task.json`). Writes: lock → re-read + hash compare →
write temp + fsync + rename → `git.touch(id, actor, summary)`.

Artifact template (on create): see `docs/05-center-agent.md#artifact-template-v1`.
Title line `# T-123 — <title>`, then header quote with Source / Area, then
sections: Summary, Context, Acceptance, Plan, Decisions, Progress, Links,
PR feedback, Result (Change record (SOC2) only for areas infra, access,
security, soc2).

### `createGitCommitter({ tasksDir, exec, clock, debounceMs, author, log })`

```
git.ensureRepo()            // tasksDir must be the root of its own git work tree
                            // (the standalone task data repo; in tests a plain
                            // `git init` dir). Refuses to commit unless the
                            // current branch === config git.branch (default
                            // "tasks").
git.touch(id, actor, summary)   // schedule debounced commit for T-xxxx
git.flush() -> Promise          // commit everything pending now
git.recoverUncommitted() -> boolean   // commit leftovers with Actor: recovery
git.log(id, limit) / git.diff(id, sha)
```

Commit message: `T-0123: <summaries joined by "; ">` + blank line +
`Actor: <actor>` trailer lines (one per distinct actor). Author from config.
Only paths under the task folder are added (`git add -- T-0123`). Never
push. Never commit on a branch other than the configured one.

### `openDb(path)` → better-sqlite3 db with migrations

Tables (owner: store; other modules use the repositories below):
- `tasks_index(id PK, title, kind, area, status, visibility, shared, lane,
  due_at, updated_at, created_at, done_at, json)` and `tasks_fts` (FTS5:
  `title, public_body, private_body`; public = artifact + labels of
  pr/branch/asana/doc links; private = comment bodies + other labels).
  Viewer (`shared_only`) searches match `{title public_body}` only.
- `schedules(id PK autoinc, task_id, fire_at, action, payload_json, status
  ['pending','fired','cancelled','failed'], note, created_at, fired_at,
  error)`
- `center_jobs(id TEXT PK, task_id, type, lane, status
  ['queued','running','parked','done','failed','cancelled'], provider,
  model, input_json, output_json, park_json, error, usage_json,
  created_at, started_at, ended_at)`
- `settings(key PK, value_json)`
- `devices(id PK, name, token_hash, created_at, last_seen_at, revoked_at)`
- `pair_codes(code_hash PK, expires_at, used_at)`
- `agent_sessions`, `pr_watch` (phase 2; create empty).

Repositories (also in `store/`), each `createXRepo(db, { clock })`:
- `schedulesRepo`: `add`, `get`, `listPending(dueBefore?)`, `listForTask`,
  `markFired`, `markFailed`, `cancel`.
- `jobsRepo`: `insert`, `update(id, patch)`, `get`, `list({task_id,
  status, limit})`, `listByStatus(statuses)`.
- `settingsRepo`: `get(key, default)`, `set(key, value)`, `all()`.
- `devicesRepo`: `add({name, tokenHash})`, `findByTokenHash`, `touch`,
  `list`, `revoke`; `pairCodes.add(codeHash, expiresAt)`,
  `pairCodes.consume(codeHash) -> boolean` (single use, unexpired).

## Scheduler — `server/src/scheduler/`

```
createDateParser({ clock, timezone }) -> {
  parseCapture(text) -> { isReminder: boolean, title: string, due_at: ISO|null,
                          matchedText: string|null }
     // "remind me to talk to Ron about 123 tomorrow 10am" -> reminder,
     // title "Talk to Ron about 123", due tomorrow 10:00 local.
     // "in 2h", "next monday", "on Friday at 3pm", "tomorrow" (09:00 default).
     // Uses chrono-node with forwardDate; strips the date phrase + "remind me (to)".
  parseWhen(text) -> ISO|null   // for snooze/schedule inputs: "2h", "1w",
                                // "tomorrow 9am", "next week" (Mon 09:00)
}
createNotifier({ exec, log }) -> { notify({ title, body, sound }) -> Promise<boolean> }
   // tries `herdr notification show <title> --body <body> --sound <request|done|none>`,
   // falls back to `osascript -e 'display notification ...'` (escape quotes!).
createScheduler({ schedulesRepo, store, bus, notifier, jobRunner, clock, log,
                  tickMs }) -> {
  start(), stop(), tick() -> Promise<number fired>,
  add({ task_id, fire_at, action, payload, note }) -> schedule,
  cancel(id), listForTask(task_id),
  remind(taskId, dueAt)   // helper: due-date "surface" at dueAt (payload.due)
  reconcileDue(taskId, dueAt, { ensure })  // after due_at/kind
                          // changes: move/cancel the due reminder only
}
```

Action semantics (phase 1):
- `surface`: in the store, set `flags.now = true` and
  `flags.now_reason = payload.reason || note || "Reminder"`. If the status
  is `waiting`, set it to `prev_status || "ready"`. Clear `snooze_until`.
  Notify. Emit `schedule.updated`.
- `center_job`: `jobRunner.enqueue(payload.job_type, payload.input,
  { task_id })`.
- `prompt_agent` / `launch_agent`: phase 2. Mark `failed` with
  `error: "not available in phase 1"`.
- Missed schedules (fire_at in the past at startup) fire on the first tick.
  A failing action marks the schedule `failed` with the error. It never
  throws out of `tick()`.

## Center agent — `server/src/agent/`

### Providers — `agent/providers/`

```
provider = {
  name: "claude-sdk" | "claude-cli" | "codex",
  run({ system, prompt, schema /* JSON Schema object */, model, signal,
        onDelta?(text), mcpServers? /* {name: {type:"http", url, headers}} */,
        allowedTools? /* exact mcp__server__tool names; nothing else is callable */,
        timeoutMs })
     -> { output /* parsed object matching schema */, usage, model, raw? }
     // throws LimitError on usage/credit/rate-limit failures,
     // AppError("provider_failed") otherwise.
}
createClaudeSdkProvider({ query /* injected from @anthropic-ai/claude-agent-sdk */, cwd })
   // options: { model, maxTurns, allowedTools: [] (or the mcp tool names),
   //   settingSources: [], outputFormat: {type:"json_schema", schema},
   //   includePartialMessages: true, mcpServers, abortController, cwd }.
   // Uses the user's Claude login (no API key). VERIFIED in spike:
   // `result.structured_output` holds the object; init.apiKeySource "none".
createClaudeCliProvider({ spawn })   // `claude -p --model <m> --output-format json
                                     //  --json-schema ...` (verify flags via --help)
createCodexProvider({ spawn, tmpDir, codexHome, authFile?, codexSettings? })
   // runs with an isolated CODEX_HOME (<dataDir>/codex-home: minimal config.toml,
   // NO mcp_servers, symlink to ~/.codex/auth.json). `-c mcp_servers={}` was
   // verified NOT to remove servers (codex-cli 0.162.1). Prompt via stdin with "-".
   // `codex exec -m <model> --skip-git-repo-check --sandbox read-only --ephemeral
   //   --output-schema <file> -o <outfile> <prompt>` with stdin = /dev/null
   //   (VERIFIED: without closing stdin it blocks on "Reading additional input
   //   from stdin"). Parse <outfile> as JSON.
createProviderRegistry({ providers, settingsRepo }) -> {
  current() -> provider, fallback() -> provider|null,
  modelFor(jobType, weight: "light"|"heavy") -> model string
}
```

Default settings (settingsRepo keys):
- `center.provider` = `"claude-sdk"`
- `center.fallback_provider` = `"codex"`
- `center.auto_fallback` = `false`
- `center.models` = `{ "claude-sdk": { light: "claude-haiku-5-5", heavy:
  "claude-sonnet-5-5" }, "claude-cli": { same }, "codex": { light:
  "gpt-6-luna", heavy: "gpt-6.1-sol" } }`
- `workers.default_kind` = `"claude"` (phase 2)

### Job runner — `agent/jobRunner.js`

```
createJobRunner({ jobsRepo, store, bus, registry /* provider registry */,
                  jobs /* registry of job modules */, clock, log,
                  concurrency: { interactive, background }, timeoutMs,
                  deps /* passed to job modules: asana, brain, scheduler, ... */ })
  -> {
  enqueue(type, input, { task_id = null } = {}) -> job   // returns immediately
  cancel(id) -> boolean
  get(id) -> job, list({ task_id, status, limit })
  start(), stop()       // start resumes "queued"/"parked" jobs from jobsRepo,
                        // marks stale "running" jobs as failed ("interrupted")
  poll()                // re-check parked jobs (called by an interval)
}
```

- Two lanes, independent concurrency. Within a lane, FIFO.
- Jobs whose module says `lock: true` run inside `store.withTaskLock(task_id)`
  for their apply phase only. The LLM call happens outside the lock, and the
  apply re-checks `base_revision` and retries once on stale.
- Job module contract (`agent/jobs/<type>.js`):
  ```
  export default {
    type, lane: "interactive"|"background", weight: "light"|"heavy", lock: bool,
    outputSchema /* zod */,
    async prepare(ctx) -> { context } | { park: { kind, ref, until? } }  // optional
    async resume(ctx, parkState) -> { context } | { park }               // optional
    buildPrompt(ctx, context) -> { system, prompt, mcpServers? },
    async apply(ctx, output, context) -> { summary }   // writes via store/deps
  }
  ```
  `ctx = { job, input, task_id, store, deps, actor: "center", clock, log }`.
  `deps` includes `jobRunner` (e.g. command "done" enqueues close_out).
- Public job view: `{ id, task_id, type, lane, status, provider, model,
  error, summary, created_at, started_at, ended_at }`. Emit
  `job.updated` on every status change. Stream deltas as `job.delta`.
- On `LimitError` with `center.auto_fallback` true, retry once on the
  fallback provider and record that in the job.

### Job types (phase 1) — `agent/jobs/`

| type | lane | input | does |
|---|---|---|---|
| `parse_quick` | interactive | `{ text }` + task_id | LLM fallback when the rule parser fails: kind/title/due_at → store.updateTask; schedules a reminder via `deps.scheduler.remind`. |
| `enrich` | background | `{ }` + task_id | Slack URL → `deps.brain.start(...)` then **park** `{kind:"brain", ref: brainJobId}`; resume when `deps.brain.result(ref)` is done. Asana URL → `deps.asana.getTask`. Plain text → classified from the text alone. A Slack/Asana source that cannot be fetched (Brain/Asana error, not configured, empty answer, timeout) fails the job with `source_unavailable`: no LLM call, task and artifact untouched, `flags.error` says why; Re-enrich retries. Then LLM → `{ title, area, kind, summary, context_md, acceptance: [], plan_md, repos: [{name, role}], branch_suggestion, wants_asana, wants_agent, due_at|null }`. Apply: updateTask (title/area/kind/repos/wants_*, flags.enriching=false) + write artifact sections (Summary, Context, Acceptance, Plan). A resulting reminder with a future due date gets `deps.scheduler.remind` and, if still in inbox, status waiting. Input `baseline` = the artifact `{content, revision}` at enqueue time (capture / re-enrich); section edits are checked against it, so edits made while queued or waiting for Brain are kept as conflicts. Repos must come from `deps.repoTable.list()` names. |
| `assist` | interactive | `{ comment_id?, message, intent: "ask"|"change"|"chat", anchor? }` + task_id | LLM gets the artifact (with section names), the thread and the anchor quote. Output `{ reply, edits: [{ section, op: "replace"|"append", content }] }`. Apply edits (base_revision from prepare) and post the reply as a comment reply (author "center"). Resolve the comment when intent is change and the edits applied, or when an answer is given. `mcpServers` may include tracebot-mcp for "ask". |
| `command` | interactive | `{ text }` (no task_id) | Home command bar. LLM gets a compact board (ids, titles, statuses, due) → `{ reply, actions: [{ type: "set_status"|"snooze"|"set_area"|"create_task"|"add_comment", task_id?, ... }] }`. Apply each action via the store/scheduler with validation and return a summary. Never deletes. |
| `asana_create` | background | `{ }` + task_id | Uses `deps.asanaService.createForTask(task, artifact)`. The LLM writes the description prose `{ summary, context, acceptance: [], approach }`. The service builds the html, picks the section, creates, attaches links, and returns gid/url. Apply: `task.asana = {...}`, add `asana` link, `wants_asana=true`, event. |
| `close_out` | background | `{ }` + task_id | LLM writes `{ result_md, asana_comment }` from the artifact. Apply: Result section; if Asana gid: comment + complete via asanaService. Status → done. |

## Integrations — `server/src/integrations/`

```
createKeychain({ exec }) -> { get(service, account?) -> string|null }
     // `security find-generic-password -s <service> -w`; never log the value.

createAsanaClient({ fetch, token, baseUrl = "https://app.asana.com/api/1.0", log })
  -> { request(method, path, { query, body }) }  // handles {data} envelope, errors -> AppError
createAsanaService({ client, config /* cfg.asana */, clock, publicBaseUrl }) -> {
  resolveSprintSection(date = now) -> { gid, name } | null
  createForTask(task, prose /* {summary, context, acceptance[], approach} */,
                { marker, priorMarkers, since }?)   // idempotent: adopts an existing
     // task carrying a prior "Command-Center-Task: T-<id> <nonce>" marker
  findByMarker(markers, since) -> task | null
     -> { gid, url, section_gid, no_section, attachments: [url] }
  syncTracking(task) -> { attachments: [url], failed: [url] } // managed block + Status field + missing attachments
  comment(gid, text), complete(gid), getTask(gid) -> { name, notes, permalink_url, completed }
}
```

Sprint sections (live names verified):
`Nov 2 - Nov 8`, `Oct 26 - Nov 1`, `August 3 - August 7`, `April 20 - 26`
(end without month), `March 30 - April 3rd` (ordinal), `June 22 - June 29`.
There are also non-date sections (`Backlog`, `Security Updates`, `tasks from
onsite`). Names have no year: assume the current year, and when the start
month > end month the end is in the next year. Near New Year, also consider
the previous year for December sections. Weeks sometimes end on Friday, so
the rule is: pick the section whose [start, end] contains today. On a
weekend gap day only (Sat/Sun, ≤ 3 days after the section ended, same
Monday-start week) fall back to that week's section. On a miss, refetch the
section list once (bypassing the 24 h cache), then return null
(`no_section`).

Asana `html_notes` must be valid Asana rich text (`<body>` root, tags like
`strong em u s code a ul ol li blockquote pre h1 h2 hr`; **no HTML
comments**). The managed block starts at `<hr/><h2>Command Center</h2>` and
runs to the end of the body. Text before it is never rewritten after
creation. External attachments: `POST /attachments` (multipart/form-data
with `parent`, `resource_subtype=external`, `url`, `name`). Track added
URLs in `task.asana.attachments` to avoid duplicates. Artifact URL =
`${publicBaseUrl}/t/${id}` (omit when `publicBaseUrl` is null).

Tracking sync (`integrations/asana/asanaSync.js`, started by the system):
on `task.created`/`task.updated` for a task with an Asana gid, debounce 3 s
per task, then `syncTracking(task)` (serialized per task) and store
`asana.attachments` + `asana.tracking_hash = trackingFingerprint(task)`
(hash of the Asana gid, status, repos, branches, PRs and the artifact URL;
not updated_at). `asana.synced_gid` records which Asana task the stored
attachments belong to; after a re-link the list starts over, and bookkeeping
from a sync of the old gid is dropped (checked under the task lock). Tasks whose hash
already matches are skipped, so the sync's own write ends the cycle. Errors
(including attachments in `failed`: the attached ones are stored, the hash
is not) retry after 1 min, 5 min, 30 min; a 404 or exhausted retries wait for the
next tracked change. A reconcile pass at start and every 15 min catches up
stale tasks (e.g. the artifact URL became known after tailnet detection).

```
createBrainClient({ readFile, claudeConfigPath, serverName, mcpClientFactory, log })
  -> {
  start({ prompt, title, idempotencyKey }) -> brainJobId      // brain_do
  result(brainJobId, { waitSeconds = 0 }) -> { status: "running"|"done"|"failed",
                                               answer: string|null, phase }
  close()
}
  // reads mcpServers[serverName] {type:"http", url, headers} from ~/.claude.json;
  // connects with @modelcontextprotocol/sdk StreamableHTTPClientTransport.
  // Never log headers.
createRepoTable({ readFile, agentsMdPath }) -> { list() -> [{ name, default_branch,
                                                  lang, description }] }
  // parses the "## 0. Main repos" markdown table in ~/work/tree/AGENTS.md
```

## HTTP — `server/src/http/`

Two listeners from one app factory: `createApp({ mode: "local"|"tailnet",
store, bus, jobRunner, scheduler, dateParser, settingsRepo, devicesRepo,
auth, config, log })`.

### Auth & roles

- **local** listener (`127.0.0.1:7788`): owner if `Authorization: Bearer
  <localToken>`, or cookie `cc_session` = a valid owner session. Bootstrap
  with `GET /auth/bootstrap?t=<one-time token>` (created by `cc open`
  through the bearer API: `POST /api/auth/bootstrap-token`) → sets the
  cookie → redirect `/`. Tailscale headers are **ignored** here. Otherwise
  401.
- **tailnet** listener (`127.0.0.1:7789`, behind `tailscale serve
  --https=8443`): requires the `Tailscale-User-Login` header, else 401.
  Owner if the login equals `config.owner.tailscaleLogin`; an unrevoked
  `cc_device` cookie is attached when present (optional). Otherwise
  **viewer**. No bearer auth and no `/mcp` on this listener.
- Pairing: owner `POST /api/pair/code` → `{ code (6 digits), expires_at }`
  (10 min, single use, stored hashed). Tailnet `POST /api/pair { code,
  name }` with the owner login header → creates a device and sets
  `cc_device` (HttpOnly, Secure, SameSite=Strict, 1 year). Lists and
  revocation are owner-only.
- Owner writes: `Origin` must match the request host (CSRF) when present
  on cookie-auth requests. Bearer requests skip the Origin check.
- `localToken`: read from `<configDir>/token` (create with 0600 if
  missing, 32 random bytes hex).

### Host validation

Runs before everything else, `/healthz` included. Tailnet: `Host` must
equal the host of `config.publicBaseUrl`, otherwise **421**. If
`publicBaseUrl` is unset, every tailnet request gets **503**
`not_configured`. Local: `127.0.0.1:<port>`, `localhost:<port>` or
`[::1]:<port>`, otherwise **421**. Pairing: only the latest code is valid;
5 misses burn it; a global cap of 20 failures per 10 min returns **429**.

### REST API (JSON)

Viewer-allowed: `GET /api/me`, `GET /api/board`, `GET /api/tasks`,
`GET /api/tasks/:id` (shared only, viewer view), `GET /api/events`.
Everything else is owner-only.

```
GET    /api/me                         -> { role: "owner"|"viewer", login|null, mode }
GET    /api/board                      -> { lanes: {now,active,prs,ready,inbox,waiting,done} }
GET    /api/tasks?q=&status=a,b&area=&kind=&limit=&offset=  -> { tasks, total }
POST   /api/tasks  TaskCreateSchema    -> 201 { task, revision }
          // server: dateParser.parseCapture(text); reminder -> kind reminder,
          // status waiting, scheduler.remind; url slack/asana -> source.type.
          // Every capture except reminders gets flags.enriching=true and an
          // "enrich" job (Slack/Asana fetched, other text classified as is);
          // a "remind me" the rule parser could not date goes to parse_quick
          // instead. Title fallback = first line of text (≤120 chars) or url.
          // wants_asana=true (the "Create in Asana" box): enrich gets
          // create_asana and starts asana_create when it finishes (or fails);
          // without enrich, asana_create is enqueued right away.
GET    /api/tasks/:id                  -> owner: { task, revision, artifact:{content,revision},
          comments, feedback, events, schedules, jobs }  viewer: { task: viewerTask, artifact:{content} }
PATCH  /api/tasks/:id  { patch, base_revision?, snooze? } -> { task, revision }
          // waiting + snooze_until -> scheduler.add(surface at snooze_until);
          // any snooze also clears flags.now/now_reason (snoozePatch).
          // status "done" on an open Asana-linked task -> 202 { task,
          // revision, job, close_out: "started"|"pending" }: other fields
          // apply now, close_out (deduplicated) sets done when it finishes;
          // 409 deliverables_open when deliverables are not merged, with or
          // without Asana: store.updateTask itself refuses done with open
          // deliverables (checked on the merged task, under the task lock).
PUT    /api/tasks/:id/artifact { content, base_revision } -> { revision } | 409
GET    /api/tasks/:id/history          -> { commits }
GET    /api/tasks/:id/history/:sha     -> { diff }
POST   /api/tasks/:id/comments { body, intent, anchor?, parent_id? } -> 201 { comment, job? }
          // intent ask|change|chat -> enqueue "assist"
PATCH  /api/tasks/:id/comments/:cid { status } -> { comment }
POST   /api/tasks/:id/schedules { when? (text) | fire_at?, action="surface", note? } -> 201 { schedule }
DELETE /api/schedules/:sid             -> { ok }
POST   /api/tasks/:id/asana            -> 202 { job }     // asana_create
POST   /api/tasks/:id/close-out        -> 202 { job }     // reuses a pending close_out
POST   /api/tasks/:id/enrich           -> 202 { job }     // re-run
POST   /api/command { text }           -> 202 { job }
GET    /api/jobs/:id                   -> { job }
POST   /api/jobs/:id/cancel            -> { ok }
GET    /api/settings                   -> { settings }
PATCH  /api/settings { key: value }    -> { settings }   // whitelisted keys only
POST   /api/pair/code                  -> { code, expires_at }
POST   /api/pair { code, name }        -> { device }     // tailnet only
GET    /api/devices                    -> { devices }
DELETE /api/devices/:id                -> { ok }
POST   /api/auth/bootstrap-token       -> { url }        // local, bearer only
GET    /auth/bootstrap?t=              -> 302 /
GET    /api/events                     -> text/event-stream (event: <type>, data: JSON)
GET    /healthz                        -> { ok: true }
GET    /*                              -> web/dist (SPA fallback to index.html)
```

Error body: `{ error: code, message, details? }`.

## CLI — `cli/cc.js`

`cc add <text...>`, `cc ls [--status s]`, `cc show <id>`, `cc done <id>`,
`cc remind <when> <text...>`, `cc open` (bootstrap token → `open <url>`),
`cc pair` (prints code), `cc reindex`. It talks to the local listener with
the bearer token from `<configDir>/token`. Pure functions are exported for
tests: `parseArgs`, `formatTask`, and `run(argv, { fetch, readFile,
openUrl, stdout })`.

## Web — `web/`

Vite + React SPA, built to `web/dist`. It talks only to the REST/SSE API
above. Details are in `docs/06-ui-artifacts-comments.md`. Dark theme by
default, mobile-first. Pages: Home (board lanes, capture, search, command
bar), Task (artifact + comments + chat + history + schedules + actions),
Settings (provider switch, devices, pairing code). Viewer role renders
read-only.
