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
//     still open; otherwise they start a new round that is delivered now
//  4. close condition (fresh discovery, then enqueueCloseOut)
//
// Every operation on one task runs through a per-task queue, so a poll, a
// claim and roundResolved never interleave; task.json updates additionally
// take store.withTaskLock. Errors are per task and never stop pollAll.

import crypto from "node:crypto"
import { canTransition, openDeliverables } from "../contracts/lifecycle.js"
import { enqueueCloseOut as defaultEnqueueCloseOut } from "../agent/jobs/close_out.js"
import { currentRound, feedbackDedupeKey } from "../contracts/feedback.js"
import { AppError, NotFoundError } from "../util/errors.js"
import { systemClock } from "../util/clock.js"
import { nullLogger } from "../util/logger.js"
import { checkCandidate, checkReported, parsePrUrl } from "./claims.js"

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
const ROUND_EVENT = "feedback_round_delivered"
const ROUND_FAILED_EVENT = "feedback_round_failed"
const ROUND_SEALED_EVENT = "feedback_round_sealed"
const DELIVERED = new Set(["sent", "queued"])
const BLOCKED_REASON = "Agent blocked — feedback waiting"
const FEEDBACK_REASON = "PR feedback"
const WATCHER_ERROR = "PR watcher:"
const ACTOR = "system"

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
    enqueueCloseOut = defaultEnqueueCloseOut,
    pollMinutes = 15,
    startDelayMs = 5000,
    actionableBots = [],
}) {
    const now = () => clock.now().toISOString()
    const queues = new Map()
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
            `^(?:round-${k}-\\d+|(?:manual|resume)-${k}-\\d+-\\d+|reverify-${k}-[a-z].*|reopen-${k}-[a-z].*-\\d+)$`
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

    /** True when this task holds a PR claim in repo whose head is branch. */
    function ownsBranch(taskId, repo, branch) {
        return claims
            .claimsForTask(Number(taskId))
            .some((c) => same(c.repo, repo) && c.branch === branch)
    }

    /** Record a claim: pr_claims, deliverable, link, status, pr_watch. */
    async function applyClaim(taskId, repo, pr, { manual, actor }) {
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
        await mutateTask(
            taskId,
            (task) => {
                gid = task.asana && task.asana.gid
                // A claimed PR on another branch (an agent working on an
                // existing PR, or Leo's manual claim) moves the deliverable
                // onto the PR's head branch: that is the branch pushed.
                const head = pr.headRefName || null
                let movedFrom = null
                const deliverables = task.deliverables.map((d) =>
                    same(d.repo, repo)
                        ? (deliverable = {
                              ...d,
                              ...(head && head !== d.branch
                                  ? ((movedFrom = d.branch), { branch: head })
                                  : {}),
                              disposition: "pr",
                              pr: pr.url,
                              claimed_at: at,
                              // claimed after it merged (e.g. Leo attached
                              // a PR from another branch): merged now
                              ...(mergedAt ? { merged_at: mergedAt } : {}),
                          })
                        : d
                )
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
                if (
                    movedFrom &&
                    task.branch === movedFrom &&
                    isMainRepo(task, repo)
                )
                    patch.branch = head
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
        await store.appendEvent(
            taskId,
            {
                type: "pr_claimed",
                data: { url: pr.url, repo, number: pr.number, manual },
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

    /** Discovery + claim for every pending deliverable. */
    async function discover(task, summary) {
        for (const d of task.deliverables) {
            if (d.disposition !== "pending") continue
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
                if (!claimed) {
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
     * Rounds whose prompt reached a final outcome: delivered (sent/queued)
     * or failed (failed/uncertain, never auto-resent). Either way the round
     * is "in progress" until its items are resolved.
     */
    const attemptedRounds = (taskId) =>
        roundsWith(taskId, [ROUND_EVENT, ROUND_FAILED_EVENT])

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

    /** The task's current round: the oldest open round over its PRs. */
    function oldestOpenRound(items) {
        const open = items.filter((i) => i.actionable && i.status === "open")
        const rounds = [...new Set(open.map((i) => i.pr))]
            .map((pr) => currentRound(items, pr))
            .sort((a, b) => a - b)
        return rounds.length ? rounds[0] : null
    }

    /**
     * Seal `round` (its items are frozen once its prompt is persisted) and
     * deliver it under the round dedupe keys; records delivered / failed.
     * @returns {Promise<{ outcome, error? }>}
     */
    async function deliverRound(taskId, round, list, summary) {
        if (workerService && feedbackPrompt) {
            const sealed = await sealedRounds(taskId)
            if (!sealed.has(round))
                await store.appendEvent(
                    taskId,
                    {
                        type: ROUND_SEALED_EVENT,
                        data: { round, items: list.map((i) => i.id) },
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

    /** Deliver the oldest queued round unless an attempted one is open. */
    async function maybeDeliver(taskId, summary) {
        const items = await liveFeedback(taskId)
        const attempted = await attemptedRounds(taskId)
        const open = items.filter((i) => i.actionable && i.status === "open")
        if (open.some((i) => attempted.has(i.round))) return null
        // per PR the current round is its oldest open one (shared helper, so
        // the worker service's "Address feedback" agrees); rounds are per
        // task, so the task's current round is the oldest of those
        const round = oldestOpenRound(items)
        if (round === null) return null
        const list = open.filter((i) => i.round === round)
        const res = await deliverRound(taskId, round, list, summary)
        if (res.outcome !== "delivered") return null
        summary.delivered_round = round
        return round
    }

    /**
     * Leo's "Address feedback" click. Goes through the same round queue as
     * the automatic delivery: the oldest open round only (later rounds keep
     * waiting), sealed before its prompt is persisted. A round that was
     * already sent (or failed) is sent again under a fresh key, because the
     * click is an explicit request.
     * @returns {Promise<{ round, resent, delivery: { status, error? } }>}
     */
    function addressFeedback(taskId) {
        const id = Number(taskId)
        return serial(id, async () => {
            const summary = { errors: [] }
            const items = await liveFeedback(id)
            const round = oldestOpenRound(items)
            if (round === null)
                throw new AppError(
                    "no_open_feedback",
                    `T-${id} has no open feedback`,
                    { status: 409 }
                )
            const list = items.filter(
                (i) => i.actionable && i.status === "open" && i.round === round
            )
            const attempted = await attemptedRounds(id)
            let res
            let resent = false
            if (!attempted.has(round)) {
                res = await deliverRound(id, round, list, summary)
            } else {
                resent = true
                const stamp = clock.now().getTime()
                res = await deliverItems(
                    id,
                    list,
                    round,
                    (pr) => `manual-${prKey(pr)}-${round}-${stamp}`,
                    summary
                )
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
            const status =
                res.outcome === "delivered"
                    ? "queued"
                    : res.outcome === "unwired"
                      ? "failed"
                      : res.outcome
            return {
                round,
                resent,
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

    async function pollPr(taskId, d, summary, out) {
        const ref = parsePrUrl(d.pr)
        if (!ref) throw new Error(`bad PR url ${d.pr}`)
        // Snapshot before the GitHub reads: an item the agent resolves while
        // they run must not be judged against PR data from before its fix.
        const known = new Map(
            (await store.listFeedback(taskId)).map((i) => [i.id, i])
        )
        const pr = await gh.getPr(d.repo, ref.number)
        const reviewComments = await gh.reviewComments(d.repo, ref.number)
        const watch = st.getWatch.get(d.repo, ref.number)
        const merged = Boolean(pr.mergedAt) || pr.state === "MERGED"
        // state wins when present: a reopened PR may still carry closedAt
        const closed =
            !merged && (pr.state ? pr.state === "CLOSED" : Boolean(pr.closedAt))

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
        // enqueueCloseOut dedupes against a queued/running/parked close_out;
        // after a failed job (e.g. SOC2 record missing) the next poll retries.
        const { existing } = enqueueCloseOut(jobRunner, taskId)
        if (!existing)
            await store.appendEvent(
                taskId,
                { type: "close_out_requested", data: { by: "pr_watcher" } },
                ACTOR
            )
        summary.close_out = true
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
            const d = task.deliverables.find((x) => same(x.repo, ref.repo))
            if (!d) return { ok: false, reason: "no_deliverable" }
            const existing = claims.claimOf(ref.url)
            if (existing && existing.task_id !== id)
                return { ok: false, reason: "claimed_by_other_task" }
            if (d.disposition === "pr" && d.pr === ref.url)
                return { ok: true, deliverable: d, existing: true }
            if (d.disposition !== "pending")
                return {
                    ok: false,
                    reason:
                        d.disposition === "pr"
                            ? "deliverable_has_pr"
                            : "deliverable_no_change",
                }
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
            return applyClaim(id, d.repo, pr, { manual, actor: who })
        })
    }

    /** Leo marks a deliverable as needing no change. */
    async function setNoChange(taskId, repo) {
        const id = Number(taskId)
        const res = await serial(id, async () => {
            const task = await mutateTask(
                id,
                (t) => {
                    const d = t.deliverables.find((x) => same(x.repo, repo))
                    if (!d)
                        throw new NotFoundError(
                            `deliverable ${repo} on T-${id}`
                        )
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
                const delivered = await sealedRounds(id)
                if (delivered.has(rec.round)) {
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
        ownsBranch,
        setNoChange,
        reopenItem,
        roundResolved,
        candidates,
        prs,
    }
}
