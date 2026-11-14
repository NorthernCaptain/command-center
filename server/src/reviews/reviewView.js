/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Dashboard view of the PR reviews (docs/09-pr-reviews.md): rows, tabs,
// search and stats. Pure functions over the reviews repo's rows.

import { ineligibleReason } from "./prScan.js"
import { ACTIVE_RUN_STATUSES } from "./reviewsRepo.js"

export const TABS = ["new", "queued", "rejected", "approved", "all"]
/** Run states that put a PR in the Queued tab (in the review pipeline). */
export const QUEUED_RUN_STATUSES = ACTIVE_RUN_STATUSES
export const APPROVED_DAYS = 7
export const STATS_DAYS = 30
export const WEEKS = 8
const DAY = 86400000
const RUN_FIELDS = [
    "id",
    "kind",
    "status",
    "agent_name",
    "queued_at",
    "started_at",
    "finished_at",
    "verdict",
    "trigger_key",
    "issues",
    "summary",
    "error",
]

const ms = (iso) => (iso ? Date.parse(iso) : NaN)

/** Key of a settled PR state: "repo#number|trigger key". */
export const settledKey = (repo, number, key) => `${repo}#${number}|${key}`

/**
 * Did a finished re-review settle the PR's current state (verdict
 * unchanged)? Any such run counts, not only the latest: a retry that was
 * cancelled or failed keeps the settlement. keys: settledKey()s of the
 * finished "unchanged" runs.
 */
export function settled(pr, keys) {
    return Boolean(
        pr.needs_review === "re_review" &&
        pr.decision === "changes_requested" &&
        pr.trigger_key &&
        keys &&
        keys.has(settledKey(pr.repo, pr.number, pr.trigger_key))
    )
}

/** One PR row for the API. */
export function prRow(pr, run, repo, keys = null) {
    const reason = ineligibleReason(pr)
    const out = {
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
        title: pr.title,
        author: pr.author,
        is_draft: pr.is_draft,
        base: pr.base,
        state: pr.state,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        merged_at: pr.merged_at,
        closed_at: pr.closed_at,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
        ci_state: pr.ci_state,
        mergeable: pr.mergeable,
        review_decision: pr.review_decision,
        decision: pr.decision,
        decided_at: pr.decided_at,
        decided_sha: pr.decided_sha,
        first_review_at: pr.first_review_at,
        attempts: pr.attempts,
        // a re-review of this very state ended "unchanged": our change
        // request stands, nothing waits (Rejected, not New)
        needs_review: settled(pr, keys) ? null : pr.needs_review,
        settled: settled(pr, keys),
        eligible: !reason,
        ineligible_reason: reason,
        tracked: Boolean(repo && repo.track),
        tracked_auto: Boolean(repo && repo.auto_review),
        run: null,
    }
    if (run) {
        out.run = { agent_open: Boolean(run.workspace_id) }
        for (const k of RUN_FIELDS) out.run[k] = run[k] ?? null
    }
    return out
}

const inQueue = (row) =>
    Boolean(row.run && QUEUED_RUN_STATUSES.includes(row.run.status))

/**
 * Does the row belong to the tab? New: open PRs of tracked repos that need
 * Leo (a review needed, none in the queue: tracked-only repos, PRs an
 * automatic review can't take, failed automatic reviews). Queued: PRs with
 * a review run in flight. Rejected: our change request, not answered yet.
 */
export function inTab(row, tab, nowMs) {
    if (tab === "new")
        return (
            row.state === "OPEN" &&
            !row.is_draft &&
            Boolean(row.needs_review) &&
            row.tracked &&
            !inQueue(row)
        )
    if (tab === "queued") return inQueue(row)
    // our change request still stands unanswered: no new commit or comment
    // since (that is a re-review: New or Queued)
    if (tab === "rejected")
        return (
            row.decision === "changes_requested" &&
            !row.needs_review &&
            !inQueue(row)
        )
    if (tab === "approved")
        return (
            row.decision === "approved" &&
            nowMs - ms(row.decided_at) <= APPROVED_DAYS * DAY
        )
    return true
}

/** Search: "417" / "#417" is a PR number, anything else text. */
export function matches(row, q) {
    const s = String(q || "").trim()
    if (!s) return true
    const num = /^#?(\d+)$/.exec(s)
    if (num) return row.number === Number(num[1])
    const needle = s.toLowerCase()
    return [row.title, row.author, row.repo].some((v) =>
        String(v || "")
            .toLowerCase()
            .includes(needle)
    )
}

/** Sections of the All tab, in display order. */
export const GROUPS = [
    "queued",
    "new",
    "rejected",
    "approved",
    "merged",
    "closed",
    "other",
]

/** The All tab section of a row (its status). */
export function groupOf(row, nowMs) {
    const open = row.state === "OPEN"
    if (inQueue(row)) return "queued"
    if (inTab(row, "new", nowMs)) return "new"
    if (open && inTab(row, "rejected", nowMs)) return "rejected"
    if (open && row.decision === "approved") return "approved"
    if (row.state === "MERGED") return "merged"
    if (row.state === "CLOSED") return "closed"
    return "other"
}

