/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// PR reviews tables (docs/09-pr-reviews.md): review_repos, review_prs,
// review_decisions, review_runs.

import { SETTLED_VERDICT, USAGE_LIMIT_ERROR } from "../contracts/reviews.js"
import { systemClock } from "../util/clock.js"

/** Run states that hold (or wait for) an agent slot. */
export const ACTIVE_RUN_STATUSES = ["queued", "running", "reported"]
/** The error of a run Leo cancelled on the dashboard. */
export const CANCELLED_BY_OWNER = "cancelled"
/** A failed run whose agent is kept open on purpose (for a look). */
export const NO_REPORT = "no report"
/** Run states that hold an agent slot. */
export const SLOT_RUN_STATUSES = ["running", "reported"]

const PR_COLUMNS = [
    "repo",
    "number",
    "url",
    "title",
    "author",
    "author_bot",
    "is_draft",
    "base",
    "default_branch",
    "head_sha",
    "state",
    "created_at",
    "updated_at",
    "merged_at",
    "closed_at",
    "additions",
    "deletions",
    "changed_files",
    "ci_state",
    "mergeable",
    "review_decision",
    "decision",
    "decided_at",
    "decided_sha",
    "first_review_at",
    "attempts",
    "last_activity_at",
    "needs_review",
    "trigger_key",
    "last_scanned_at",
]

const RUN_PATCHABLE = new Set([
    "status",
    "kind",
    "trigger_key",
    "head_sha",
    "agent_name",
    "agent_kind",
    "workspace_id",
    "pane_id",
    "folder",
    "started_at",
    "reported_at",
    "finished_at",
    "verdict",
    "issues",
    "summary",
    "error",
    "seen_working",
    "idle_since",
    "nudged_at",
])

const toRepo = (r) =>
    r && {
        name: r.repo,
        track: Boolean(r.track),
        auto_review: Boolean(r.auto_review),
        last_scan_at: r.last_scan_at || null,
        error: r.last_error || null,
        backfilled: Boolean(r.backfilled),
    }

const toPr = (r) =>
    r && {
        ...r,
        author_bot: Boolean(r.author_bot),
        is_draft: Boolean(r.is_draft),
    }

const toRun = (r) => r && { ...r, seen_working: Boolean(r.seen_working) }

