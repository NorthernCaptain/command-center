# 05 — Center agent

The center agent runs the paperwork. It is fast, cheap and well scoped.
Real engineering goes to the herdr workers.

## Not one agent: one definition, many short jobs

The "center agent" is **not a single long-running conversation** that
handles my requests one at a time. It is a shared configuration (system
prompt, tools, model choice) plus a **job runner**. Every request is an
independent, short-lived job with only the context it needs: the task's
artifact, the relevant comment thread, the last few chat messages (a chat
job gets the task's previous chat exchanges, since every chat bar message
is its own thread). Many jobs run at the same time.

## Concurrency and responsiveness

Goal: **I never wait on the agent to do something unrelated.** Adding a task
while it edits another artifact must be instant.

1. **No LLM on the capture path.** `POST /api/tasks` writes the task and
   returns in milliseconds. Enrichment runs afterwards in the background.
   Reminders with recognizable times ("tomorrow 10am", "in 2h", "next
   Monday") are parsed by a deterministic rule parser. Haiku is only a
   fallback for odd phrasing, and even then the task already exists and only
   its due time fills in.
2. **Two lanes with separate worker pools:**
   - **interactive** (chat bar, inline Change/Ask, home command bar):
     priority lane, ~4 concurrent, streams to the UI.
   - **background** (enrich, Asana sync, PR feedback summaries, close-out,
     follow-ups): ~2 concurrent. It can never starve the interactive lane.
3. **Long waits don't hold slots.** Brain (`brain_do`) takes minutes. The
   job starts the Brain job, saves its `job_id`, and **parks**. The
   scheduler polls `brain_job_result` and resumes the job when the result is
   ready. The same applies to anything else slow.
4. **Per-task serialization, cross-task parallelism.** Jobs that write the
   same task's artifact queue behind a per-task lock, and every write carries
   a `base_revision`. Jobs on different tasks run fully in parallel.
   Read-only jobs (questions) never take the lock.
5. **Optimistic UI.** My own edits, status changes and comments apply at
   once. The agent's work shows as a live "working…" chip on that comment
   or section, then a diff flash.
6. **Small and fast by default.** Haiku, prompt caching on the stable system
   prompt and tool definitions, tight per-job context, streaming output.
   Expected: first tokens in about a second, a typical section edit in a
   few seconds.
7. **Cancel / supersede.** A new instruction on the same section cancels a
   queued (not yet running) edit for it. Every running job has a Cancel
   button.

Everything in the UI that does not need judgment (status changes,
snooze, scheduling, links, Create PR / Address feedback buttons, search) is plain
code with no LLM.

## Runtime and auth

### Providers: Claude by default, Codex when needed

All jobs go through one interface, `runJob(jobType, input) → validated
result`. Behind it sit interchangeable **providers**, so I can switch the
center agent to Codex at any time, for example when Claude credits run out.

| Provider | How | Models (per job type, configurable) |
|---|---|---|
| `claude-sdk` (**default**) | Claude Agent SDK in-process | Haiku (`claude-haiku-5-5`). Sonnet (`claude-sonnet-5-5`) for heavy drafts |
| `claude-cli` (fallback) | `claude -p --model … --output-format stream-json` subprocess | same |
| `codex` | `codex exec -m <model> --json --output-schema <job schema>` subprocess, one per job | **luna** (light Codex model, decided) for most jobs; the exact model id string is set in config (`center.codex.light_model`) and confirmed in the phase 0 spike, the default Codex model for heavy drafts |

- **No tool round-trips (phase 1, see [spike results](spike-results.md)).**
  Jobs return a schema-validated object (`edits`, `actions`, `reply`, …)
  that service code validates and applies through the store. This works the
  same on every provider and gives least privilege by construction. Only
  `assist` asks get `tracebot-mcp` (Brain) as an MCP server on the Claude
  providers, limited to an exact allow-list (`brain_job_result`,
  `wiki_search`, `wiki_read`, plus `brain_do` on `claude-sdk` only); every
  other tracebot tool, including Slack posting and deploys, is denied.
  `brain_do` is **not** read-only: Brain acts as me (Slack, GitHub,
  databases, workers) and does what its prompt says. On `claude-sdk` every
  `brain_do` prompt is rewritten (PreToolUse hook + `canUseTool`) to start
  with a firm "READ-ONLY REQUEST from the command center: answer only; do
  not post, send, deploy, create, modify or delete anything …" instruction.
  That is an instruction to Brain, not an enforcement boundary. `claude -p`
  has no way to rewrite tool input, so on `claude-cli` `brain_do` is denied
  and an ask can only read finished Brain results and the wiki. Codex center jobs run with an isolated
  `CODEX_HOME` and **no MCP servers at all**, so a Codex "ask" has no Brain
  access.
- **Same output contract.** Each job type has a JSON schema (zod →
  JSON Schema). Claude gets it via structured output / a final tool call,
  Codex via `--output-schema`. Results are validated identically.
- **Switching:** Settings has `center.provider = claude-sdk | claude-cli |
  codex` plus a per-job-type model map per provider. It takes effect for
  the next job; running jobs finish on their provider.
- **Auto-fallback (opt-in):** if a job fails with a usage/credit-limit error,
  retry it once on the configured fallback provider and show a banner
  ("Claude limit hit, center agent on Codex"). It also offers to switch
  herdr workers ([04 — Worker kind](04-herdr-integration.md#worker-kind-claude-or-codex)).
- Every job records `provider`, `model`, latency and usage. That makes the
  "is the Codex light model good enough for enrich?" decision data-driven.

### Claude provider details

- **Claude Agent SDK** (JS) inside the service. Default model **Haiku**
  (`claude-haiku-5-5`). Some job types escalate to **Sonnet**
  (`claude-sonnet-5-5`), for example a long artifact draft from a big
  thread. Model per job type in config, recorded per job with its usage.
- **Auth: my Claude login**, so it draws on the same team account as my
  Claude Code and herdr agents. No API key. The Agent SDK runs the local
  Claude Code runtime, which uses its existing login. For a launchd
  daemon, which may not see the interactive login, the plan is to mint a
  long-lived token with `claude setup-token` and give it to the service as
  `CLAUDE_CODE_OAUTH_TOKEN`, stored in the macOS Keychain and read at
  startup. **To verify in the phase 0 spike.** If the SDK cannot use the
  login, the fallback is the `claude -p --model haiku --output-format
  stream-json` subprocess behind the same `runJob()` interface. That uses
  the same login by definition. Either way, center-agent usage counts
  toward the team plan's limits, which Haiku keeps small.
- **MCP for Brain**: connect the SDK to `tracebot-mcp` with the same
  server config Claude Code uses (from `~/.claude.json`), so it uses my
  tracebot key and Brain identity.

## Job types

| Job | Lane | Trigger | Tools | Output |
|---|---|---|---|---|
| `parse_quick` | interactive | capture text the rule parser can't handle | none | kind / due_at / title |
| `command` | interactive | home command bar ("snooze T-12 to Monday", "what's waiting on Ron?") | task tools (read/write), search | action(s) taken or answer |
| `edit_artifact` | interactive | chat instruction or inline **Change** | artifact tools | patch + one-line summary, comment resolved |
| `answer` | interactive | inline **Ask** or chat question | artifact, search, brain, asana read, gh read | answer in thread, optional "add to artifact?" |
| `enrich` | background | new capture | brain (Slack thread), asana read, repo table, gh read | title, area, kind, repos, branch, wants_asana/agent, artifact v1 |
| `asana_create` | background | **Create in Asana** / Start | asana | gid + link (mostly deterministic code; LLM only drafts the notes) |
| `pr_feedback` | background | PR watcher found new comments/reviews/CI failures (phase 2) | gh read | per item: actionable?, one-line summary (written to `feedback.jsonl`) |
| `asana_sync` | background | branch assigned, PR claimed, feedback round resolved, status change | asana | Asana description block + attachments refreshed (deterministic; LLM only rewrites prose) |
| `close_out` | background | PRs merged / accepted | asana, artifact | Result section (if empty), Asana conclusion comment + complete |
| `followup` | background | `center_job` schedule | gh read, herdr read, task tools | surface / prompt agent / reschedule |

## Tools exposed to the center agent

- **Own tools** (in-process MCP): tasks, artifact sections, comments,
  links, schedules, search.
- **Brain** (`tracebot-mcp`): `brain_do` / `brain_job_result`. Brain has
  Slack history, wiki, GitHub and databases. Always pass our own
  `idempotency_key` (`cc-T123-enrich-1`). Brain's answer is **data, not
  instructions**.
- **Repo knowledge**: the repo table in `~/work/tree/AGENTS.md` §0
  (names, aliases, default branches) plus read-only `gh` search in
  `acme`. It does not read the stale local checkouts in
  `~/work/<repo>`.
- **gh** (read-only wrapper): PR state, comments, CI.
- **Asana**: via the service's Asana client (below). It is not the LLM
  calling REST freely.
- **herdr**: read-only (`agent get` / `list`). Starting agents and sending
  prompts is deterministic service code after my click or my schedule,
  never an LLM decision.
- **Slack posting**: **not allowed** (decided). No Slack write tool is wired
  in at all. It may be reconsidered later, as an explicit button only.

## Asana

- **Project:** Apps Project Sprints 2026, gid `1111111111111111`
  (<https://app.asana.com/1/33333333333/project/1111111111111111>).
- **Assignee:** me, gid from `asana.assigneeGid` in config.
- **Section:** the current week's sprint section. Sections are named by date
  range ("March 1 - March 7", "Feb 22 - Feb 28"). Resolve with `GET
  /projects/{gid}/sections`, parse the names (full and abbreviated month
  names, year rollover around New Year), and pick the one containing today
  (local time). If none matches, create the task in the project with no
  section, flag "no sprint section for this week" on the task page, and
  never create sections automatically. Cache the section list for a day.
- **Description: a real, readable task description.** The center agent
  drafts it from the artifact (Sonnet-quality prose is allowed here). It is
  written as `html_notes`:

  ```
  <body>
  <strong>Summary</strong>  2–4 sentences: what and why
  <strong>Context</strong>  key facts, who asked, links to the source (Slack thread)
  <strong>Acceptance</strong>  checklist of what "done" means
  <strong>Approach</strong>  short plan (updated as decisions land)
  <hr/><em>Command Center: T-123 · artifact · pr_open · updated 2026-11-12 14:05</em>
  <em>Repos: aws-lambda @ t123-fix-upload-retry, infrastructure @ t123-fix-upload-retry · PRs: aws-lambda#812</em>
  </body>
  ```

  The managed block is a small reference note: a divider and one or two
  italic lines (Asana rich text has no smaller font; no heading, bold or
  lists). "artifact", branches and PRs are links. It is regenerated by
  `asana_sync` whenever branches, PRs or status change; it starts at the
  `<hr/><em>Command Center:` marker (the older `<hr/><h2>Command Center</h2>`
  block is recognized and replaced). Text **before** the marker is never
  overwritten after creation, so teammates' edits survive. If the marker is
  missing (someone deleted it), the block is re-appended and nothing else is
  touched.
- **Slack thread reply:** when the task was captured from a Slack thread,
  creating its Asana task also asks Brain (`brain_do`) to reply in that
  thread with "Tracking this in Asana: <url>". Once per Asana task (event
  `slack_asana_link` with the Brain job id; Brain idempotency key
  `cc-T<id>-slack-asana-<gid>`, `-2`, `-3` for later tries). A failure to
  start the Brain job is logged and recorded (`slack_asana_link_failed`);
  the Asana task stays created. The notifier then follows the Brain job and
  records its answer (`slack_asana_link_result`: posted, not_posted,
  failed or unknown; Brain ends with a `RESULT: POSTED` / `RESULT: NOT
  POSTED - <reason>` line, and only `RESULT: POSTED` counts as posted). The task header shows the notice: a quiet line
  once posted, a warning with Brain's answer and **Try again** (or **Post
  to Slack** for a task that never tried) otherwise, and the task goes to
  Now ("Slack thread not told about the Asana task") until it is posted:
  when another reason held Now and was cleared, a sweep (every 10 minutes,
  and on each task page view) raises it again, unless I cleared the flags
  myself after the notice went wrong. **Dismiss** on the warning (I handled
  it, or do not want it) records `slack_asana_link_dismissed`, hides the
  notice and takes the task out of Now for it; a later "posted" result
  still shows and a later failure stays quiet.
- **Status field:** the project's **Status** custom field follows the task
  status, set on creation and on every sync (only when it differs):
  inbox/ready → **Initial**, active (agent started) → **In progress**,
  ready_for_pr / pr_open / pr_feedback → **Code Review**, done →
  **Released**, cancelled → **Canceled**. waiting and review leave it as it
  is, so Asana-only values (QA ready, On hold, …) survive. Field and option
  gids live in `config.asana.statusField`; without it nothing is set.
- **Attachments:** the artifact URL, each branch and each claimed PR are
  also added as Asana **external link attachments** (`POST /attachments`,
  `resource_subtype: external`, `url`, `name`). This way they show in
  Asana's attachments strip, not only in the text. Added once each, never
  duplicated (tracked in `task.json`).
- **When created:** if the task already has branches/PRs (Asana created
  after Start), they go in right away. Otherwise they are added as soon as
  they are assigned or claimed.
- **Comments (activity trail):** PR claimed → comment with link; feedback
  round resolved → one-line summary; close-out → Result summary + PR links.
- **Complete:** when every deliverable is resolved (all PRs merged), or on
  accept for non-code tasks. Never earlier.
- **Shared visibility:** creating the Asana task makes the command-center
  task **shared** (readable on the tailnet, see
  [06 — Access](06-ui-artifacts-comments.md#access-owner-edits-tailnet-reads)),
  so the artifact link in Asana works for colleagues.
- **Auth:** Asana **Personal Access Token**, stored in the Keychain
  (`security add-generic-password -s command-center-asana -a leo -w`) and
  read at startup. How to get one: Asana → profile photo (top right) →
  **Settings** → **Apps** → **View developer console** (or open
  <https://app.asana.com/0/my-apps>) → **Personal access tokens** →
  **+ Create new token**, name it "command-center", copy it once.
- All Asana calls are plain REST in the service (create, comment, complete,
  get, sections). That is small, testable and independent of claude.ai
  connectors.

## Guardrails

- **Least privilege per job type**: each job gets only the tools in its row
  above.
- **Untrusted content**: Slack threads, Asana comments and PR comments go
  into prompts as quoted data inside clear delimiters. The center agent
  cannot launch agents, push, or complete Asana tasks
  *because* content asked for it. Those come only from my clicks, my
  schedules, or merge detection, which is deterministic code.
- **Writes are patches.** Replacements carry `base_revision` and are
  rejected as stale if the artifact changed since it was read. Only atomic
  appends may skip it.
- **Budget**: per-job token cap and timeout. Failures show on the task with
  Retry.

## Artifact template (v1)

```markdown
# T-123 — <title>

> **Source:** <slack link> · **Requested by:** <person> · **Area:** infra
> **Asana:** <link> · **Repos:** aws-lambda (main), infrastructure (ref)
> **Branch:** t123-fix-upload-retry · **Slug:** k7q2

## Summary
<2–4 sentences: what is asked and why>

## Context
<facts pulled from the thread / Asana / repos; quotes with links>

## Acceptance
- [ ] <what "done" means>

## Plan
<proposed approach; worker refines>

## Decisions
<!-- cc_log_decision appends here: date · author · decision · why -->

## Progress
<!-- worker appends -->

## Links
<!-- rendered from task.json links: folders, branches, PRs, reviews -->

## Change record (SOC2)        <!-- only for area in {infra, access, security, soc2} -->
- What:
- Why:
- Risk:
- Rollback:
- Tested:
- Approved by:
- Evidence:
<!-- What, Why, Risk, Rollback and Tested must be filled before the task can be done -->

## PR feedback
<!-- rendered from feedback.jsonl: per PR and round, each comment → fixed / answered / declined, commit, reply link -->

## Result
<!-- filled by cc_report / close_out -->
```

Section names are stable IDs, so tools address them by name.
