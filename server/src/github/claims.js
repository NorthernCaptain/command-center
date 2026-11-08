/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// PR claims: which task owns a PR (SQLite pr_claims, unique by URL), and the
// four claim checks a discovered candidate must pass (doc 03, "Branch and PR
// identity").

import { systemClock } from "../util/clock.js"

/** Parse "https://github.com/<owner>/<repo>/pull/<n>". */
export function parsePrUrl(url) {
    const m =
        /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
            String(url || "").trim()
        )
    if (!m) return null
    return {
        owner: m[1],
        repo: m[2],
        number: Number(m[3]),
        url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`,
    }
}

/** True when `body` carries "Command-Center-Task: T-<id>" for this task. */
export function hasTaskMarker(body, taskId) {
    const re = new RegExp(
        `Command-Center-Task:\\s*T-0*${Number(taskId)}(?!\\d)`
    )
    return re.test(String(body || ""))
}

const same = (a, b) =>
    String(a || "").toLowerCase() === String(b || "").toLowerCase()

/**
 * The four claim checks, in order. Returns the first failure.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkCandidate({ task, deliverable, pr, claims, org }) {
    const head = pr.headRepository || {}
    if (pr.headRefName !== deliverable.branch)
        return { ok: false, reason: "branch_mismatch" }
    if (
        pr.isCrossRepository ||
        !same(head.owner, org) ||
        !same(head.name, deliverable.repo)
    )
        return { ok: false, reason: "foreign_head_repo" }
    const created = new Date(pr.createdAt).getTime()
    const since = new Date(deliverable.created_at).getTime()
    if (!(created > since)) return { ok: false, reason: "created_before_start" }
    if (!hasTaskMarker(pr.body, task.id))
        return { ok: false, reason: "missing_task_marker" }
    const claim = claims.claimOf(pr.url)
    if (claim && claim.task_id !== task.id)
        return { ok: false, reason: "claimed_by_other_task" }
    return { ok: true }
}

const fromRow = (r) => (r ? { ...r, manual: Boolean(r.manual) } : null)

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ clock?: object }} [opts]
 */
export function createClaims(db, { clock = systemClock } = {}) {
    const st = {
        get: db.prepare("SELECT * FROM pr_claims WHERE url = ?"),
        byTask: db.prepare(
            "SELECT * FROM pr_claims WHERE task_id = ? ORDER BY claimed_at, url"
        ),
        insert: db.prepare(
            `INSERT INTO pr_claims (url, task_id, repo, number, branch,
                claimed_at, manual)
             VALUES (@url, @task_id, @repo, @number, @branch, @claimed_at,
                @manual)
             ON CONFLICT(url) DO NOTHING`
        ),
        del: db.prepare("DELETE FROM pr_claims WHERE url = ?"),
    }

    return {
        claimOf(url) {
            return fromRow(st.get.get(String(url)))
        },
        claimsForTask(taskId) {
            return st.byTask.all(Number(taskId)).map(fromRow)
        },
        /**
         * Insert the claim. Idempotent for the same task; returns
         * { ok:false, claim } when another task already owns the URL.
         */
        claim({ url, task_id, repo, number, branch, manual = false }) {
            st.insert.run({
                url: String(url),
                task_id: Number(task_id),
                repo: String(repo),
                number: Number(number),
                branch: String(branch),
                claimed_at: clock.now().toISOString(),
                manual: manual ? 1 : 0,
            })
            const row = fromRow(st.get.get(String(url)))
            return row.task_id === Number(task_id)
                ? { ok: true, claim: row }
                : { ok: false, claim: row }
        },
        release(url) {
            return st.del.run(String(url)).changes > 0
        },
    }
}