export function createReviewsRepo(db, { clock = systemClock } = {}) {
    const now = () => clock.now().toISOString()
    const prSet = PR_COLUMNS.filter((c) => c !== "repo" && c !== "number")
        .map((c) => `${c} = excluded.${c}`)
        .join(", ")
    const st = {
        repos: db.prepare("SELECT * FROM review_repos ORDER BY repo"),
        repo: db.prepare("SELECT * FROM review_repos WHERE repo = ?"),
        setRepo: db.prepare(
            `INSERT INTO review_repos (repo, track, auto_review, updated_at)
             VALUES (@repo, @track, @auto_review, @at)
             ON CONFLICT(repo) DO UPDATE SET track = excluded.track,
                auto_review = excluded.auto_review,
                updated_at = excluded.updated_at`
        ),
        scanned: db.prepare(
            `UPDATE review_repos SET last_scan_at = ?, last_error = ?
             WHERE repo = ?`
        ),
        backfilled: db.prepare(
            "UPDATE review_repos SET backfilled = 1 WHERE repo = ?"
        ),
        upsertPr: db.prepare(
            `INSERT INTO review_prs (${PR_COLUMNS.join(", ")}, first_seen_at)
             VALUES (${PR_COLUMNS.map((c) => `@${c}`).join(", ")}, @first_seen_at)
             ON CONFLICT(repo, number) DO UPDATE SET ${prSet}`
        ),
        pr: db.prepare(
            "SELECT * FROM review_prs WHERE repo = ? AND number = ?"
        ),
        prs: db.prepare(
            "SELECT * FROM review_prs ORDER BY COALESCE(updated_at, created_at) DESC"
        ),
        openPrs: db.prepare(
            "SELECT * FROM review_prs WHERE repo = ? AND state = 'OPEN'"
        ),
        addDecision: db.prepare(
            `INSERT INTO review_decisions (repo, number, review_id, state,
                submitted_at, commit_sha)
             VALUES (@repo, @number, @review_id, @state, @submitted_at,
                @commit_sha)
             ON CONFLICT(repo, number, review_id) DO UPDATE SET
                state = excluded.state, submitted_at = excluded.submitted_at,
                commit_sha = excluded.commit_sha`
        ),
        decisions: db.prepare(
            `SELECT d.*, p.author FROM review_decisions d
             LEFT JOIN review_prs p ON p.repo = d.repo AND p.number = d.number
             ORDER BY d.submitted_at`
        ),
        createRun: db.prepare(
            `INSERT INTO review_runs (repo, number, kind, status, trigger_key,
                manual, head_sha, agent_kind, retry_of, queued_at)
             VALUES (@repo, @number, @kind, 'queued', @trigger_key, @manual,
                @head_sha, @agent_kind, @retry_of, @queued_at)`
        ),
        run: db.prepare("SELECT * FROM review_runs WHERE id = ?"),
        latestRun: db.prepare(
            `SELECT * FROM review_runs WHERE repo = ? AND number = ?
             ORDER BY id DESC LIMIT 1`
        ),
        latestRuns: db.prepare(
            `SELECT r.* FROM review_runs r JOIN (
                SELECT repo, number, MAX(id) AS id FROM review_runs
                GROUP BY repo, number) m ON m.id = r.id`
        ),
        // a run the system cancelled before it started (auto-review off,
        // …) does not count: the state may be queued again; one Leo
        // cancelled does
        runWithKey: db.prepare(
            `SELECT * FROM review_runs WHERE repo = ? AND number = ?
                AND trigger_key = ?
                AND NOT (status = 'cancelled' AND started_at IS NULL
                    AND COALESCE(error, '') != '${CANCELLED_BY_OWNER}')
                AND COALESCE(error, '') NOT LIKE '${USAGE_LIMIT_ERROR}%'
                ORDER BY id DESC LIMIT 1`
        ),
        settledRuns: db.prepare(
            `SELECT repo, number, trigger_key FROM review_runs
             WHERE status = 'done' AND verdict = '${SETTLED_VERDICT}'
                AND trigger_key IS NOT NULL`
        ),
        prLeftOpen: db.prepare(
            `SELECT * FROM review_runs WHERE repo = ? AND number = ?
                AND workspace_id IS NOT NULL
                AND status IN ('done', 'cancelled', 'failed') ORDER BY id`
        ),
        leftOpen: db.prepare(
            `SELECT * FROM review_runs WHERE workspace_id IS NOT NULL
                AND status IN ('done', 'cancelled', 'failed')
                AND COALESCE(error, '') != '${NO_REPORT}' ORDER BY id`
        ),
        runsByStatus: (statuses) =>
            db.prepare(
                `SELECT * FROM review_runs WHERE status IN (${statuses
                    .map(() => "?")
                    .join(", ")}) ORDER BY id`
            ),
    }

    return {
        // ---- repos ------------------------------------------------------
        listRepos() {
            return st.repos.all().map(toRepo)
        },
        getRepo(name) {
            return toRepo(st.repo.get(name)) || null
        },
        /**
         * A given flag wins over the stored one: track off clears
         * auto_review, auto_review on turns track on.
         */
        setRepo(name, { track, auto_review } = {}) {
            const cur = this.getRepo(name) || {
                track: false,
                auto_review: false,
            }
            let t = track === undefined ? cur.track : Boolean(track)
            let a =
                auto_review === undefined
                    ? cur.auto_review
                    : Boolean(auto_review)
            if (track === false) a = false
            else if (auto_review === true) t = true
            else if (!t) a = false
            st.setRepo.run({
                repo: name,
                track: t ? 1 : 0,
                auto_review: a ? 1 : 0,
                at: now(),
            })
            return this.getRepo(name)
        },
        markScanned(name, error = null) {
            st.scanned.run(
                now(),
                error ? String(error).slice(0, 500) : null,
                name
            )
        },
        markBackfilled(name) {
            st.backfilled.run(name)
        },

        // ---- prs --------------------------------------------------------
        upsertPr(pr) {
            const row = {}
            for (const c of PR_COLUMNS) row[c] = pr[c] ?? null
            row.author_bot = pr.author_bot ? 1 : 0
            row.is_draft = pr.is_draft ? 1 : 0
            row.attempts = pr.attempts || 0
            row.first_seen_at = now()
            st.upsertPr.run(row)
            return this.getPr(pr.repo, pr.number)
        },
        getPr(repo, number) {
            return toPr(st.pr.get(repo, Number(number))) || null
        },
        listPrs() {
            return st.prs.all().map(toPr)
        },
        openPrs(repo) {
            return st.openPrs.all(repo).map(toPr)
        },

        // ---- decisions --------------------------------------------------
        addDecisions(repo, number, list) {
            for (const d of list)
                st.addDecision.run({
                    repo,
                    number: Number(number),
                    review_id: String(d.id),
                    state: d.state,
                    submitted_at: d.submittedAt || null,
                    commit_sha: d.commit || null,
                })
        },
        /** Every decision with the PR author, oldest first. */
        decisions() {
            return st.decisions.all()
        },

        // ---- runs -------------------------------------------------------
        createRun({
            repo,
            number,
            kind,
            trigger_key = null,
            manual = false,
            head_sha = null,
            agent_kind = null,
            retry_of = null,
        }) {
            const info = st.createRun.run({
                repo,
                number: Number(number),
                kind,
                trigger_key,
                manual: manual ? 1 : 0,
                head_sha,
                agent_kind,
                retry_of,
                queued_at: now(),
            })
            return this.getRun(info.lastInsertRowid)
        },
        /** Finish one run and queue its replacement, both or neither. */
        failAndReplace(id, patch, replacement) {
            return db.transaction(() => {
                this.updateRun(id, patch)
                return this.createRun(replacement)
            })()
        },
        getRun(id) {
            return toRun(st.run.get(Number(id))) || null
        },
        updateRun(id, patch) {
            const keys = Object.keys(patch).filter((k) => RUN_PATCHABLE.has(k))
            if (keys.length) {
                const vals = keys.map((k) =>
                    typeof patch[k] === "boolean"
                        ? patch[k]
                            ? 1
                            : 0
                        : patch[k]
                )
                db.prepare(
                    `UPDATE review_runs SET ${keys
                        .map((k) => `${k} = ?`)
                        .join(", ")} WHERE id = ?`
                ).run(...vals, Number(id))
            }
            return this.getRun(id)
        },
        latestRun(repo, number) {
            return toRun(st.latestRun.get(repo, Number(number))) || null
        },
        /** "repo#number" -> latest run. */
        latestRuns() {
            const out = new Map()
            for (const r of st.latestRuns.all())
                out.set(`${r.repo}#${r.number}`, toRun(r))
            return out
        },
        runWithKey(repo, number, key) {
            return toRun(st.runWithKey.get(repo, Number(number), key)) || null
        },
        /** Finished "unchanged" re-reviews: { repo, number, trigger_key }. */
        settledRuns() {
            return st.settledRuns.all()
        },
        /**
         * Finished runs whose workspace close failed (all but the failed
         * "no report" ones, kept open on purpose).
         */
        leftOpen() {
            return st.leftOpen.all().map(toRun)
        },
        /** One PR's finished runs whose agent is still open (any reason). */
        prLeftOpen(repo, number) {
            return st.prLeftOpen.all(repo, Number(number)).map(toRun)
        },
        runsByStatus(statuses) {
            return st
                .runsByStatus(statuses)
                .all(...statuses)
                .map(toRun)
        },
    }
}
