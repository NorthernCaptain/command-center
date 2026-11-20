/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// PR watcher (docs 03 "PR open -> merged", "PR feedback items",
// "Deliverables", "Branch and PR identity"; phase2-contracts E).
//
// Per polled task (status ready_for_pr | pr_open | pr_feedback):
//  1. discovery + claim for every pending deliverable
//  2. per claimed PR: new feedback items (deterministic classification),
//     verification of agent-resolved items, merge / close, pr_watch row
//  3. rounds: new items join the queued round while a delivered round is
//     still open; otherwise they start a new round. Rounds are numbered per
//     task but gated per PR: a PR's oldest open round is sent unless it was
//     already sent for that PR, so feedback on one PR never waits for
//     another PR's open round
//  4. close condition (fresh discovery, then enqueueCloseOut)
//
// Every operation on one task runs through a per-task queue, so a poll, a
// claim and roundResolved never interleave; task.json updates additionally
// take store.withTaskLock. Errors are per task and never stop pollAll.

import crypto from "node:crypto"
import {
    canTransition,
    currentDeliverable,
    FOLLOW_UP_STATUSES,
    latestDeliverable,
    MANUAL_REASON,
    openDeliverables,
    openManual,
} from "../contracts/lifecycle.js"
import { enqueueCloseOut as defaultEnqueueCloseOut } from "../agent/jobs/close_out.js"
import { currentRound, feedbackDedupeKey } from "../contracts/feedback.js"
import { AppError, NotFoundError } from "../util/errors.js"
import { systemClock } from "../util/clock.js"
import { nullLogger } from "../util/logger.js"
import { checkCandidate, checkReported, parsePrUrl } from "./claims.js"
import { changeRecordState } from "../phase3/soc2.js"

export const POLLED_STATUSES = ["ready_for_pr", "pr_open", "pr_feedback"]
/**
 * Also watched: a task in review (the agent reported a non-code result)
 * with a claimed PR. It stays polled after the PRs merge, until it leaves
 * review, so a close-out that failed (or never got queued) is retried on
 * the next poll, like for a pr_open task.
 */
export const REVIEW_STATUS = "review"
/**
 * Also watched: these open statuses while a claimed PR is still open (the
 * agent went back to work on the first reviewer's comments, the task was
 * snoozed or moved): review comments on an open PR are never missed. And
 * while a deliverable still waits for its PR, so a PR the agent opens
 * mid-work is discovered and claimed. Merge close-out stays limited to the
 * PR statuses and review (checkClose).
 */
export const OPEN_PR_STATUSES = ["ready", "active", "waiting"]

const hasOpenClaimedPr = (task) =>
    (task.deliverables || []).some(
        (d) => d.disposition === "pr" && d.pr && !d.merged_at
    )
const awaitsPr = (task) =>
    (task.deliverables || []).some((d) => d.disposition === "pending")

/**
 * Is the task polled now? PR statuses; review with a claimed PR (merged
 * too); active / ready / waiting with an open claimed PR or a deliverable
 * still waiting for its PR.
 */
export function isWatched(task) {
    if (!task) return false
    if (POLLED_STATUSES.includes(task.status)) return true
    if (task.status === REVIEW_STATUS)
        return (task.deliverables || []).some(
            (d) => d.disposition === "pr" && d.pr
        )
    return (
        OPEN_PR_STATUSES.includes(task.status) &&
        (hasOpenClaimedPr(task) || awaitsPr(task))
    )
}
/** A task there is over: a PR is no longer claimed for it. */
const CLOSED_STATUSES = ["done", "cancelled"]
/** Now reason set by cc_report(ready_for_pr); cleared once the PRs exist. */
export const READY_REASON = "Ready for PR"
const RESOLVED = new Set(["fixed", "answered", "declined"])
const FAILED_CONCLUSIONS = new Set([
    "FAILURE",
    "TIMED_OUT",
    "STARTUP_FAILURE",
    "ERROR",
])
const PASSED_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"])
export const KNOWN_BOTS = [
    "github-actions",
    "dependabot",
    "renovate",
    "codecov",
    "sonarcloud",
    "vercel",
    "netlify",
    "snyk-bot",
]
const TRIVIAL_BODIES = new Set(["lgtm", ":+1:", "👍", "thanks", "thank you"])
const CLOSED_REASON = "PR closed without merge"
const RECORD_REASON = "SOC2 change record missing"
const ROUND_EVENT = "feedback_round_delivered"
const ROUND_FAILED_EVENT = "feedback_round_failed"
const ROUND_SEALED_EVENT = "feedback_round_sealed"
/** attemptKey of a round event without an item list: every PR. */
const ANY_PR = "*"
const attemptKey = (pr, round) => `${pr}\n${round}`
const OUTCOME_RANK = { failed: 3, unwired: 2, blocked: 1, delivered: 0 }
/** The worst of several delivery results (failed > unwired > blocked). */
function worstOutcome(list) {
    return list.reduce(
        (w, r) =>
            (OUTCOME_RANK[r.outcome] ?? 3) > (OUTCOME_RANK[w.outcome] ?? 3)
                ? r
                : w,
        { outcome: "delivered" }
    )
}
const DELIVERED = new Set(["sent", "queued"])
const BLOCKED_REASON = "Agent blocked — feedback waiting"
const FEEDBACK_REASON = "PR feedback"
const WATCHER_ERROR = "PR watcher:"
const ACTOR = "system"

/** Runtime setting (default on): merge task PRs GitHub lets us merge. */
export const AUTO_MERGE_SETTING = "github.auto_merge"
/**
 * GitHub merge states in which its Merge button works: CLEAN, HAS_HOOKS,
 * and UNSTABLE (a check that is not required failed or is still running).
 * BEHIND, BLOCKED (required reviews or checks), DIRTY, DRAFT and UNKNOWN do
 * not merge.
 */
const MERGEABLE_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"])
const CONFLICT_REASON = "PR merge conflict: prompt not delivered"

