# 9. PR reviews and auto-merge

Two features on top of the GitHub integration:

1. **PR reviews**: command center scans the PRs of chosen repos, shows
   the ones other developers opened on a dashboard (`/reviews`), and can
   start a herdr agent that reviews each one (first review or re-review)
   following the `AGENTS.md` in the reviews folder (config `reviews.dir`).
2. **Auto-merge**: our own task PRs (claimed by a task) merge by
   themselves once GitHub says they are approved and nothing blocks the
   merge.

"We" / "us" is the authenticated `gh` user (`gh api user`), or
`github.login` in config.json.

## Tracking

Every repo from the tree AGENTS.md repo table (the repo picker's list)
can be tracked. Per repo, two flags (table `review_repos`):

| Flag          | Meaning                                                     |
| ------------- | ----------------------------------------------------------- |
| `track`       | Scan its PRs and show them on the dashboard                 |
| `auto_review` | Also start a review agent for PRs that need a review (implies `track`) |

Tracked but not auto-reviewed: PRs show up as **New**; Leo reviews them
by hand on GitHub, and the next scan picks his review up. In an
auto-review repo a PR goes to the queue as soon as a scan finds it, and
shows up as **Queued** (New is only what waits for Leo). Tracking a repo
off hides its PRs from New (and cancels its queued automatic runs);
Rejected, Approved and All keep the history.

### Scan

- Every `reviews.poll_minutes` (default 20) each tracked repo is scanned
  once. The scans are spread over the period: with N repos, one repo every
  `poll_minutes / N`, round robin, so the gh calls never come all at once.
- A light GraphQL call lists all the repo's open PRs (number, update
  time, author; every page). Details (our reviews, latest commit + CI
  rollup, the author's own reviews by author filter: a reply in a review
  thread is a review of its author, so newer activity of others never
  hides it; the newest 100 conversation comments, paged back to our
  change request when they don't reach it) are fetched by number, 10 PRs per call, only for
  new PRs, PRs updated since the last scan, PRs not refreshed for 6 hours,
  and stored-open PRs that left the list (merged / closed). Newly tracked
  repos, auto-review switched on and "Scan now" refresh every open PR. (A
  single heavy query over many PRs times out on GitHub's side.)
- The first scan of a repo also looks at its 25 most recently updated
  closed / merged PRs and stores the ones we reviewed (stats history;
  retried on the next scan if it fails). Older reviews are not loaded, so
  the stats start incomplete and fill up as new reviews come in.
- Stored: PRs opened by someone else (not us), bots included (an agent
  app may open the team's PRs). Our own PRs are the task / auto-merge
  side.

### PR status

From GitHub (source of truth), per PR:

- `decision`: our latest non-dismissed `APPROVED` / `CHANGES_REQUESTED`
  review (comment-only reviews never change it), with its time and commit.
- `attempts`: how many such decisions we submitted.
- `needs_review`:
  - no decision yet: **new**;
  - decision `CHANGES_REQUESTED` and since then a new head commit, or a new
    comment, review-thread reply or review by the PR's author after our
    latest word (the change request, a comment-only review, a thread reply
    or a conversation comment of ours: once we replied, it waits on the
    author again; other reviewers' activity does not count):
    **re-review**.
- `eligible` for an automatic review: open and not a draft; a bot's PR
  and a stacked PR (based on another PR's branch) too. For a stacked PR the
  prompt says it is the explicit request by PR ID that AGENTS.md asks for
  and to review it against its base. Ineligible PRs are listed (with the
  reason) but never auto-reviewed.

### Review agents

- A PR that needs a review in an `auto_review` repo is queued once per
  head commit + last activity (a failed run is not retried automatically;
  "Review" on the dashboard queues it again).
- Switching Auto-review or Track off cancels the repo's queued automatic
  runs; an automatic run is checked again when it would start (still
  wanted, still eligible, still needs a review).
- At most `reviews.parallel` (default 4) agents run; the queue starts the
  next one (oldest first) as soon as a slot frees up.
- Agent kind: `reviews.agent_kind` (default `claude`).
- herdr: a workspace in `reviews.dir` (config.json; default `~/work/reviews`)
  labelled `#<number> <PR title>`; a Claude agent also gets
  `--name "#<number> <PR title>"`. Env: `CC_REVIEW_ID`, `CC_URL`,
  `CC_TOKEN`, and `REVIEW_ORCH_SKIP=1` (the review orchestrator's stop
  hook leaves review agents alone); the MCP headers carry `X-CC-Review`.
  A codex agent also starts with `-c check_for_update_on_startup=false`
  (the update notice swallows the first prompt) and `--sandbox
  workspace-write -c sandbox_workspace_write.network_access=true`: in the
  untrusted reviews folder codex defaults to a read-only sandbox without
  network, so it could neither clone nor reach GitHub. It stays
  sandboxed (writes only in the reviews folder). The prompt says to clone
  over SSH (`gh repo clone` or `git clone git@github.com:…`) and use gh
  for GitHub: plain git over HTTPS has no valid credential there.
- Prompt (`reviewPrompt`): the PR, the checkout folder to use
  (`<reviews dir>/<repo>-pr-<number>-r<run id>`; every file of the review
  stays in it), follow AGENTS.md, do the review itself and never call the
  review orchestrator (`request_review`), first
  review or re-review (read the earlier review and every comment since,
  verify the fixes), don't register with the old `.pr-monitor`, and report
  with `cc_review_report` when the GitHub review is submitted.
- `cc_review_report({ review_id, verdict, issues, summary })`: verdict
  `approved` | `changes_requested` (the GitHub review is submitted) |
  `unchanged` (a re-review where nothing since our change request changes
  it: only replies, no fix; it stands and no new review is submitted) |
  `skipped` (no review could be done, e.g. not eligible after all or the
  evidence was insufficient; the summary says why). A finished run with
  `unchanged` settles the PR state it reviewed: the PR shows as changes
  requested (Rejected, not New) until the author pushes or answers again.
  Only the review's own agent (its `X-CC-Review`) or the owner may report.
- Done: once reported and the agent is idle, its workspace closes and the
  checkout folder (and its `<folder>-…` siblings) is removed if still there; the PR is rescanned so
  the dashboard shows GitHub's view.
- A workspace close herdr refuses (herdr down) keeps the workspace and
  the checkout; the monitor retries it, and the dashboard's Close agent
  shows the error. Retrying a failed review closes the agent it left
  open first.
- Idle without a report: one reminder prompt; still no report -> the run
  fails (`no report`) and the agent stays open for a look ("Close agent").
  An agent that vanishes without a report fails the run too.

### Run states

`queued` -> `running` -> `reported` -> `done`; or `failed` / `cancelled`.

## Dashboard (`/reviews`, owner only)

- Repos menu: every repo with Track / Auto-review check boxes.
- Stats (last 30 days unless noted): approvals and change requests by us,
  approvals by attempt (1st / 2nd / 3rd / 4th+, pie), weekly reviews
  (8 weeks, bars), median time from PR open to our first review, average
  attempts to approval, waiting / in review / queued now, top authors.
- Tabs:
  - **New**: what waits for Leo: open, not draft, in a tracked repo, needs
    a review (new or re-review) and has no review run in flight
    (tracked-only repos, PRs an automatic review can't take, failed
    automatic reviews);
  - **Queued**: PRs with a review run in flight (queued, running, or
    reported and closing);
  - **Rejected**: our change request stands unanswered (no new commit or
    comment since; an answered one is a re-review: New or Queued);
  - **Approved**: approved by us in the last 7 days;
  - **All**: every stored PR, in sections by status (in the queue,
    waiting for you, changes requested, approved, merged, closed, other).
- Every list: newest PR first (by when it was opened); in All, inside each
  section.
- Search: PR number (`417`, `#417`) or text in the title / author.
- Per PR: repo#number + title, author, status, attempts, issues (last
  run), our last review, opened / updated, size, CI, conflicts, agent run
  (state, verdict, summary) and actions (Review / Re-review, Cancel,
  Close agent, Open in herdr).

## API (owner only)

| Method | Path | Body / query | Answer |
| --- | --- | --- | --- |
| GET | `/api/reviews` | `tab` (`new` \| `queued` \| `rejected` \| `approved` \| `all`, default `new`), `q` | `{ prs, counts, stats, settings, me }` |
| GET | `/api/reviews/repos` | | `{ repos }` |
| PUT | `/api/reviews/repos/:repo` | `{ track?, auto_review? }` | `{ repo }` |
| POST | `/api/reviews/scan` | `{ repo? }` | `{ ok: true }` (scan runs in the background) |
| POST | `/api/reviews/prs/:repo/:number/review` | | `{ run }` |
| POST | `/api/reviews/runs/:id/cancel` | | `{ run }` (queued: dropped; running: agent closed) |
| POST | `/api/reviews/runs/:id/focus` | | `{ ok: true }` |

Bus / SSE event `reviews.updated` (no payload) after any change: the page
refetches.

`prs[]`:

```json
{
  "repo": "mobile", "number": 417, "url": "https://github.com/acme/mobile/pull/417",
  "title": "…", "author": "dev1", "is_draft": false, "base": "main",
  "state": "OPEN", "created_at": "…", "updated_at": "…", "merged_at": null, "closed_at": null,
  "additions": 10, "deletions": 2, "changed_files": 3,
  "ci_state": "SUCCESS", "mergeable": "MERGEABLE", "review_decision": "CHANGES_REQUESTED",
  "decision": "changes_requested", "decided_at": "…", "decided_sha": "abc1234",
  "first_review_at": "…", "attempts": 2,
  "needs_review": "re_review", "eligible": true, "ineligible_reason": null,
  "tracked_auto": true,
  "run": { "id": 12, "kind": "re_review", "status": "running", "agent_name": "pr-mobile-417",
           "queued_at": "…", "started_at": "…", "finished_at": null,
           "verdict": null, "issues": null, "summary": null, "error": null,
           "agent_open": true }
}
```

`needs_review`: `null` | `"new"` | `"re_review"`. `run`: the latest run or
null; `agent_open`: its herdr workspace is still open (a failed run
keeps it for a look until "Close agent"). `counts`: `{ new, queued,
rejected, approved, all }`. Rows also carry `tracked` and `tracked_auto`.

`stats`:

```json
{
  "window_days": 30,
  "approved": 12, "changes_requested": 7,
  "attempts": { "1": 6, "2": 4, "3": 1, "4+": 1 },
  "weekly": [{ "week": "2026-09-21", "approved": 3, "changes_requested": 1 }],
  "median_first_review_hours": 5.2, "avg_attempts_to_approve": 1.6,
  "waiting": 3, "reviewing": 1, "queued": 2,
  "authors": [{ "author": "dev1", "approved": 4, "changes_requested": 2 }]
}
```

`settings`: `{ poll_minutes, parallel, agent_kind }`. `repos[]`:
`{ name, description, track, auto_review, last_scan_at, open, error }`.

## Auto-merge (task PRs)

Setting `github.auto_merge` (default on). On each PR watcher poll of a
claimed, open PR of ours:

- not a draft;
- approved: GitHub's `reviewDecision` is `APPROVED` or none (no review
  required), the current head commit has an approval (an approval of an
  older commit never merges a newer one), and no reviewer's latest
  opinion is a change request;
- `mergeStateStatus` is `CLEAN` (or `HAS_HOOKS`): required checks green, no
  conflicts, nothing else blocking;
- every actionable feedback item on that PR is settled (verified after
  its fix or answer; checked after this poll's verification), and the
  task's agent is not at work: nothing queued, being sent or just sent,
  no start / revive in progress, herdr's live state idle (unknown counts
  as busy). The check and the merge run together on the task's worker
  chain, so no prompt or revive starts mid-merge.

Then `gh pr merge <n> --merge --delete-branch --match-head-commit <sha>`
(merge commit, only the approved head). The usual merged handling follows
in the same poll (deliverable merged, close-out). A failed merge logs
`pr_auto_merge_failed` once per head commit.