/** Newest PR first; All: by section first. */
function sortRows(rows, tab) {
    const newest = (a, b) =>
        (ms(b.created_at) || 0) - (ms(a.created_at) || 0) || b.number - a.number
    if (tab !== "all") return rows.sort(newest)
    const at = (r) => GROUPS.indexOf(r.group)
    return rows.sort((a, b) => at(a) - at(b) || newest(a, b))
}

/**
 * @param {{ prs: object[], runs: Map, repos: object[], tab?: string,
 *           q?: string, nowMs: number }} p
 */
export function listView({
    prs,
    runs,
    repos,
    settledKeys = null,
    tab = "new",
    q = "",
    nowMs,
}) {
    const repoMap = new Map(repos.map((r) => [r.name, r]))
    const rows = prs.map((p) =>
        prRow(
            p,
            runs.get(`${p.repo}#${p.number}`),
            repoMap.get(p.repo),
            settledKeys
        )
    )
    for (const r of rows) r.group = groupOf(r, nowMs)
    const found = rows.filter((r) => matches(r, q))
    const counts = {}
    for (const t of TABS)
        counts[t] = found.filter((r) => inTab(r, t, nowMs)).length
    return {
        prs: sortRows(
            found.filter((r) => inTab(r, tab, nowMs)),
            tab
        ),
        counts,
    }
}

const median = (list) => {
    if (!list.length) return null
    const s = [...list].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10)

/** Monday 00:00 UTC of the week holding t, as YYYY-MM-DD. */
export function weekStart(t) {
    const d = new Date(t)
    const day = (d.getUTCDay() + 6) % 7
    return new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)
    )
        .toISOString()
        .slice(0, 10)
}

/**
 * @param {{ prs: object[], decisions: object[], runs: object[],
 *           nowMs: number }} p  runs: active runs (queued / running)
 */
export function computeStats({
    prs,
    decisions,
    runs = [],
    repos,
    settledKeys = null,
    nowMs,
}) {
    // waiting: only PRs of tracked repos (untracked ones are hidden)
    const tracked = repos
        ? new Set(repos.filter((r) => r.track).map((r) => r.name))
        : null
    const since = nowMs - STATS_DAYS * DAY
    const recent = decisions.filter((d) => ms(d.submitted_at) >= since)
    const count = (list, state) => list.filter((d) => d.state === state).length

    const attempts = { 1: 0, 2: 0, 3: 0, "4+": 0 }
    const toApprove = []
    for (const p of prs) {
        if (p.decision !== "approved" || ms(p.decided_at) < since) continue
        const n = Math.max(1, p.attempts || 1)
        attempts[n >= 4 ? "4+" : String(n)]++
        toApprove.push(n)
    }

    const weeks = []
    for (let i = WEEKS - 1; i >= 0; i--)
        weeks.push(weekStart(nowMs - i * 7 * DAY))
    const weekly = weeks.map((week) => ({
        week,
        approved: 0,
        changes_requested: 0,
    }))
    const byWeek = new Map(weekly.map((w) => [w.week, w]))
    for (const d of decisions) {
        const w = byWeek.get(weekStart(ms(d.submitted_at)))
        if (!w) continue
        if (d.state === "APPROVED") w.approved++
        if (d.state === "CHANGES_REQUESTED") w.changes_requested++
    }

    const firstHours = prs
        .filter((p) => p.first_review_at && ms(p.first_review_at) >= since)
        .map((p) => (ms(p.first_review_at) - ms(p.created_at)) / 3600000)
        .filter((h) => Number.isFinite(h) && h >= 0)

    const authors = new Map()
    for (const d of recent) {
        if (!d.author) continue
        const a = authors.get(d.author) || {
            author: d.author,
            approved: 0,
            changes_requested: 0,
        }
        if (d.state === "APPROVED") a.approved++
        if (d.state === "CHANGES_REQUESTED") a.changes_requested++
        authors.set(d.author, a)
    }

    const active = new Set(runs.map((r) => `${r.repo}#${r.number}`))
    return {
        window_days: STATS_DAYS,
        approved: count(recent, "APPROVED"),
        changes_requested: count(recent, "CHANGES_REQUESTED"),
        attempts,
        weekly,
        median_first_review_hours: round1(median(firstHours)),
        avg_attempts_to_approve: toApprove.length
            ? round1(toApprove.reduce((a, b) => a + b, 0) / toApprove.length)
            : null,
        waiting: prs.filter(
            (p) =>
                p.state === "OPEN" &&
                !p.is_draft &&
                p.needs_review &&
                (!tracked || tracked.has(p.repo)) &&
                !settled(p, settledKeys) &&
                !active.has(`${p.repo}#${p.number}`)
        ).length,
        reviewing: runs.filter((r) => r.status !== "queued").length,
        queued: runs.filter((r) => r.status === "queued").length,
        authors: [...authors.values()]
            .sort(
                (a, b) =>
                    b.approved +
                    b.changes_requested -
                    (a.approved + a.changes_requested)
            )
            .slice(0, 8),
    }
}