/** Does GitHub see a merge conflict with the base branch? */
export function hasConflict(pr) {
    return Boolean(
        pr &&
        (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY")
    )
}

/**
 * Is a PR ready to merge? Exactly when GitHub would let a person press
 * Merge: not a draft and a mergeable merge state. GitHub's own rules
 * (required reviews, whether a push dismisses an approval, required checks)
 * decide; no review or check rule of ours is added on top. autoMerge also
 * waits for the task's own work: PR feedback settled, agent idle.
 */
export function mergeReady(pr) {
    return (
        Boolean(pr) && !pr.isDraft && MERGEABLE_STATES.has(pr.mergeStateStatus)
    )
}

const lower = (s) => String(s || "").toLowerCase()
const same = (a, b) => lower(a) === lower(b)
const ms = (iso) => (iso ? new Date(iso).getTime() : NaN)
const maxIso = (list) =>
    list.filter(Boolean).reduce((a, b) => (!a || ms(b) > ms(a) ? b : a), null)

function firstLine(text, max = 200) {
    const line = String(text || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean)
    return line ? line.slice(0, max) : ""
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** "Analyze (actions)" -> "analyze-actions" (feedback item id part). */
export function checkSlug(name) {
    return (
        lower(name)
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "check"
    )
}

/**
 * Feedback id of a failed check on a PR head. The slug is for reading only:
 * distinct names can share it ("test (linux)" / "test-linux", or a long
 * common prefix), so a hash of the PR, the FULL check name and the head SHA
 * keeps the ids apart.
 */
export function ciItemId(name, headSha, prUrl = "") {
    const head = String(headSha || "nohead")
    const hash = crypto
        .createHash("sha256")
        .update(`${prUrl}\n${String(name)}\n${head}`)
        .digest("hex")
        .slice(0, 10)
    return `ci-${checkSlug(name)}-${hash}-${head.slice(0, 7)}`
}

export function isBot(login, type, actionableBots = []) {
    const l = lower(login)
    const base = l.replace(/\[bot\]$/, "")
    if (actionableBots.some((b) => lower(b).replace(/\[bot\]$/, "") === base))
        return false
    return type === "Bot" || l.endsWith("[bot]") || KNOWN_BOTS.includes(base)
}

export function isTrivialBody(body) {
    const b = lower(body)
        .trim()
        .replace(/[\s.!]+$/, "")
    return TRIVIAL_BODIES.has(b)
}

/**
 * Deterministic classification: true = actionable, false = no_action.
 * @param {{ kind, author, authorType?, body?, reviewState?, inReplyTo? }} raw
 * @param {{ prAuthor?: string|null, actionableBots?: string[] }} ctx
 */
export function classify(raw, { prAuthor = null, actionableBots = [] } = {}) {
    if (raw.kind === "ci_failure") return true
    if (isBot(raw.author, raw.authorType, actionableBots)) return false
    // A reviewer bot we act on (actionableBots) raises work with its review
    // comments, but its replies inside a thread are conversation: acting on
    // them would loop (agent replies, bot replies, ...).
    if (raw.inReplyTo && isBot(raw.author, raw.authorType, [])) return false
    const body = String(raw.body || "").trim()
    if (
        prAuthor &&
        same(raw.author, prAuthor) &&
        (/^re:/i.test(body) || raw.inReplyTo)
    )
        return false
    if (raw.kind === "review" && raw.reviewState === "APPROVED" && !body)
        return false
    return !isTrivialBody(body)
}

/**
 * CI state of the head: failure | pending | incomplete | success | null
 * (no checks). success only when every check finished with a passing
 * conclusion; a finished check that neither passed nor failed (CANCELLED,
 * ACTION_REQUIRED, STALE, …) makes it "incomplete".
 */
export function ciStateOf(checks = []) {
    if (!checks.length) return null
    if (checks.some((c) => FAILED_CONCLUSIONS.has(c.conclusion)))
        return "failure"
    if (checks.some((c) => c.status !== "COMPLETED")) return "pending"
    if (checks.some((c) => !PASSED_CONCLUSIONS.has(c.conclusion)))
        return "incomplete"
    return "success"
}

/**
 * Every feedback candidate on a PR (without round/status), classified.
 * Reviews count when they have a body, request changes or approve.
 */
export function extractItems({
    pr,
    reviewComments = [],
    prUrl,
    actionableBots = [],
}) {
    const prAuthor = pr.author && pr.author.login
    const ctx = { prAuthor, actionableBots }
    const out = []
    const base = (fields) => ({
        pr: prUrl,
        path: null,
        line: null,
        ...fields,
    })
    for (const c of reviewComments) {
        const raw = {
            kind: "review_comment",
            author: c.user && c.user.login,
            authorType: c.user && c.user.type,
            body: c.body,
            inReplyTo: c.in_reply_to_id,
        }
        out.push(
            base({
                id: `gh-rc-${c.id}`,
                kind: raw.kind,
                author: raw.author || null,
                url: c.html_url || prUrl,
                path: c.path || null,
                line: Number.isInteger(c.line)
                    ? c.line
                    : Number.isInteger(c.original_line)
                      ? c.original_line
                      : null,
                summary: firstLine(c.body),
                actionable: classify(raw, ctx),
            })
        )
    }
    for (const r of pr.reviews || []) {
        const body = String(r.body || "").trim()
        if (!body && r.state !== "CHANGES_REQUESTED" && r.state !== "APPROVED")
            continue
        const raw = {
            kind: "review",
            author: r.author && r.author.login,
            authorType: r.author && r.author.type,
            body,
            reviewState: r.state,
        }
        out.push(
            base({
                id: `gh-rv-${r.id}`,
                kind: raw.kind,
                author: raw.author || null,
                url: r.url || prUrl,
                summary: firstLine(body) || `Review: ${r.state}`,
                actionable: classify(raw, ctx),
            })
        )
    }
    for (const c of pr.comments || []) {
        const raw = {
            kind: "issue_comment",
            author: c.author && c.author.login,
            authorType: c.author && c.author.type,
            body: c.body,
        }
        out.push(
            base({
                id: `gh-ic-${c.id}`,
                kind: raw.kind,
                author: raw.author || null,
                url: c.url || prUrl,
                summary: firstLine(c.body),
                actionable: classify(raw, ctx),
            })
        )
    }
    const seen = new Set()
    for (const c of pr.statusCheckRollup || []) {
        if (c.status !== "COMPLETED" || !FAILED_CONCLUSIONS.has(c.conclusion))
            continue
        const id = ciItemId(c.name, pr.headRefOid, prUrl)
        if (seen.has(id)) continue
        seen.add(id)
        out.push(
            base({
                id,
                kind: "ci_failure",
                author: null,
                url: c.detailsUrl || `${prUrl}/checks`,
                // the check name: verification looks the check up by it
                summary: c.name,
                actionable: true,
            })
        )
    }
    return out
}

/**
 * Verify one agent-resolved item against fresh PR data (doc 03 table).
 * @returns {{ result: "pass"|"fail"|"pending", missing?: string }}
 */
export function verifyItem(item, { pr, reviewComments = [] }) {
    const commitOk = () => {
        const sha = lower(item.commit).trim()
        return (
            sha.length >= 7 &&
            (pr.commits || []).some((c) => lower(c.oid).startsWith(sha))
        )
    }
    const prCommentOk = () =>
        (pr.comments || []).some(
            (c) =>
                /^\s*re:/i.test(c.body || "") &&
                String(c.body).includes(item.url)
        )
    const threadReplyOk = () => {
        const id = Number(item.id.replace(/^gh-rc-/, ""))
        const own = reviewComments.find((c) => c.id === id)
        const root = (own && own.in_reply_to_id) || id
        const after = own ? ms(own.created_at) : -Infinity
        return reviewComments.some(
            (c) =>
                c.id !== id &&
                c.in_reply_to_id === root &&
                !(ms(c.created_at) <= after)
        )
    }
    const fail = (missing) => ({ result: "fail", missing })
    const pass = { result: "pass" }
    const fixed = item.status === "fixed"
    if (fixed && !commitOk()) return fail("commit")
    switch (item.kind) {
        case "review_comment":
            return threadReplyOk() ? pass : fail("thread_reply")
        case "ci_failure": {
            if (!fixed) return prCommentOk() ? pass : fail("re_comment")
            // Check names are not unique (two workflows can both have
            // "test"): every check with this name must pass on the head.
            const checks = (pr.statusCheckRollup || []).filter(
                (c) => c.name === item.summary
            )
            if (!checks.length) return { result: "pending" }
            if (
                checks.some(
                    (c) =>
                        c.status === "COMPLETED" &&
                        !PASSED_CONCLUSIONS.has(c.conclusion)
                )
            )
                return fail("check")
            if (checks.some((c) => c.status !== "COMPLETED"))
                return { result: "pending" }
            return pass
        }
        default:
            return prCommentOk() ? pass : fail("re_comment")
    }
}

const newLinkId = () => `l_${crypto.randomBytes(5).toString("hex")}`

/** Feedback record without `at` (appendFeedback stamps a fresh one). */
function record(item, patch = {}) {
    // eslint-disable-next-line no-unused-vars
    const { at, ...rest } = item
    return { ...rest, ...patch }
}

/**
 * @param {object} deps  see phase2-contracts E; `feedbackPrompt` is the
 *        prompts.feedbackPrompt function; `enqueueCloseOut` defaults to the
 *        close_out helper; `actionableBots` lists bot logins whose comments
 *        are real review input (default none, per the spec).
 */
export function createPrWatcher({
    store,
    gh,
    claims,
    db,
    workerService = null,
    jobRunner = null,
    asanaService = null,
    settingsRepo = null,
    notifier = null,
    bus = null,
    clock = systemClock,
    log = nullLogger,
    org,
    feedbackPrompt = null,
    conflictPrompt = null,
    enqueueCloseOut = defaultEnqueueCloseOut,
    pollMinutes = 15,
    startDelayMs = 5000,
    actionableBots = [],
}) {
    const now = () => clock.now().toISOString()
    const queues = new Map()
    const mergeFailedHead = new Map() // PR url -> head sha of the last failed merge
    // PR url -> head sha whose conflict prompt was handed to the outbox (a
    // queued prompt is not reported as a duplicate by deliver)
    const conflictHead = new Map()
    const inflight = new Map()
    const candidateMap = new Map() // taskId -> Map(repo -> [{repo,url,number,reason}])
    let pollAllRun = null
    let timer = null
    let running = false
    let stopping = false

    const st = {
        claimWatch: db.prepare(
            // closed_at is left to pollPr: it records AND reports a closure
            // (a closed PR claimed later must still be surfaced once)
            `INSERT INTO pr_watch (task_id, repo, number, url, state, head_sha,
                merged_at)
             VALUES (@task_id, @repo, @number, @url, @state, @head_sha,
                @merged_at)
             ON CONFLICT(repo, number) DO UPDATE SET task_id = excluded.task_id,
                url = excluded.url, state = excluded.state,
                head_sha = excluded.head_sha, merged_at = excluded.merged_at`
        ),
        pollWatch: db.prepare(
            `INSERT INTO pr_watch (task_id, repo, number, url, state, head_sha,
                merged_at, closed_at, ci_state, last_comment_at,
                last_review_at, last_checked_at)
             VALUES (@task_id, @repo, @number, @url, @state, @head_sha,
                @merged_at, @closed_at, @ci_state, @last_comment_at,
                @last_review_at, @last_checked_at)
             ON CONFLICT(repo, number) DO UPDATE SET task_id = excluded.task_id,
                url = excluded.url, state = excluded.state,
                head_sha = excluded.head_sha, merged_at = excluded.merged_at,
                closed_at = excluded.closed_at, ci_state = excluded.ci_state,
                last_comment_at = COALESCE(excluded.last_comment_at,
                    pr_watch.last_comment_at),
                last_review_at = COALESCE(excluded.last_review_at,
                    pr_watch.last_review_at),
                last_checked_at = excluded.last_checked_at`
        ),
        getWatch: db.prepare(
            "SELECT * FROM pr_watch WHERE repo = ? AND number = ?"
        ),
        byTask: db.prepare(
            "SELECT * FROM pr_watch WHERE task_id = ? ORDER BY repo, number"
        ),
        delWatch: db.prepare(
            "DELETE FROM pr_watch WHERE task_id = ? AND repo = ? AND number = ?"
        ),
    }

    // ---- plumbing ------------------------------------------------------

    /** Run fn after every earlier operation on the task has settled. */
    function serial(taskId, fn) {
        const prev = queues.get(taskId) || Promise.resolve()
        const run = prev.then(fn)
        const tail = run.catch(() => {})
        queues.set(taskId, tail)
        tail.then(() => {
            if (queues.get(taskId) === tail) queues.delete(taskId)
        })
        return run
    }

    function emit(type, taskId) {
        if (!bus) return
        try {
            bus.emit(type, { task_id: taskId, data: {} })
        } catch (err) {
            log.warn({ err: err.message, type }, "bus listener failed")
        }
    }

    async function notify(title, body) {
        if (!notifier) return
        try {
            await notifier.notify({ title, body })
        } catch (err) {
            log.warn({ err: err.message }, "notification failed")
        }
    }

    async function asanaComment(gid, text) {
        if (!gid || !asanaService) return
        try {
            await asanaService.comment(gid, text)
        } catch (err) {
            log.warn({ err: err.message, gid }, "asana comment failed")
        }
    }

    const getTask = async (taskId) => (await store.getTask(taskId)).task

    /** Read-modify-write task.json under the store lock. */
    function mutateTask(taskId, fn, opts = {}) {
        return store.withTaskLock(taskId, async () => {
            const task = await getTask(taskId)
            const patch = await fn(task)
            if (!patch) return task
            const res = await store.updateTask(taskId, patch, {
                actor: opts.actor || ACTOR,
                reason: opts.reason,
            })
            return res.task
        })
    }

    /** Set flags.now (+ optional status move when the lifecycle allows). */
    function flagNow(taskId, reason, status = null) {
        return mutateTask(
            taskId,
            (task) => {
                const patch = { flags: { now: true, now_reason: reason } }
                if (
                    status &&
                    task.status !== status &&
                    isWatched(task) &&
                    canTransition(task.status, status)
                )
                    patch.status = status
                return patch
            },
            { reason }
        )
    }

    async function setError(taskId, message) {
        try {
            await mutateTask(taskId, (task) =>
                task.flags.error === `${WATCHER_ERROR} ${message}`
                    ? null
                    : { flags: { error: `${WATCHER_ERROR} ${message}` } }
            )
        } catch (err) {
            log.warn({ err: err.message, taskId }, "cannot record PR error")
        }
    }

    async function clearError(taskId) {
        await mutateTask(taskId, (task) =>
            String(task.flags.error || "").startsWith(WATCHER_ERROR)
                ? { flags: { error: null } }
                : null
        )
    }

    function prKey(prUrl) {
        const p = parsePrUrl(prUrl)
        return p ? `${p.repo}-${p.number}` : String(prUrl)
    }

    /**
     * Matcher for the outbox dedupe keys of one PR's feedback prompts:
     * round-<pr>-<round>, manual-<pr>-<round>-<ms>, reverify-<pr>-<item ids>,
     * reopen-<pr>-<item id>-<ms>, resume-<pr>-<round>-<ms> (PR reopened).
     * Anchored so org/x #1 never matches org/x-1 #5 (item ids start with a
     * letter, rounds and stamps are digits).
     */
    function prFeedbackKey(prUrl) {
        const k = escapeRe(prKey(prUrl))
        const re = new RegExp(
            `^(?:round-${k}-\\d+|(?:manual|resume)-${k}-\\d+-\\d+|reverify-${k}-[a-z].*|reopen-${k}-[a-z].*-\\d+|conflict-${k}-[0-9a-f]*)$`
        )
        return (key) => re.test(key)
    }

    // ---- claims --------------------------------------------------------

    function setCandidates(taskId, repo, list) {
        if (!candidateMap.has(taskId)) candidateMap.set(taskId, new Map())
        candidateMap.get(taskId).set(repo, list)
    }

    /** The task's main repo (role main, else the first). */
    function isMainRepo(task, repo) {
        const repos = task.repos || []
        const main = repos.find((r) => r.role === "main") || repos[0]
        return Boolean(main && same(main.name, repo))
    }

    /**
     * Where the PR `url` goes among repo's deliverables: { index } of the
     * deliverable it fills (existing: it is already that one's PR), index -1
     * to add a deliverable (a follow-up PR), or { reason } when it can't go
     * anywhere. A pending deliverable comes first. A repo whose newest
     * deliverable is no_change takes no PR (that decision stands).
     */
    function slotFor(deliverables, repo, url) {
        const at = (pred) =>
            deliverables.findIndex((x) => same(x.repo, repo) && pred(x))
        const has = at((x) => x.disposition === "pr" && x.pr === url)
        if (has >= 0) return { index: has, existing: true }
        if (at(() => true) < 0) return { reason: "no_deliverable" }
        const pending = at((x) => x.disposition === "pending")
        if (pending >= 0) return { index: pending }
        const latest = latestDeliverable(deliverables, repo, same)
        if (latest.disposition === "no_change")
            return { reason: "deliverable_no_change" }
        return { index: -1 }
    }

    /**
     * Why the task's status takes no new claim, or null: done / cancelled
     * takes none (task_closed); otherwise only a status where the watcher
     * polls a task with a claimed PR (not_watched, e.g. inbox: its PR would
     * never be followed to its merge).
     */
    function statusRefusal(task, slot) {
        if (slot.existing) return null
        if (CLOSED_STATUSES.includes(task.status)) return "task_closed"
        if (!FOLLOW_UP_STATUSES.includes(task.status)) return "not_watched"
        return null
    }

    /** True when this task holds a PR claim in repo whose head is branch. */
    function ownsBranch(taskId, repo, branch) {
        return claims
            .claimsForTask(Number(taskId))
            .some((c) => same(c.repo, repo) && c.branch === branch)
    }

    /**
     * Record a claim: pr_claims, deliverable, link, status, pr_watch.
     * expected: what the PR was checked against, re-checked under the lock
     * (deliverable_changed otherwise): { branch, created_at } of the
     * pending deliverable it fills, or "append" for a follow-up.
     */
    async function applyClaim(taskId, repo, pr, { manual, actor, expected }) {
        const held = claims.claimOf(pr.url)
        const res = claims.claim({
            url: pr.url,
            task_id: taskId,
            repo,
            number: pr.number,
            branch: pr.headRefName || "",
            manual,
        })
        if (!res.ok) return { ok: false, reason: "claimed_by_other_task" }
        const at = now()
        const merged = Boolean(pr.mergedAt) || pr.state === "MERGED"
        const mergedAt = merged
            ? pr.mergedAt
                ? new Date(pr.mergedAt).toISOString()
                : at
            : null
        let deliverable = null
        let gid = null
        // the branches the claim moved (kept on pr_claimed, so unclaim can
        // move them back)
        // appended: the claim added a deliverable of its own (follow-up PR)
        const moved = { deliverable: null, task: null, appended: false }
        const refused = { reason: null }
        try {
            await mutateTask(
                taskId,
                (task) => {
                    gid = task.asana && task.asana.gid
                    const head = pr.headRefName || null
                    let movedFrom = null
                    let followUpBranch = null
                    const slot = slotFor(task.deliverables, repo, pr.url)
                    // checked again under the lock, as the task may have
                    // moved while the PR was read: marked no change, or done
                    // / cancelled (nothing would watch a new PR there). A
                    // close-out applies under this same lock (job lock):
                    // the claim lands before its closable re-check (which
                    // then refuses to close) or after done (refused here).
                    if (slot.reason) {
                        refused.reason = slot.reason
                        throw refused
                    }
                    // the deliverable it was checked against is still the
                    // one it goes to (not, say, a follow-up registered while
                    // the PR was read after the first was marked no change)
                    if (expected && !slot.existing) {
                        const t =
                            slot.index >= 0
                                ? task.deliverables[slot.index]
                                : null
                        const kept =
                            expected === "append"
                                ? !t
                                : Boolean(
                                      t &&
                                      t.branch === expected.branch &&
                                      t.created_at === expected.created_at
                                  )
                        if (!kept) {
                            refused.reason = "deliverable_changed"
                            throw refused
                        }
                    }
                    const refusal = statusRefusal(task, slot)
                    if (refusal) {
                        refused.reason = refusal
                        throw refused
                    }
                    let deliverables
                    if (slot.index >= 0) {
                        // A claimed PR on another branch (an agent working on an
                        // existing PR, or Leo's manual claim) moves the
                        // deliverable onto the PR's head branch: that is the
                        // branch pushed.
                        deliverables = task.deliverables.map((d, i) =>
                            i === slot.index
                                ? (deliverable = {
                                      ...d,
                                      ...(head && head !== d.branch
                                          ? ((movedFrom = d.branch),
                                            { branch: head })
                                          : {}),
                                      disposition: "pr",
                                      pr: pr.url,
                                      claimed_at: at,
                                      // claimed after it merged (e.g. Leo
                                      // attached a PR from another branch):
                                      // merged now
                                      merged_at: mergedAt,
                                  })
                                : d
                        )
                    } else {
                        // Every deliverable of the repo has its PR: a follow-up
                        // PR is a deliverable of its own, so the task closes
                        // only once it merges too.
                        const like = latestDeliverable(
                            task.deliverables,
                            repo,
                            same
                        )
                        deliverable = {
                            repo: like ? like.repo : repo,
                            branch: head || (like && like.branch) || "",
                            role: "work",
                            created_at: at,
                            disposition: "pr",
                            pr: pr.url,
                            claimed_at: at,
                            merged_at: mergedAt,
                        }
                        deliverables = [...task.deliverables, deliverable]
                        // an open follow-up in the main repo is the work now:
                        // the task's branch follows it (agent context,
                        // folder fallback)
                        if (head && !mergedAt && isMainRepo(task, repo))
                            followUpBranch = head
                    }
                    const links = [...task.links]
                    if (!links.some((l) => l.type === "pr" && l.url === pr.url))
                        links.push({
                            id: newLinkId(),
                            type: "pr",
                            url: pr.url,
                            label: `${repo}#${pr.number}`,
                            role: null,
                            added_by: actor,
                            at,
                        })
                    const patch = { deliverables, links }
                    if (followUpBranch && task.branch !== followUpBranch)
                        patch.branch = followUpBranch
                    if (
                        movedFrom &&
                        task.branch === movedFrom &&
                        isMainRepo(task, repo)
                    )
                        patch.branch = head
                    moved.deliverable = movedFrom
                    moved.appended = slot.index < 0
                    moved.task =
                        patch.branch && patch.branch !== task.branch
                            ? task.branch
                            : null
                    // The branch that was refused as taken is this PR's head:
                    // the conflict is resolved by the claim.
                    if (
                        head &&
                        task.flags &&
                        task.flags.now_reason ===
                            `Branch conflict: ${head} in ${repo}`
                    )
                        patch.flags = { now: false, now_reason: null }
                    if (task.status === "ready_for_pr") patch.status = "pr_open"
                    // Every deliverable has its PR (or needs none): the "Ready
                    // for PR" ask is done. Other Now reasons stay.
                    const allOpened = deliverables.every(
                        (d) => d.disposition !== "pending"
                    )
                    if (
                        allOpened &&
                        task.flags &&
                        task.flags.now_reason === READY_REASON
                    )
                        patch.flags = { now: false, now_reason: null }
                    return patch
                },
                { actor, reason: `PR claimed: ${pr.url}` }
            )
        } catch (err) {
            if (err !== refused) throw err
            if (!held) claims.release(pr.url)
            return { ok: false, reason: refused.reason }
        }
        await store.appendEvent(
            taskId,
            {
                type: "pr_claimed",
                data: {
                    url: pr.url,
                    repo,
                    number: pr.number,
                    manual,
                    appended: moved.appended,
                    ...(moved.deliverable
                        ? { branch_from: moved.deliverable }
                        : {}),
                    ...(moved.task ? { task_branch_from: moved.task } : {}),
                },
            },
            actor
        )
        st.claimWatch.run({
            task_id: taskId,
            repo,
            number: pr.number,
            url: pr.url,
            state: pr.state || null,
            head_sha: pr.headRefOid || null,
            merged_at: pr.mergedAt || null,
        })
        if (merged)
            await store.appendEvent(
                taskId,
                { type: "pr_merged", data: { url: pr.url, repo } },
                actor
            )
        const forRepo = candidateMap.get(taskId)
        if (forRepo) forRepo.delete(repo)
        await asanaComment(
            gid,
            merged ? `Merged: ${pr.url}` : `PR opened: ${pr.url}`
        )
        emit("pr.updated", taskId)
        return { ok: true, deliverable }
    }

    /**
     * PRs taken off the task (pr_unclaimed) and not claimed for it again
     * since: discovery never takes them back (only a claim on purpose:
     * cc_add_link, Leo's attach). Lower-cased URLs.
     */
    async function removedPrs(taskId) {
        const events = await store.listEvents(taskId, { limit: 100000 })
        const out = new Set()
        // newest first: walk them oldest first (file order, ties included)
        const chrono = [...events].reverse()
        for (const e of chrono) {
            const url = lower(e.data && e.data.url)
            if (!url) continue
            if (e.type === "pr_unclaimed") out.add(url)
            else if (e.type === "pr_claimed") out.delete(url)
        }
        return out
    }

    /** Discovery + claim for every pending deliverable. */
    async function discover(task, summary) {
        let removed = null
        for (const d of task.deliverables) {
            if (d.disposition !== "pending") continue
            if (removed === null) removed = await removedPrs(task.id)
            let prs
            try {
                prs = await gh.listPrsByHead(d.repo, d.branch)
            } catch (err) {
                summary.errors.push(`${d.repo}: ${err.message}`)
                continue
            }
            prs = [...prs].sort((a, b) => ms(b.createdAt) - ms(a.createdAt))
            const failed = []
            let claimed = false
            for (const pr of prs) {
                let reason = null
                if (removed.has(lower(pr.url))) {
                    reason = "removed_from_task"
                } else if (!claimed) {
                    const check = checkCandidate({
                        task,
                        deliverable: d,
                        pr,
                        claims,
                        org,
                    })
                    if (check.ok) {
                        const r = await applyClaim(task.id, d.repo, pr, {
                            manual: false,
                            actor: ACTOR,
                            expected: {
                                branch: d.branch,
                                created_at: d.created_at,
                            },
                        })
                        if (r.ok) {
                            claimed = true
                            summary.claimed.push(pr.url)
                            continue
                        }
                        reason = r.reason
                    } else reason = check.reason
                } else {
                    reason = "older_than_claimed"
                }
                failed.push({
                    repo: d.repo,
                    url: pr.url,
                    number: pr.number,
                    reason,
                })
            }
            if (!claimed) setCandidates(task.id, d.repo, failed)
        }
    }

    // ---- feedback ------------------------------------------------------

    async function roundsWith(taskId, types) {
        const events = await store.listEvents(taskId, { limit: 100000 })
        return new Set(
            events
                .filter((e) => types.includes(e.type))
                .map((e) => Number(e.data && e.data.round))
        )
    }

    /**
     * PR rounds named by round events of `types`: keys are
     * attemptKey(pr, round) for the PRs of the event's items; an event
     * without an item list counts for every PR (attemptKey(ANY_PR, round)).
     */
    async function prRoundsWith(taskId, types) {
        const [events, items] = await Promise.all([
            store.listEvents(taskId, { limit: 100000 }),
            store.listFeedback(taskId),
        ])
        const prOf = new Map(items.map((i) => [i.id, i.pr]))
        const out = new Set()
        for (const e of events) {
            if (!types.includes(e.type)) continue
            const round = Number(e.data && e.data.round)
            const ids = e.data && e.data.items
            if (!Array.isArray(ids)) {
                out.add(attemptKey(ANY_PR, round))
                continue
            }
            for (const id of ids)
                if (prOf.has(id)) out.add(attemptKey(prOf.get(id), round))
        }
        return out
    }

    /**
     * PR rounds whose prompt reached a final outcome: delivered (sent /
     * queued) or failed (failed/uncertain, never auto-resent). Either way
     * the round is "in progress" for that PR until its items are resolved.
     */
    const attemptedPrRounds = (taskId) =>
        prRoundsWith(taskId, [ROUND_EVENT, ROUND_FAILED_EVENT])

    /** Does a set from prRoundsWith cover this PR's round? */
    const covers = (set, pr, round) =>
        set.has(attemptKey(pr, round)) || set.has(attemptKey(ANY_PR, round))

    /**
     * The open work per PR: each PR's current round (its oldest open one)
     * with that round's open actionable items, and whether the round was
     * already attempted for that PR. Sorted by round, then PR.
     */
    async function prRounds(taskId, items) {
        const attempted = await attemptedPrRounds(taskId)
        const open = items.filter((i) => i.actionable && i.status === "open")
        return [...new Set(open.map((i) => i.pr))]
            .map((pr) => {
                const round = currentRound(items, pr)
                return {
                    pr,
                    round,
                    list: open.filter((i) => i.pr === pr && i.round === round),
                    attempted: covers(attempted, pr, round),
                }
            })
            .sort((a, b) => a.round - b.round || a.pr.localeCompare(b.pr))
    }

    /** [{ pr, round, list }] grouped by round: Map round -> items. */
    function byRound(work) {
        const out = new Map()
        for (const w of work) {
            if (!out.has(w.round)) out.set(w.round, [])
            out.get(w.round).push(...w.list)
        }
        return out
    }

    /**
     * Rounds whose membership is frozen: deliver() was called for them (any
     * result, including blocked). The outbox keeps the first prompt per
     * dedupe key, so new items must start a new round instead of joining.
     */
    const sealedRounds = (taskId) =>
        roundsWith(taskId, [
            ROUND_EVENT,
            ROUND_FAILED_EVENT,
            ROUND_SEALED_EVENT,
        ])

    /**
     * Send the feedback prompt for `items` (one prompt per PR).
     * @returns {Promise<{ outcome: "delivered"|"blocked"|"failed"|"unwired",
     *                     error?: string }>}
     *   delivered = every prompt was "sent" or "queued"; failed wins over
     *   blocked when PRs differ.
     */
    async function deliverItems(taskId, items, round, keyOf, summary) {
        if (!workerService || !feedbackPrompt) {
            log.warn({ taskId }, "feedback delivery not wired")
            summary.errors.push("feedback delivery not wired")
            return { outcome: "unwired" }
        }
        const task = await getTask(taskId)
        const byPr = new Map()
        for (const it of items) {
            if (!byPr.has(it.pr)) byPr.set(it.pr, [])
            byPr.get(it.pr).push(it)
        }
        let failed = null
        let blocked = false
        for (const [pr, list] of byPr) {
            const d = task.deliverables.find((x) => x.pr === pr)
            const text = feedbackPrompt({
                task,
                pr,
                round,
                items: list,
                branch: (d && d.branch) || task.branch,
            })
            try {
                const res = await workerService.deliver(taskId, text, {
                    reason: "pr_feedback",
                    dedupeKey: keyOf(pr, list),
                })
                const status = res && res.status
                if (DELIVERED.has(status)) continue
                if (status === "blocked") blocked = true
                else
                    failed =
                        (res && (res.error || res.message)) ||
                        `delivery ${status || "unknown"}`
            } catch (err) {
                log.warn({ err: err.message, taskId }, "feedback delivery")
                failed = err.message
            }
        }
        if (failed) {
            summary.delivery = "failed"
            await mutateTask(
                taskId,
                () => ({
                    flags: {
                        error: `Feedback prompt not delivered: ${failed}`,
                        now: true,
                        now_reason: "Feedback prompt not delivered",
                    },
                }),
                { reason: "feedback delivery failed" }
            )
            await notify(`T-${taskId}: feedback prompt not delivered`, failed)
            return { outcome: "failed", error: failed }
        }
        if (blocked) {
            summary.delivery = "blocked"
            await flagNow(taskId, BLOCKED_REASON)
            return { outcome: "blocked" }
        }
        return { outcome: "delivered" }
    }

    /**
     * PR urls of the task that are merged or closed without merge. Their
     * feedback is never sent to the worker any more (automatic or manual):
     * the PR can't take new commits for it.
     */
    async function finishedPrs(taskId) {
        const task = await getTask(taskId)
        const done = new Set()
        for (const d of task.deliverables || []) {
            if (!d.pr) continue
            if (d.merged_at) {
                done.add(d.pr)
                continue
            }
            const ref = parsePrUrl(d.pr)
            const watch = ref && st.getWatch.get(d.repo, ref.number)
            if (watch && (watch.merged_at || watch.closed_at)) done.add(d.pr)
        }
        return done
    }

    /** Feedback items on PRs that can still change. */
    async function liveFeedback(taskId) {
        const [items, finished] = await Promise.all([
            store.listFeedback(taskId),
            finishedPrs(taskId),
        ])
        return items.filter((i) => !finished.has(i.pr))
    }

    /**
     * Seal `round` for the PRs in `list` (a PR's items are frozen once its
     * prompt is persisted; a round can go out PR by PR, so each PR is sealed
     * on its own) and deliver it under the round dedupe keys; records
     * delivered / failed.
     * @returns {Promise<{ outcome, error? }>}
     */
    async function deliverRound(taskId, round, list, summary) {
        if (workerService && feedbackPrompt) {
            const frozen = await prRoundsWith(taskId, [
                ROUND_EVENT,
                ROUND_FAILED_EVENT,
                ROUND_SEALED_EVENT,
            ])
            const fresh = list.filter((i) => !covers(frozen, i.pr, round))
            if (fresh.length)
                await store.appendEvent(
                    taskId,
                    {
                        type: ROUND_SEALED_EVENT,
                        data: { round, items: fresh.map((i) => i.id) },
                    },
                    ACTOR
                )
        }
        const res = await deliverItems(
            taskId,
            list,
            round,
            (pr) => feedbackDedupeKey(pr, round),
            summary
        )
        // blocked / unwired: retried on the next poll (same dedupe keys)
        if (res.outcome !== "delivered" && res.outcome !== "failed") return res
        const ids = list.map((i) => i.id)
        await store.appendEvent(
            taskId,
            res.outcome === "delivered"
                ? { type: ROUND_EVENT, data: { round, items: ids } }
                : {
                      type: ROUND_FAILED_EVENT,
                      data: { round, items: ids, error: res.error },
                  },
            ACTOR
        )
        await mutateTask(taskId, (task) =>
            task.status === "pr_open" ? { status: "pr_feedback" } : null
        )
        return res
    }

    /**
     * Tell the task's agent to merge the base into each conflicting PR and
     * push. Once per PR head commit (outbox dedupe): after the agent pushes
     * the merge, only a new conflict on the new head asks again. Like
     * feedback, it relaunches the agent when none is live.
     */
    async function deliverConflicts(taskId, list, summary) {
        if (!list.length || !workerService || !conflictPrompt) return
        const task = await getTask(taskId)
        for (const { d, pr } of list) {
            const head = lower(pr.headRefOid)
            const base = pr.baseRefName || null
            // this head's prompt is already queued or sent
            if (conflictHead.get(d.pr) === head) continue
            let res
            try {
                res = await workerService.deliver(
                    taskId,
                    conflictPrompt({
                        task,
                        pr: d.pr,
                        branch: pr.headRefName || d.branch || task.branch,
                        base,
                    }),
                    {
                        reason: "pr_conflict",
                        dedupeKey: `conflict-${prKey(d.pr)}-${head}`,
                    }
                )
            } catch (err) {
                log.warn({ err: err.message, taskId }, "conflict prompt")
                summary.errors.push(`${d.pr}: conflict prompt: ${err.message}`)
                continue
            }
            conflictHead.set(d.pr, head)
            if (res && res.duplicate) continue
            const status = (res && res.status) || "unknown"
            summary.conflicts.push(d.pr)
            await store.appendEvent(
                taskId,
                {
                    type: "pr_conflict",
                    data: { url: d.pr, head, base, delivery: status },
                },
                ACTOR
            )
            if (!DELIVERED.has(status) && status !== "blocked") {
                await flagNow(taskId, CONFLICT_REASON)
                await notify(
                    `T-${taskId}: merge conflict prompt not delivered`,
                    (res && res.error) || d.pr
                )
            }
        }
    }

    /**
     * Per PR: deliver its current (oldest open) round unless that round was
     * already sent for it; a PR whose sent round is still open waits, the
     * others do not. Returns the lowest round delivered, or null.
     */
    async function maybeDeliver(taskId, summary) {
        const items = await liveFeedback(taskId)
        const due = (await prRounds(taskId, items)).filter((w) => !w.attempted)
        let first = null
        for (const [round, list] of byRound(due)) {
            const res = await deliverRound(taskId, round, list, summary)
            if (res.outcome !== "delivered") continue
            if (first === null) first = round
        }
        if (first !== null) summary.delivered_round = first
        return first
    }

    /**
     * Leo's "Address feedback" click. Goes through the same round queue as
     * the automatic delivery, per PR: each PR's oldest open round (its later
     * rounds keep waiting), sealed before its prompt is persisted. A PR
     * round that was already sent (or failed) is sent again under a fresh
     * key, because the click is an explicit request.
     * @returns {Promise<{ round, rounds, resent,
     *                     delivery: { status, error? } }>}
     *   round = the lowest round sent; delivery = the worst outcome.
     */
    function addressFeedback(taskId) {
        const id = Number(taskId)
        return serial(id, async () => {
            const summary = { errors: [] }
            const items = await liveFeedback(id)
            const work = await prRounds(id, items)
            if (!work.length)
                throw new AppError(
                    "no_open_feedback",
                    `T-${id} has no open feedback`,
                    { status: 409 }
                )
            const outcomes = []
            for (const [round, list] of byRound(
                work.filter((w) => !w.attempted)
            ))
                outcomes.push(await deliverRound(id, round, list, summary))
            const again = work.filter((w) => w.attempted)
            const stamp = clock.now().getTime()
            for (const [round, list] of byRound(again)) {
                const res = await deliverItems(
                    id,
                    list,
                    round,
                    (pr) => `manual-${prKey(pr)}-${round}-${stamp}`,
                    summary
                )
                outcomes.push(res)
                await store.appendEvent(
                    id,
                    {
                        type: "feedback_round_resent",
                        data: {
                            round,
                            items: list.map((i) => i.id),
                            outcome: res.outcome,
                        },
                    },
                    ACTOR
                )
            }
            emit("feedback.updated", id)
            const res = worstOutcome(outcomes)
            const status =
                res.outcome === "delivered"
                    ? "queued"
                    : res.outcome === "unwired"
                      ? "failed"
                      : res.outcome
            return {
                round: work[0].round,
                rounds: [...new Set(work.map((w) => w.round))],
                resent: again.length > 0,
                delivery: {
                    status,
                    ...(res.error ? { error: res.error } : {}),
                    ...(res.outcome === "unwired"
                        ? { error: "feedback delivery not wired" }
                        : {}),
                },
            }
        })
    }

    /** Append new items; they join the queued round when there is one. */
    async function recordItems(taskId, fresh) {
        if (!fresh.length) return 0
        const items = await store.listFeedback(taskId)
        const delivered = await sealedRounds(taskId)
        const maxRound = items.reduce((m, i) => Math.max(m, i.round), 0)
        const round =
            maxRound > 0 && !delivered.has(maxRound) ? maxRound : maxRound + 1
        for (const f of fresh) {
            await store.appendFeedback(
                taskId,
                {
                    ...f,
                    round,
                    status: f.actionable ? "open" : "no_action",
                    verified: false,
                    verify_failures: 0,
                },
                ACTOR
            )
        }
        return round
    }

    /**
     * Once no actionable item is open on a PR that can still change (a
     * merged / closed PR's leftovers can't be addressed): pr_feedback ->
     * pr_open, and the "PR feedback" Now flag goes whatever the status is
     * (a task in review keeps its status). A "feedback_addressed" event
     * marks the moment.
     */
    async function settleStatus(taskId) {
        const items = await liveFeedback(taskId)
        if (items.some((i) => i.actionable && i.status === "open")) return
        let settled = false
        await mutateTask(
            taskId,
            (task) => {
                const patch = {}
                if (task.status === "pr_feedback") patch.status = "pr_open"
                if (
                    task.flags.now &&
                    String(task.flags.now_reason || "").startsWith(
                        FEEDBACK_REASON
                    )
                )
                    patch.flags = { now: false, now_reason: null }
                if (!patch.status && !patch.flags) return null
                settled = true
                return patch
            },
            { reason: "feedback resolved" }
        )
        if (settled)
            await store.appendEvent(
                taskId,
                {
                    type: "feedback_addressed",
                    data: {
                        items: items.filter((i) => i.actionable).length,
                    },
                },
                ACTOR
            )
    }

    // ---- per PR --------------------------------------------------------

    /**
     * Agent-resolved items whose evidence (reply / commit / green check) was
     * still missing when the PR merged or closed: an activity event plus a
     * notification for Leo, once at that transition. No worker prompt.
     */
    async function reportUnverified(taskId, d, unverified, how) {
        // feedback prompts for this PR still waiting in the outbox
        if (workerService && typeof workerService.dropQueued === "function")
            await workerService.dropQueued(taskId, prFeedbackKey(d.pr), {
                pr: d.pr,
                status: how,
            })
        if (!unverified.length) return
        await store.appendEvent(
            taskId,
            {
                type: "feedback_unverified_at_close",
                data: { url: d.pr, pr: how, items: unverified },
            },
            ACTOR
        )
        await notify(
            `T-${taskId}: PR ${how} with unverified feedback`,
            unverified.map((u) => u.item).join(", ")
        )
    }

    /**
     * Append a verification result for `item` only if its latest record is
     * still the one that was verified (rechecked under the store's task
     * lock, which cc_feedback holds while resolving). The saved record, or
     * null when the item changed meanwhile.
     */
    async function writeIfUnchanged(taskId, item, next) {
        const apply = async () => {
            const cur = (await store.listFeedback(taskId)).find(
                (i) => i.id === item.id
            )
            if (!cur || JSON.stringify(cur) !== JSON.stringify(item))
                return null
            return store.appendFeedback(taskId, next, ACTOR)
        }
        return typeof store.withTaskLock === "function"
            ? store.withTaskLock(taskId, apply)
            : apply()
    }

    /**
     * A closed PR was reopened. Closing cancelled its queued feedback
     * prompts (and its round keys now point at cancelled outbox rows), so
     * the PR's open round is sent again under a fresh resume-<pr>-<round>-
     * <ms> key, the task goes back to pr_feedback, and the round is recorded
     * as attempted so the automatic delivery doesn't retry the dead keys.
     * Items this poll's verification just reopened are left out: they get
     * their own reverify prompt (or a flag after a second failure).
     */
    /**
     * Drop the "PR closed without merge" Now flag once `d` is open again,
     * unless another deliverable's PR is still closed unmerged. Other
     * Now reasons are left alone.
     */
    async function clearClosedFlag(taskId, d) {
        const task = await getTask(taskId)
        const otherClosed = (task.deliverables || []).some((x) => {
            if (!x.pr || x.pr === d.pr || x.merged_at) return false
            const ref = parsePrUrl(x.pr)
            const w = ref && st.getWatch.get(x.repo, ref.number)
            return Boolean(w && w.closed_at)
        })
        if (otherClosed) return
        await mutateTask(
            taskId,
            (t) =>
                t.flags.now_reason === CLOSED_REASON
                    ? { flags: { now: false, now_reason: null } }
                    : null,
            { reason: `PR reopened: ${d.pr}` }
        )
    }

    async function resumeReopenedPr(taskId, d, summary, out) {
        await store.appendEvent(
            taskId,
            { type: "pr_reopened", data: { url: d.pr, repo: d.repo } },
            ACTOR
        )
        summary.reopened_prs.push(d.pr)
        await clearClosedFlag(taskId, d)
        const handled = new Set(
            [...out.reopened, ...out.failedTwice].map((i) => i.id)
        )
        const items = (await store.listFeedback(taskId)).filter(
            (i) => !handled.has(i.id)
        )
        const round = currentRound(items, d.pr)
        if (round === null) return
        const list = items.filter(
            (i) =>
                i.pr === d.pr &&
                i.actionable &&
                i.status === "open" &&
                i.round === round
        )
        await mutateTask(
            taskId,
            (task) =>
                task.status === "pr_open" ? { status: "pr_feedback" } : null,
            { reason: `PR reopened with open feedback: ${d.pr}` }
        )
        const stamp = clock.now().getTime()
        const res = await deliverItems(
            taskId,
            list,
            round,
            (pr) => `resume-${prKey(pr)}-${round}-${stamp}`,
            summary
        )
        // unwired: nothing was queued; the next poll's maybeDeliver retries
        if (res.outcome === "unwired") return
        const ids = list.map((i) => i.id)
        // blocked: the prompt waits in the outbox under the resume key
        await store.appendEvent(
            taskId,
            res.outcome === "failed"
                ? {
                      type: ROUND_FAILED_EVENT,
                      data: { round, items: ids, error: res.error },
                  }
                : {
                      type: ROUND_EVENT,
                      data: { round, items: ids, via: "pr_reopened" },
                  },
            ACTOR
        )
        emit("feedback.updated", taskId)
    }

    /**
     * An open PR's head branch is its deliverable's branch: one recorded
     * under another branch (moved by an older branch registration) follows
     * the PR again, and so does the task's branch when it pointed there in
     * the main repo. Feedback and conflict prompts name this branch.
     */
    async function followHead(taskId, d, pr) {
        const head = pr.headRefName
        if (!head || head === d.branch) return
        let from = null
        await mutateTask(
            taskId,
            (task) => {
                const i = (task.deliverables || []).findIndex(
                    (x) => x.pr === d.pr
                )
                const cur = i >= 0 ? task.deliverables[i] : null
                if (!cur || cur.merged_at || cur.branch === head) return null
                from = cur.branch
                const patch = {
                    deliverables: task.deliverables.map((x, j) =>
                        j === i ? { ...x, branch: head } : x
                    ),
                }
                if (task.branch === from && isMainRepo(task, d.repo))
                    patch.branch = head
                return patch
            },
            { reason: `PR head branch ${head} in ${d.repo}` }
        )
        if (from !== null) {
            log.info({ taskId, pr: d.pr, from, head }, "deliverable branch")
            d.branch = head
        }
    }

    async function pollPr(taskId, d, summary, out) {
        const ref = parsePrUrl(d.pr)
        if (!ref) throw new Error(`bad PR url ${d.pr}`)
        // Snapshot before the GitHub reads: an item the agent resolves while
        // they run must not be judged against PR data from before its fix.
        const known = new Map(
            (await store.listFeedback(taskId)).map((i) => [i.id, i])
        )
        let pr = await gh.getPr(d.repo, ref.number)
        const reviewComments = await gh.reviewComments(d.repo, ref.number)
        const watch = st.getWatch.get(d.repo, ref.number)
        let merged = Boolean(pr.mergedAt) || pr.state === "MERGED"
        // state wins when present: a reopened PR may still carry closedAt
        let closed =
            !merged && (pr.state ? pr.state === "CLOSED" : Boolean(pr.closedAt))
        if (!merged && !closed) await followHead(taskId, d, pr)
        if (!merged && !closed) {
            const fresh = extractItems({
                pr,
                reviewComments,
                prUrl: d.pr,
                actionableBots,
            }).filter((i) => !known.has(i.id))
            out.fresh.push(...fresh)
        }

        // verification of agent-resolved items on this PR
        const unverified = [] // merged / closed PR: evidence gaps, reported only
        for (const item of known.values()) {
            if (
                item.pr !== d.pr ||
                !item.actionable ||
                item.verified ||
                !RESOLVED.has(item.status)
            )
                continue
            const v = verifyItem(item, { pr, reviewComments })
            if (v.result === "pending") continue
            if ((merged || closed) && v.result !== "pass") {
                // the PR can't take more commits: never reopen or re-prompt
                unverified.push({ item: item.id, missing: v.missing })
                continue
            }
            if (v.result === "pass") {
                const ok = await writeIfUnchanged(
                    taskId,
                    item,
                    record(item, { verified: true })
                )
                if (!ok) continue
                summary.verified++
                out.feedbackChanged = true
                continue
            }
            const failures = item.verify_failures + 1
            const rec = await writeIfUnchanged(
                taskId,
                item,
                record(item, {
                    status: "open",
                    verified: false,
                    verify_failures: failures,
                })
            )
            // changed since the snapshot (e.g. re-resolved): next poll judges it
            if (!rec) continue
            await store.appendEvent(
                taskId,
                {
                    type: "feedback_verify_failed",
                    data: {
                        item: item.id,
                        status: item.status,
                        missing: v.missing,
                        failures,
                    },
                },
                ACTOR
            )
            out.feedbackChanged = true
            if (failures === 1) out.reopened.push(rec)
            else out.failedTwice.push(rec)
        }

        // after this poll's verification: an item resolved without its
        // evidence (commit, reply) still blocks the merge
        if (!merged && !closed) {
            const items = [
                ...(await store.listFeedback(taskId)),
                ...out.fresh.filter((i) => i.pr === d.pr),
            ]
            if (await autoMerge(taskId, d, pr, items)) {
                // merged now: the usual merged handling follows below
                pr = await gh.getPr(d.repo, ref.number)
                merged = Boolean(pr.mergedAt) || pr.state === "MERGED"
            }
        }
        // a conflict with the base: the agent merges the base in (once per
        // head commit, after this poll's feedback handling)
        if (!merged && !closed && hasConflict(pr)) out.conflicts.push({ d, pr })

        if (merged && !d.merged_at) {
            const at = pr.mergedAt ? new Date(pr.mergedAt).toISOString() : now()
            await mutateTask(
                taskId,
                (task) => ({
                    deliverables: task.deliverables.map((x) =>
                        x.pr === d.pr ? { ...x, merged_at: at } : x
                    ),
                }),
                { reason: `PR merged: ${d.pr}` }
            )
            await store.appendEvent(
                taskId,
                { type: "pr_merged", data: { url: d.pr, repo: d.repo } },
                ACTOR
            )
            const task = await getTask(taskId)
            await asanaComment(task.asana && task.asana.gid, `Merged: ${d.pr}`)
            summary.merged.push(d.pr)
            await reportUnverified(taskId, d, unverified, "merged")
        } else if (closed && !(watch && watch.closed_at)) {
            await flagNow(taskId, CLOSED_REASON)
            await store.appendEvent(
                taskId,
                { type: "pr_closed", data: { url: d.pr, repo: d.repo } },
                ACTOR
            )
            await notify(
                `T-${taskId}: PR closed without merge`,
                `${d.repo}#${ref.number}`
            )
            summary.closed.push(d.pr)
            await reportUnverified(taskId, d, unverified, "closed")
        } else if (!merged && !closed && watch && watch.closed_at) {
            await resumeReopenedPr(taskId, d, summary, out)
        }

        st.pollWatch.run({
            task_id: taskId,
            repo: d.repo,
            number: ref.number,
            url: d.pr,
            state: pr.state || null,
            head_sha: pr.headRefOid || null,
            merged_at: pr.mergedAt || null,
            // only while closed: a reopened PR clears it (resume detection)
            closed_at: closed ? pr.closedAt || now() : null,
            ci_state: ciStateOf(pr.statusCheckRollup || []),
            last_comment_at: maxIso([
                ...reviewComments.map((c) => c.created_at),
                ...(pr.comments || []).map((c) => c.createdAt),
            ]),
            last_review_at: maxIso(
                (pr.reviews || []).map((r) => r.submittedAt)
            ),
            last_checked_at: now(),
        })
    }

    // ---- auto-merge ----------------------------------------------------

    function autoMergeOn() {
        try {
            return settingsRepo
                ? settingsRepo.get(AUTO_MERGE_SETTING, true) !== false
                : true
        } catch {
            return true
        }
    }

    /**
     * Merge a task PR GitHub lets us merge (merge commit, only its current
     * head) unless actionable feedback on it is not settled (open, new in
     * this poll, or resolved but not verified yet) or the task's agent is
     * at work. True when merged.
     */
    async function autoMerge(taskId, d, pr, items) {
        if (!autoMergeOn() || !mergeReady(pr)) return false
        const open = items.some(
            (i) =>
                i.pr === d.pr &&
                i.actionable &&
                !i.verified &&
                (i.status || "open") !== "no_action"
        )
        if (open) return false
        const head = pr.headRefOid || null
        const number = parsePrUrl(d.pr).number
        const merge = () =>
            gh.mergePr(d.repo, number, { method: "merge", headSha: head })
        try {
            // on the task's worker chain, only while the agent is not at
            // work (nothing queued, sent, starting or working; unknown is
            // busy): no prompt or revive can start mid-merge
            if (workerService && workerService.runWhenIdle) {
                const r = await workerService.runWhenIdle(taskId, merge)
                if (!r.ran) return false
            } else await merge()
        } catch (err) {
            if (mergeFailedHead.get(d.pr) !== head) {
                mergeFailedHead.set(d.pr, head)
                await store.appendEvent(
                    taskId,
                    {
                        type: "pr_auto_merge_failed",
                        data: { url: d.pr, head, error: err.message },
                    },
                    ACTOR
                )
            }
            log.warn({ err: err.message, pr: d.pr }, "auto-merge failed")
            return false
        }
        mergeFailedHead.delete(d.pr)
        await store.appendEvent(
            taskId,
            { type: "pr_auto_merged", data: { url: d.pr, head } },
            ACTOR
        )
        return true
    }

    // ---- close ---------------------------------------------------------

    async function checkClose(taskId, summary) {
        let task = await getTask(taskId)
        if (
            !(
                POLLED_STATUSES.includes(task.status) ||
                task.status === REVIEW_STATUS
            ) ||
            !task.deliverables.length ||
            openDeliverables(task).length
        )
            return
        // fresh discovery pass right before evaluating the close condition
        await discover(task, summary)
        task = await getTask(taskId)
        if (
            openDeliverables(task).length ||
            !canTransition(task.status, "done")
        )
            return
        if (await waitForChangeRecord(task, summary)) return
        if (await waitForManual(task, summary)) return
        // enqueueCloseOut dedupes against a queued/running/parked close_out;
        // after a failed job the next poll retries.
        const { existing } = enqueueCloseOut(jobRunner, taskId)
        if (!existing)
            await store.appendEvent(
                taskId,
                { type: "close_out_requested", data: { by: "pr_watcher" } },
                ACTOR
            )
        summary.close_out = true
    }

    /**
     * A SOC2-area task can't close without a complete change record, and
     * nothing the close-out does fills it: don't queue a job that fails on
     * every poll. Leo is told (Now flag, notification, close_out_waiting
     * event) once per set of missing labels; once the record is filled the
     * next poll closes out. True while waiting.
     */
    async function waitForChangeRecord(task, summary) {
        const record = changeRecordState(task, await store.getArtifact(task.id))
        if (!record || !record.missing.length) return false
        summary.change_record_missing = record.missing
        const last = (await store.listEvents(task.id, { limit: 200 })).find(
            (e) => e.type === "close_out_waiting"
        )
        const missing = record.missing.join(",")
        if (last && (last.data && last.data.missing) === missing) return true
        await store.appendEvent(
            task.id,
            { type: "close_out_waiting", data: { missing } },
            ACTOR
        )
        await flagNow(task.id, RECORD_REASON)
        await notify(
            `T-${task.id}: ${RECORD_REASON}`,
            `All PRs are merged. Fill ${record.missing.join(", ")} in "${record.section}" to close it out.`
        )
        return true
    }

    /**
     * Every PR is merged but manual deliverables are not checked off: no
     * close-out yet. Leo is told (Now flag, notification,
     * close_out_waiting_manual event) once per set of open ones; checking
     * the last one re-runs the poll, which closes out. True while waiting.
     */
    async function waitForManual(task, summary) {
        const open = openManual(task)
        if (!open.length) return false
        const items = open.map((m) => m.id).join(",")
        summary.manual_open = open.map((m) => m.id)
        const last = (await store.listEvents(task.id, { limit: 200 })).find(
            (e) => e.type === "close_out_waiting_manual"
        )
        if (last && (last.data && last.data.items) === items) return true
        await store.appendEvent(
            task.id,
            { type: "close_out_waiting_manual", data: { items } },
            ACTOR
        )
        await flagNow(task.id, MANUAL_REASON)
        await notify(
            `T-${task.id}: ${MANUAL_REASON}`,
            `All PRs are merged. Check off: ${open.map((m) => m.text).join("; ")}`
        )
        return true
    }

    // ---- poll ----------------------------------------------------------

    async function pollTaskInner(taskId) {
        const summary = {
            task_id: taskId,
            claimed: [],
            new_items: 0,
            actionable: 0,
            verified: 0,
            reopened: 0,
            flagged: 0,
            merged: [],
            closed: [],
            reopened_prs: [],
            delivered_round: null,
            conflicts: [],
            close_out: false,
            errors: [],
        }
        let task
        try {
            task = await getTask(taskId)
        } catch (err) {
            return { ...summary, error: err.message }
        }
        if (!isWatched(task))
            return { ...summary, skipped: `status ${task.status}` }
        const out = {
            fresh: [],
            reopened: [],
            failedTwice: [],
            conflicts: [],
            feedbackChanged: false,
        }
        try {
            await discover(task, summary)
            task = await getTask(taskId)
            for (const d of task.deliverables) {
                if (d.disposition !== "pr" || !d.pr || d.merged_at) continue
                try {
                    await pollPr(taskId, d, summary, out)
                } catch (err) {
                    log.warn({ err: err.message, taskId, pr: d.pr }, "poll PR")
                    summary.errors.push(`${d.pr}: ${err.message}`)
                }
            }

            if (out.fresh.length) {
                summary.new_items = out.fresh.length
                await recordItems(taskId, out.fresh)
                out.feedbackChanged = true
                const actionable = out.fresh.filter((i) => i.actionable)
                summary.actionable = actionable.length
                if (actionable.length) {
                    const reason = `${FEEDBACK_REASON}: ${actionable.length} new item(s)`
                    await flagNow(taskId, reason, "pr_feedback")
                    await notify(`T-${taskId}: ${reason}`, task.title)
                }
            }

            if (out.reopened.length) {
                summary.reopened = out.reopened.length
                await flagNow(
                    taskId,
                    `${FEEDBACK_REASON}: verification failed, reopened`,
                    "pr_feedback"
                )
                const byRound = new Map()
                for (const it of out.reopened) {
                    if (!byRound.has(it.round)) byRound.set(it.round, [])
                    byRound.get(it.round).push(it)
                }
                for (const [round, list] of byRound)
                    await deliverItems(
                        taskId,
                        list,
                        round,
                        (pr, l) =>
                            `reverify-${prKey(pr)}-${l.map((i) => i.id).join("+")}`,
                        summary
                    )
            }
            if (out.failedTwice.length) {
                summary.flagged = out.failedTwice.length
                // reopened items are open feedback again: pr_feedback (so
                // "Address feedback" is offered), but no automatic re-prompt
                await flagNow(
                    taskId,
                    `${FEEDBACK_REASON}: verification failed twice (${out.failedTwice
                        .map((i) => i.id)
                        .join(", ")})`,
                    "pr_feedback"
                )
                await notify(
                    `T-${taskId}: feedback verification failed twice`,
                    out.failedTwice.map((i) => i.id).join(", ")
                )
            }

            await settleStatus(taskId)
            await maybeDeliver(taskId, summary)
            await deliverConflicts(taskId, out.conflicts, summary)
            await checkClose(taskId, summary)
            if (summary.errors.length)
                await setError(taskId, summary.errors.join("; ").slice(0, 300))
            else await clearError(taskId)
        } catch (err) {
            log.warn({ err: err.message, taskId }, "PR poll failed")
            summary.error = err.message
            await setError(taskId, err.message)
        }
        if (out.feedbackChanged) emit("feedback.updated", taskId)
        emit("pr.updated", taskId)
        return summary
    }

    function pollTask(taskId) {
        const id = Number(taskId)
        if (inflight.has(id)) return inflight.get(id)
        const p = serial(id, () => pollTaskInner(id)).finally(() =>
            inflight.delete(id)
        )
        inflight.set(id, p)
        return p
    }

    function pollAll() {
        if (pollAllRun) return pollAllRun
        pollAllRun = (async () => {
            const results = []
            let tasks = []
            try {
                // review and other open tasks are polled only with a
                // claimed PR (pollTask skips the others)
                const res = await store.query({
                    status: [
                        ...POLLED_STATUSES,
                        REVIEW_STATUS,
                        ...OPEN_PR_STATUSES,
                    ],
                    limit: 1000,
                })
                tasks = res.tasks || []
            } catch (err) {
                log.warn({ err: err.message }, "PR watcher: task query failed")
                return { polled: 0, errors: 1, results, error: err.message }
            }
            let errors = 0
            for (const t of tasks) {
                if (stopping) break // shutting down: finish the current task only
                try {
                    const r = await pollTask(t.id)
                    // not watched (e.g. an active task without an open PR)
                    if (r.skipped) continue
                    if (r.error || (r.errors && r.errors.length)) errors++
                    results.push(r)
                } catch (err) {
                    errors++
                    results.push({ task_id: t.id, error: err.message })
                }
            }
            return { polled: results.length, errors, results }
        })().finally(() => {
            pollAllRun = null
        })
        return pollAllRun
    }

    // ---- timer ---------------------------------------------------------

    function intervalMs() {
        let minutes = pollMinutes
        try {
            const v = Number(
                settingsRepo
                    ? settingsRepo.get("github.poll_minutes", pollMinutes)
                    : pollMinutes
            )
            if (Number.isFinite(v) && v >= 1) minutes = v
        } catch (err) {
            log.warn({ err: err.message }, "poll_minutes setting unreadable")
        }
        return minutes * 60000
    }

    async function tick() {
        timer = null
        try {
            await pollAll()
        } catch (err) {
            log.warn({ err: err.message }, "PR watcher cycle failed")
        }
        if (running) timer = clock.setTimeout(tick, intervalMs())
    }

    function start() {
        if (running) return
        running = true
        stopping = false
        timer = clock.setTimeout(tick, startDelayMs)
    }

    /**
     * Stop the timer and wait for work in progress: the current poll cycle
     * (it stops after the task it is on) and every queued per-task operation
     * (claims, feedback, round delivery), so nothing writes to the store or
     * calls the worker service after stop() resolves.
     */
    async function stop() {
        running = false
        stopping = true
        if (timer) clock.clearTimeout(timer)
        timer = null
        while (pollAllRun || queues.size) {
            await Promise.allSettled(
                [pollAllRun, ...queues.values()].filter(Boolean)
            )
        }
    }

    // ---- public operations ---------------------------------------------

    /**
     * Claim a PR URL for a task. manual: Leo's claim, no PR checks.
     * reported: the task's agent named the PR (cc_add_link), checkReported.
     * Otherwise the full discovery checks (checkCandidate).
     * The PR fills the repo's pending deliverable or, when every
     * deliverable of the repo already has its PR, is added as a deliverable
     * of its own (a follow-up PR). Not on a done or cancelled task: nothing
     * would watch the PR there.
     */
    function claim(
        taskId,
        url,
        { manual = false, reported = false, actor } = {}
    ) {
        const id = Number(taskId)
        const who = actor || (manual ? "me" : ACTOR)
        return serial(id, async () => {
            const ref = parsePrUrl(url)
            if (!ref) return { ok: false, reason: "invalid_url" }
            if (!same(ref.owner, org))
                return { ok: false, reason: "foreign_repo" }
            const task = await getTask(id)
            const slot = slotFor(task.deliverables, ref.repo, ref.url)
            if (slot.reason === "no_deliverable")
                return { ok: false, reason: slot.reason }
            const existing = claims.claimOf(ref.url)
            if (existing && existing.task_id !== id)
                return { ok: false, reason: "claimed_by_other_task" }
            if (slot.existing)
                return {
                    ok: true,
                    deliverable: task.deliverables[slot.index],
                    existing: true,
                }
            if (slot.reason) return { ok: false, reason: slot.reason }
            const refusal = statusRefusal(task, slot)
            if (refusal) return { ok: false, reason: refusal }
            // the deliverable it fills, or the repo's current one for a
            // follow-up PR (its branch and start for the checks)
            const d =
                slot.index >= 0
                    ? task.deliverables[slot.index]
                    : currentDeliverable(task.deliverables, ref.repo, same) ||
                      latestDeliverable(task.deliverables, ref.repo, same)
            let pr
            try {
                pr = await gh.getPr(d.repo, ref.number)
            } catch (err) {
                return {
                    ok: false,
                    reason: "pr_unavailable",
                    message: err.message,
                }
            }
            if (!manual) {
                const check = (reported ? checkReported : checkCandidate)({
                    task,
                    deliverable: d,
                    pr,
                    claims,
                    org,
                })
                if (!check.ok) {
                    const list = (
                        (candidateMap.get(id) || new Map()).get(d.repo) || []
                    ).filter((c) => c.url !== pr.url)
                    list.push({
                        repo: d.repo,
                        url: pr.url,
                        number: pr.number,
                        reason: check.reason,
                    })
                    setCandidates(id, d.repo, list)
                    return check
                }
            }
            return applyClaim(id, d.repo, pr, {
                manual,
                actor: who,
                expected:
                    slot.index >= 0
                        ? { branch: d.branch, created_at: d.created_at }
                        : "append",
            })
        })
    }

    /**
     * Take a PR off a task (it belongs elsewhere, or was registered by
     * mistake). Its deliverable goes back to pending, or is removed when it
     * was a follow-up of its own (the repo has other deliverables); its PR
     * link, claim and watch row go; its open feedback items become
     * no_action (nothing watches the PR any more). With no open PR left, a
     * task in pr_open / pr_feedback goes back to active. A merged PR stays
     * (history), and nothing changes on a done or cancelled task.
     * @returns {Promise<{ ok: true, deliverable: object|null }
     *   | { ok: false, reason: string }>} deliverable: the pending one the
     *   PR left, or null when its deliverable was removed
     */
    function unclaim(taskId, url, { actor } = {}) {
        const id = Number(taskId)
        const who = actor || ACTOR
        return serial(id, async () => {
            const ref = parsePrUrl(url)
            if (!ref) return { ok: false, reason: "invalid_url" }
            // the branches its claim moved onto the PR's head (newest claim)
            const claimed = (
                await store.listEvents(id, { limit: 100000 })
            ).find(
                (e) =>
                    e.type === "pr_claimed" &&
                    same(e.data && e.data.url, ref.url)
            )
            const from = (claimed && claimed.data) || {}
            const refused = { reason: null }
            let removed = null
            let left = null
            try {
                await mutateTask(
                    id,
                    (task) => {
                        const refuse = (reason) => {
                            refused.reason = reason
                            throw refused
                        }
                        if (CLOSED_STATUSES.includes(task.status))
                            refuse("task_closed")
                        const dl = task.deliverables || []
                        const i = dl.findIndex((d) => same(d.pr, ref.url))
                        if (i < 0) refuse("not_on_task")
                        removed = dl[i]
                        if (removed.merged_at) refuse("merged")
                        // removed only when its claim added it (a
                        // follow-up PR); a deliverable that was there before
                        // waits for a PR again. Claims from before this was
                        // recorded: removed when the repo has others.
                        const appended =
                            typeof from.appended === "boolean"
                                ? from.appended
                                : dl.some(
                                      (d, j) =>
                                          j !== i && same(d.repo, removed.repo)
                                  )
                        const deliverables = appended
                            ? dl.filter((_, j) => j !== i)
                            : dl.map((d, j) =>
                                  j === i
                                      ? (left = {
                                            ...d,
                                            // back to the branch it had
                                            // before the claim moved it
                                            ...(from.branch_from
                                                ? { branch: from.branch_from }
                                                : {}),
                                            disposition: "pending",
                                            pr: null,
                                            claimed_at: null,
                                            merged_at: null,
                                        })
                                      : d
                              )
                        const patch = {
                            deliverables,
                            links: (task.links || []).filter(
                                (l) =>
                                    !(
                                        l.type === "pr" &&
                                        same(l.url, removed.pr)
                                    )
                            ),
                        }
                        // the task's branch, if the claim moved it and it
                        // is still the PR's head
                        if (
                            from.task_branch_from &&
                            task.branch === removed.branch
                        )
                            patch.branch = from.task_branch_from
                        const openPr = deliverables.some(
                            (d) => d.pr && !d.merged_at
                        )
                        if (
                            !openPr &&
                            (task.status === "pr_open" ||
                                task.status === "pr_feedback") &&
                            canTransition(task.status, "active")
                        )
                            patch.status = "active"
                        return patch
                    },
                    { actor: who, reason: `PR removed: ${ref.url}` }
                )
            } catch (err) {
                if (err !== refused) throw err
                return { ok: false, reason: refused.reason }
            }
            const prUrl = removed.pr
            const held = claims.claimOf(prUrl)
            if (held && held.task_id === id) claims.release(prUrl)
            st.delWatch.run(id, removed.repo, ref.number)
            conflictHead.delete(prUrl)
            mergeFailedHead.delete(prUrl)
            for (const item of (await store.listFeedback(id)) || []) {
                if (!same(item.pr, prUrl) || item.status !== "open") continue
                // eslint-disable-next-line no-unused-vars
                const { at, ...rest } = item
                await store.appendFeedback(
                    id,
                    {
                        ...rest,
                        status: "no_action",
                        note: "PR removed from the task",
                    },
                    who
                )
            }
            await store.appendEvent(
                id,
                {
                    type: "pr_unclaimed",
                    data: { url: prUrl, repo: removed.repo },
                },
                who
            )
            emit("pr.updated", id)
            emit("feedback.updated", id)
            return { ok: true, deliverable: left }
        })
    }

    /**
     * Leo marks a deliverable as needing no change. createdAt: the one he
     * clicked (a repo can have several over time; its creation time is set
     * once, a branch can come back): only that pending one, else 409
     * deliverable_changed; without it, the repo's current one.
     */
    async function setNoChange(taskId, repo, createdAt = null) {
        const id = Number(taskId)
        const res = await serial(id, async () => {
            const task = await mutateTask(
                id,
                (t) => {
                    const ofRepo = t.deliverables.filter((x) =>
                        same(x.repo, repo)
                    )
                    if (!ofRepo.length)
                        throw new NotFoundError(
                            `deliverable ${repo} on T-${id}`
                        )
                    let d
                    if (createdAt) {
                        // the one clicked: pending (or already no change)
                        d = ofRepo.find(
                            (x) =>
                                x.created_at === createdAt &&
                                x.disposition !== "pr"
                        )
                        // it got a PR or moved meanwhile: not another one
                        if (!d)
                            throw new AppError(
                                "deliverable_changed",
                                `${repo} on T-${id}: the deliverable started ${createdAt} is not pending any more`,
                                { status: 409 }
                            )
                    } else
                        d =
                            currentDeliverable(ofRepo, repo, same) ||
                            latestDeliverable(ofRepo, repo, same)
                    if (d.disposition === "no_change") return null
                    // a PR was claimed meanwhile (e.g. a stale No change
                    // click): don't drop it, or close-out skips its merge
                    if (d.disposition !== "pending")
                        throw new AppError(
                            "invalid_state",
                            `${repo} on T-${id} already has a PR (${d.pr || d.disposition})`,
                            { status: 409 }
                        )
                    return {
                        deliverables: t.deliverables.map((x) =>
                            x === d ? { ...x, disposition: "no_change" } : x
                        ),
                    }
                },
                { actor: "me", reason: `${repo}: no change` }
            )
            await store.appendEvent(
                id,
                { type: "deliverable_no_change", data: { repo } },
                "me"
            )
            const forRepo = candidateMap.get(id)
            if (forRepo) forRepo.delete(repo)
            return { task }
        })
        emit("pr.updated", id)
        // re-evaluate the close condition soon, off the request path
        clock.setTimeout(() => {
            pollTask(id).catch((err) =>
                log.warn({ err: err.message, id }, "poll after no_change")
            )
        }, 0)
        return res
    }

    // ---- manual deliverables (Leo's checklist) --------------------------

    /** A done or cancelled task takes no manual deliverable changes. */
    function refuseClosed(task) {
        if (CLOSED_STATUSES.includes(task.status))
            throw new AppError(
                "invalid_state",
                `T-${task.id} is ${task.status}`,
                { status: 409 }
            )
    }

    /**
     * Patch for manual deliverables `list`: the "waiting on manual" Now flag
     * goes once none is open.
     */
    function manualPatch(task, list) {
        const patch = { manual_deliverables: list }
        if (
            !list.some((m) => !m.done_at) &&
            task.flags &&
            task.flags.now_reason === MANUAL_REASON
        )
            patch.flags = { now: false, now_reason: null }
        return patch
    }

    /** Re-evaluate the close condition soon, off the request path. */
    function pollSoon(id, why) {
        clock.setTimeout(() => {
            pollTask(id).catch((err) =>
                log.warn({ err: err.message, id }, `poll after ${why}`)
            )
        }, 0)
    }

    /** Leo adds a manual deliverable (e.g. "install on the farm"). */
    async function addManual(taskId, text) {
        const id = Number(taskId)
        const item = {
            id: `m${crypto.randomBytes(4).toString("hex")}`,
            text,
            created_at: now(),
            done_at: null,
        }
        const task = await serial(id, () =>
            mutateTask(
                id,
                (t) => {
                    refuseClosed(t)
                    return manualPatch(t, [
                        ...(t.manual_deliverables || []),
                        item,
                    ])
                },
                { actor: "me", reason: `manual deliverable: ${text}` }
            )
        )
        emit("pr.updated", id)
        return { task, item }
    }

    /**
     * Leo checks a manual deliverable off (done) or back on. The last one
     * checked lets the next poll close the task out.
     */
    async function setManual(taskId, itemId, done) {
        const id = Number(taskId)
        let text = null
        const task = await serial(id, () =>
            mutateTask(
                id,
                (t) => {
                    refuseClosed(t)
                    const list = t.manual_deliverables || []
                    const m = list.find((x) => x.id === itemId)
                    if (!m)
                        throw new NotFoundError(
                            `manual deliverable ${itemId} on T-${id}`
                        )
                    text = m.text
                    if (Boolean(m.done_at) === done) return null
                    return manualPatch(
                        t,
                        list.map((x) =>
                            x === m ? { ...x, done_at: done ? now() : null } : x
                        )
                    )
                },
                {
                    actor: "me",
                    reason: `manual deliverable ${done ? "done" : "not done"}: ${itemId}`,
                }
            )
        )
        emit("pr.updated", id)
        if (done) pollSoon(id, "manual deliverable done")
        return { task, text }
    }

    /** Leo removes a manual deliverable (no longer needed). */
    async function removeManual(taskId, itemId) {
        const id = Number(taskId)
        const task = await serial(id, () =>
            mutateTask(
                id,
                (t) => {
                    refuseClosed(t)
                    const list = t.manual_deliverables || []
                    if (!list.some((x) => x.id === itemId))
                        throw new NotFoundError(
                            `manual deliverable ${itemId} on T-${id}`
                        )
                    return manualPatch(
                        t,
                        list.filter((x) => x.id !== itemId)
                    )
                },
                { actor: "me", reason: `manual deliverable removed: ${itemId}` }
            )
        )
        emit("pr.updated", id)
        pollSoon(id, "manual deliverable removed")
        return { task }
    }

    /** Leo flips a no_action item back to open. */
    function reopenItem(taskId, itemId) {
        const id = Number(taskId)
        return serial(id, async () => {
            const items = await store.listFeedback(id)
            const item = items.find((i) => i.id === itemId)
            if (!item) throw new NotFoundError(`feedback item ${itemId}`)
            if (item.status !== "no_action")
                throw new AppError(
                    "invalid_state",
                    `${itemId} is ${item.status}; only no_action items can be reopened`,
                    { status: 409 }
                )
            const rec = await store.appendFeedback(
                id,
                record(item, {
                    status: "open",
                    actionable: true,
                    verified: false,
                }),
                "me"
            )
            await store.appendEvent(
                id,
                { type: "feedback_reopened", data: { item: itemId } },
                "me"
            )
            const summary = { errors: [] }
            const task = await getTask(id)
            // a merged / closed PR takes no more commits: reopening records
            // Leo's call but sends the worker nothing
            const finished = (await finishedPrs(id)).has(rec.pr)
            if (!finished && ["pr_open", "pr_feedback"].includes(task.status)) {
                // this PR's prompt for the round is frozen (sent, failed or
                // persisted while blocked) without the item: send it on its
                // own. Otherwise the PR's own round queue picks it up.
                const frozen = await prRoundsWith(id, [
                    ROUND_EVENT,
                    ROUND_FAILED_EVENT,
                    ROUND_SEALED_EVENT,
                ])
                if (covers(frozen, rec.pr, rec.round)) {
                    await deliverItems(
                        id,
                        [rec],
                        rec.round,
                        (pr) =>
                            `reopen-${prKey(pr)}-${rec.id}-${clock.now().getTime()}`,
                        summary
                    )
                    await mutateTask(id, (t) =>
                        t.status === "pr_open"
                            ? { status: "pr_feedback" }
                            : null
                    )
                } else {
                    await maybeDeliver(id, summary)
                }
            }
            emit("feedback.updated", id)
            return { item: rec, errors: summary.errors }
        })
    }

    /** cc_feedback resolved every item of a round: settle + next round. */
    function roundResolved(taskId) {
        const id = Number(taskId)
        return serial(id, async () => {
            const summary = { errors: [], delivered_round: null }
            await settleStatus(id)
            await maybeDeliver(id, summary)
            emit("pr.updated", id)
            const task = await getTask(id)
            return {
                status: task.status,
                delivered_round: summary.delivered_round,
                errors: summary.errors,
            }
        })
    }

    /** Unclaimed PRs seen on the task's branches (last discovery). */
    function candidates(taskId) {
        const id = Number(taskId)
        const forTask = candidateMap.get(id)
        if (!forTask) return []
        return [...forTask.values()]
            .flat()
            .filter((c) => {
                const owner = claims.claimOf(c.url)
                return !owner || owner.task_id !== id
            })
            .map((c) => ({ ...c }))
    }

    /** pr_watch rows of the task. */
    function prs(taskId) {
        return st.byTask.all(Number(taskId))
    }

    return {
        start,
        addressFeedback,
        stop,
        pollTask,
        pollAll,
        claim,
        unclaim,
        ownsBranch,
        setNoChange,
        addManual,
        setManual,
        removeManual,
        reopenItem,
        roundResolved,
        candidates,
        prs,
    }
}
