/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// PR reviews (docs/09-pr-reviews.md): scans tracked repos (spread over the
// poll period), keeps other developers' PRs and our decisions on them, and
// runs review agents in herdr: a queue with at most `reviews.parallel`
// agents, each one closed (and its checkout removed) after its report.
//
// Every run state change goes through one serial chain, so the slot count
// and the queue never race.

import nodeFs from "node:fs"
import path from "node:path"
import {
    DEFAULT_REVIEW_MODEL,
    REVIEW_VERDICTS,
    SETTLED_VERDICT,
    USAGE_LIMIT_ERROR,
    reviewModel,
} from "../contracts/reviews.js"
import { sameAgent } from "../herdr/agentIdentity.js"
import { freeAgentName } from "../herdr/agentNames.js"
import {
    findLimitLine,
    findLimitText,
    limitResetAt,
} from "../herdr/usageLimit.js"
import { expandHome } from "../herdr/herdrClient.js"
import { AppError, NotFoundError, ValidationError } from "../util/errors.js"
import { systemClock } from "../util/clock.js"
import { nullLogger } from "../util/logger.js"
import {
    CLOSED_PRS_QUERY,
    OPEN_PRS_QUERY,
    classifyPr,
    commentsBeforeQuery,
    ineligibleReason,
    normalizeNode,
    olderCommentsNeeded,
    ownReviewsBeforeQuery,
    prsByNumberQuery,
} from "./prScan.js"
import { quietLaunchArgs, tomlString } from "../workers/mcpArgs.js"
import {
    reviewAgentName,
    reviewFolderName,
    reviewNudgePrompt,
    reviewPrompt,
    reviewTitle,
} from "./reviewPrompt.js"
import {
    ACTIVE_RUN_STATUSES,
    CANCELLED_BY_OWNER,
    NO_REPORT,
    SLOT_RUN_STATUSES,
} from "./reviewsRepo.js"

export const REVIEW_SETTINGS = {
    poll_minutes: { key: "reviews.poll_minutes", fallback: 20 },
    parallel: { key: "reviews.parallel", fallback: 4 },
    agent_kind: { key: "reviews.agent_kind", fallback: "claude" },
    fallback_kind: { key: "reviews.fallback_kind", fallback: "none" },
    // REVIEW_MODELS ids of the review agent's / fallback's kind
    agent_model: { key: "reviews.agent_model", fallback: DEFAULT_REVIEW_MODEL },
    fallback_model: {
        key: "reviews.fallback_model",
        fallback: DEFAULT_REVIEW_MODEL,
    },
}
/** Settings key the limit deadlines are kept under (across restarts). */
export const LIMITS_KEY = "reviews.limited_until"
export const VERDICTS = REVIEW_VERDICTS
/** Where review agents start (config reviews.dir). */
export const DEFAULT_REVIEWS_DIR = "~/work/reviews"
/**
 * Env of every review agent: REVIEW_ORCH_SKIP=1 keeps the review
 * orchestrator's stop hook from reviewing the agent's checkout (it reviews
 * someone else's PR, it does not write code).
 */
export const REVIEW_AGENT_ENV = { REVIEW_ORCH_SKIP: "1" }
/**
 * Sandbox flags of a review agent by kind. codex treats the (untrusted)
 * reviews folder as read-only without network: it could neither clone nor
 * reach GitHub. workspace-write with network keeps it sandboxed (writes
 * only in the reviews folder) while gh works and clones over SSH.
 */
export function reviewSandboxArgs(kind) {
    return kind === "codex"
        ? [
              "--sandbox",
              "workspace-write",
              "-c",
              "sandbox_workspace_write.network_access=true",
          ]
        : []
}
/**
 * Model and effort flags of a review agent: a REVIEW_MODELS id of its kind.
 * None for "default" (the CLI's own configuration) or an id of another kind.
 */
export function reviewModelArgs(kind, id) {
    const m = reviewModel(kind, id)
    if (!m) return []
    return kind === "codex"
        ? [
              "-m",
              m.model,
              "-c",
              `model_reasoning_effort=${tomlString(m.effort)}`,
          ]
        : ["--model", m.model, "--effort", m.effort]
}
const UPDATED = "reviews.updated"
/** A queued automatic run whose state was reviewed (or failed) before. */
const REVIEWED_BEFORE = "this state was reviewed before"
/** A queued automatic run cancelled because auto-review went off. */
const AUTO_OFF = "auto-review switched off"
const MAX_GONE_LOOKUP = 50
/** The longest setTimeout delay Node keeps (2^31 - 1 ms). */
const MAX_TIMER_MS = 2147483647
/** PRs per details query (by number). */
export const DETAIL_BATCH = 10
/** Unchanged open PRs are refreshed anyway after this long (CI, conflicts). */
export const REFRESH_MS = 6 * 3600000

const errMessage = (err) => (err && err.message) || String(err)

/**
 * @param {object} deps
 * @param {object} deps.reviews     createReviewsRepo
 * @param {object} deps.gh          createGhClient (graphql, login, org)
 * @param {object} deps.herdr       createHerdrClient
 * @param {object} deps.repoTable   list() of { name, description }
 * @param {object} [deps.settingsRepo]
 * @param {object} [deps.bus]
 * @param {string} [deps.reviewsDir]
 * @param {Function} [deps.agentEnv]  () -> { CC_URL, CC_TOKEN }
 * @param {Function} [deps.mcpArgs]   (kind) -> launch args
 * @param {string} [deps.login]       our GitHub login (else gh api user)
 * @param {object} [deps.fs]
 */
export function createReviewService({
    reviews,
    gh,
    herdr,
    repoTable,
    settingsRepo = null,
    bus = null,
    clock = systemClock,
    log = nullLogger,
    reviewsDir = DEFAULT_REVIEWS_DIR,
    agentEnv = () => ({}),
    mcpArgs = () => [],
    login = null,
    fs = nodeFs,
    startTimeoutMs = 60000,
    monitorMs = 15000,
    startGraceMs = 120000,
    nudgeAfterMs = 60000,
    failAfterNudgeMs = 180000,
    startDelayMs = 10000,
}) {
    const dir = expandHome(reviewsDir)
    const now = () => clock.now().toISOString()
    const nowMs = () => clock.now().getTime()
    let me = login || null
    let chain = Promise.resolve()
    let running = false
    let scanTimer = null
    let monitorTimer = null
    let cursor = 0
    const scans = new Map() // repo -> promise
    const background = new Set()
    const launching = new Set() // run ids whose agent is being started
    const limitedUntil = new Map() // agent kind -> ms its usage limit lifts
    let holdTimer = null // the queue waits for a usage limit to lift
    const repoLocks = new Map() // repo -> tail of its scans / fetches
    const reconciling = new Set()
    const retryAfter = new Map() // retry run id -> ms of its next fetch
    let holdAt = 0 // when holdTimer fires (ms)
    let unsubscribe = null
    // run ids a cancel is cleaning up (still "running" until it is done):
    // their launch must not start or prompt the agent
    const cancelling = new Set()

    // ---- plumbing ------------------------------------------------------

    /** Run fn after every earlier run-state change has settled. */
    function serial(fn) {
        const run = chain.then(fn)
        chain = run.catch(() => {})
        return run
    }

    function bg(promise, what) {
        const p = Promise.resolve(promise)
            .catch((err) => log.warn({ err: errMessage(err) }, what))
            .finally(() => background.delete(p))
        background.add(p)
    }

    function emit() {
        if (bus) bus.emit(UPDATED, { data: {} })
    }

    function setting(name) {
        const { key, fallback } = REVIEW_SETTINGS[name]
        try {
            const v = settingsRepo ? settingsRepo.get(key, fallback) : fallback
            return v === null || v === undefined ? fallback : v
        } catch {
            return fallback
        }
    }

    function settings() {
        const t = nowMs()
        const limited = {}
        for (const [kind, until] of limitedUntil)
            if (until > t) limited[kind] = new Date(until).toISOString()
        return {
            poll_minutes: Number(setting("poll_minutes")) || 20,
            parallel: Math.max(1, Number(setting("parallel")) || 4),
            agent_kind: setting("agent_kind"),
            fallback_kind: setting("fallback_kind"),
            agent_model: setting("agent_model"),
            fallback_model: setting("fallback_model"),
            limited,
        }
    }

    /** settings() plus the kind a new review starts with now (or null). */
    function settingsView() {
        const next = kindForRun({})
        return {
            ...settings(),
            next_kind: next.kind || null,
            next_model: next.kind ? next.model : null,
        }
    }

    /**
     * The kind a run starts with: its own (a fallback retry) or the review
     * agent kind, else the fallback while that one is at its usage limit.
     * { kind, model } (model: the REVIEW_MODELS id set for that kind, as
     * review agent or fallback) or, every allowed kind limited,
     * { kind: null, until }.
     */
    function kindForRun(run) {
        const s = settings()
        const t = nowMs()
        const free = (k) => !((limitedUntil.get(k) || 0) > t)
        const fallback =
            s.fallback_kind && s.fallback_kind !== "none"
                ? s.fallback_kind
                : null
        // a retry's saved kind only while it is still the main or fallback
        const allowed = [s.agent_kind, fallback].filter(Boolean)
        const own = allowed.includes(run.agent_kind) ? run.agent_kind : null
        const options = [own, ...allowed].filter(Boolean)
        const kind = options.find(free)
        if (kind)
            return {
                kind,
                model: kind === s.agent_kind ? s.agent_model : s.fallback_model,
            }
        return {
            kind: null,
            until: Math.min(...options.map((k) => limitedUntil.get(k))),
        }
    }

    async function whoami() {
        if (!me) me = await gh.login()
        return me
    }

    function knownRepo(name) {
        const list = repoTable ? repoTable.list() || [] : []
        return list.find((r) => r.name === name) || null
    }

    // ---- scan ----------------------------------------------------------

    /**
     * Store a fetched PR -> { row, c }, or null when it is not storable (no
     * author, ours). A stored row of such a PR keeps its history but takes
     * the fetched state and waits for nothing, so no review is queued from
     * the stale row.
     */
    function storePr(repo, node, defaultBranch, login) {
        const pr = normalizeNode(node)
        const prev = reviews.getPr(repo, pr.number)
        if (!pr.author || pr.author.toLowerCase() === login.toLowerCase()) {
            if (prev)
                reviews.upsertPr({
                    ...prev,
                    // the author as GitHub has it now (null: the account is
                    // gone): such a PR is never reviewed (requestReview,
                    // claimRun)
                    author: pr.author,
                    author_bot: pr.author_bot,
                    state: pr.state,
                    merged_at: pr.merged_at,
                    closed_at: pr.closed_at,
                    needs_review: null,
                    trigger_key: null,
                    last_scanned_at: now(),
                })
            return null
        }
        const c = classifyPr(pr, {
            me: login,
            defaultBranch,
            prev,
        })
        const row = reviews.upsertPr({
            ...pr,
            ...c,
            repo,
            default_branch: defaultBranch,
            last_scanned_at: now(),
        })
        reviews.addDecisions(repo, pr.number, c.decisions)
        return { row, c }
    }

    /** Queue (or drop) automatic runs after a scan of the repo. */
    /**
     * Reconcile the repo's automatic runs with its stored open PRs (on the
     * chain): queue what needs a review, re-key or drop queued runs.
     */
    function syncQueue(repo) {
        const auto = Boolean((reviews.getRepo(repo) || {}).auto_review)
        const active = new Map(
            reviews
                .runsByStatus(ACTIVE_RUN_STATUSES)
                .filter((r) => r.repo === repo)
                .map((r) => [r.number, r])
        )
        let queued = 0
        // a queued run whose PR closed or merged meanwhile: nothing to
        // review (it would wait in Queued until a slot frees)
        for (const run of active.values()) {
            if (run.status !== "queued") continue
            const pr = reviews.getPr(repo, run.number)
            if (pr && pr.state !== "OPEN") {
                finishRun(run, { status: "cancelled", error: "PR is not open" })
                active.delete(run.number)
            }
        }
        for (const row of reviews.openPrs(repo)) {
            const run = active.get(row.number)
            // a queued automatic retry: the stopped agent's partial comment
            // doesn't end it (judged as in claimRun)
            const retry =
                run && run.status === "queued" && !run.manual && run.retry_of
            const wanted = retry
                ? retryStillWanted(run, row)
                : auto && row.needs_review && !ineligibleReason(row)
            // reviewed meanwhile (e.g. by hand) or no longer eligible: an
            // automatic run that has not started is dropped
            if (run && run.status === "queued" && !run.manual && !wanted) {
                reviews.updateRun(run.id, {
                    status: "cancelled",
                    finished_at: now(),
                    error: "no review needed any more",
                })
                continue
            }
            // still queued and the PR moved on (new head, new comment): the
            // run now stands for the new state
            if (
                run &&
                wanted &&
                row.needs_review &&
                run.status === "queued" &&
                !run.manual &&
                run.trigger_key !== row.trigger_key
            ) {
                // ... unless that state was reviewed (or failed) before:
                // once per state, also when the head comes back to it
                if (reviewedBefore(run, row.trigger_key))
                    finishRun(run, {
                        status: "cancelled",
                        error: REVIEWED_BEFORE,
                    })
                else
                    reviews.updateRun(run.id, {
                        kind: row.needs_review,
                        trigger_key: row.trigger_key,
                        head_sha: row.head_sha,
                    })
                continue
            }
            // an automatic review a usage limit stopped while auto-review
            // was off (no hand-over, or its queued retry cancelled): with
            // auto-review back, its retry is queued as the hand-over would
            // have (the state was never reviewed to its end)
            const dropped = !run && auto ? droppedRetry(repo, row.number) : null
            if (
                dropped &&
                retryStillWanted({ repo, retry_of: dropped.id }, row)
            ) {
                reviews.createRun({
                    repo,
                    number: row.number,
                    kind: dropped.kind,
                    trigger_key: dropped.trigger_key,
                    head_sha: dropped.head_sha,
                    retry_of: dropped.id,
                })
                queued++
                continue
            }
            if (!wanted || run) continue
            // this exact state was reviewed (or failed) before: never again
            // automatically
            if (reviews.runWithKey(repo, row.number, row.trigger_key)) continue
            supersede(repo, row.number)
            reviews.createRun({
                repo,
                number: row.number,
                kind: row.needs_review,
                trigger_key: row.trigger_key,
                head_sha: row.head_sha,
            })
            queued++
        }
        return queued
    }

    /**
     * The PR's last run when it is an automatic review whose usage-limit
     * retry auto-review being off dropped: failed at the limit with no
     * replacement, or a queued retry cancelled when auto-review went off.
     */
    function droppedRetry(repo, number) {
        const last = reviews.latestRun(repo, number)
        if (!last || last.manual) return null
        const limited = last.status === "failed" && limitMarked(last)
        const cancelled =
            last.status === "cancelled" &&
            last.retry_of &&
            last.error === AUTO_OFF
        return limited || cancelled ? last : null
    }

    /**
     * A new run replaces the PR's last one: an agent a failed run kept open
     * (no report) is no longer kept; the monitor closes it.
     */
    function supersede(repo, number) {
        const last = reviews.latestRun(repo, number)
        if (!last || !last.workspace_id || last.status !== "failed") return
        reviews.updateRun(last.id, {
            error: `${last.error || "failed"} (replaced by a new run)`,
        })
        ensureMonitor()
    }

    /** Another run of the PR already stands for this state (key)? */
    function reviewedBefore(run, key) {
        const other = key && reviews.runWithKey(run.repo, run.number, key)
        return Boolean(other && other.id !== run.id)
    }

    /**
     * Page the node's conversation comments back to our change request
     * (olderCommentsNeeded), prepending them: an author's answer older than
     * the newest 100 still counts.
     */
    /**
     * Page our decision reviews back when there are more than 100 (they
     * decide the PR's state: a partial list would lose the decision).
     */
    async function olderOwnReviews(owner, repo, node, login) {
        const seen = new Set()
        for (;;) {
            const page = node.reviews && node.reviews.pageInfo
            if (!page || !page.hasPreviousPage || !page.startCursor) return
            if (seen.has(page.startCursor))
                throw new Error("review history paging repeats a cursor")
            seen.add(page.startCursor)
            const d = await gh.graphql(ownReviewsBeforeQuery(node.number), {
                owner,
                name: repo,
                me: login,
                before: page.startCursor,
            })
            const older = d?.repository?.pullRequest?.reviews
            if (!older) throw new Error("review history page missing")
            node.reviews = {
                pageInfo: older.pageInfo || {},
                nodes: [...(older.nodes || []), ...(node.reviews.nodes || [])],
            }
        }
    }

    async function olderComments(owner, repo, node, login) {
        const seen = new Set()
        while (olderCommentsNeeded(node, login)) {
            const before = node.comments.pageInfo.startCursor
            if (seen.has(before)) return
            seen.add(before)
            const d = await gh.graphql(commentsBeforeQuery(node.number), {
                owner,
                name: repo,
                before,
            })
            const page = d?.repository?.pullRequest?.comments
            if (!page) return
            node.comments = {
                pageInfo: page.pageInfo || {},
                nodes: [...(page.nodes || []), ...(node.comments.nodes || [])],
            }
        }
    }

    /** Does a listed open PR need its details (again)? */
    function stale(stored, listed, full) {
        if (full || !stored || stored.state !== "OPEN") return true
        if (stored.updated_at !== listed.updatedAt) return true
        const at = Date.parse(stored.last_scanned_at || "")
        return !Number.isFinite(at) || nowMs() - at >= REFRESH_MS
    }

    /**
     * List the open PRs, then fetch the details of the new / changed ones
     * and of the stored-open ones that left the list (merged or closed).
     * Returns the classified open PRs that were refreshed (the queue only
     * changes for those). full: refresh every open PR.
     */
    async function scanInner(repo, { full = false } = {}) {
        const login = await whoami()
        const owner = gh.org
        if (!owner) throw new Error("github.org is not configured")
        let def = null
        const listed = []
        let after = null
        let complete = false
        const cursors = new Set()
        for (;;) {
            const vars = { owner, name: repo, ...(after ? { after } : {}) }
            const data = await gh.graphql(OPEN_PRS_QUERY, vars)
            const r = data && data.repository
            if (!r) throw new Error(`repository ${owner}/${repo} not found`)
            def = (r.defaultBranchRef && r.defaultBranchRef.name) || null
            const prs = r.pullRequests || {}
            listed.push(...(prs.nodes || []).filter(Boolean))
            const info = prs.pageInfo || {}
            if (!info.hasNextPage || !info.endCursor) {
                complete = true
                break
            }
            // GitHub handing out a cursor twice: stop (incomplete) instead
            // of looping
            if (cursors.has(info.endCursor)) break
            cursors.add(info.endCursor)
            after = info.endCursor
        }
        if (!complete)
            log.warn(
                { repo, listed: listed.length },
                "review scan: open PR list incomplete"
            )
        const seen = new Set(listed.map((n) => n.number))
        const mine = (n) =>
            !n.author ||
            String(n.author.login || "").toLowerCase() === login.toLowerCase()
        // listed but not storable any more (the author's account is gone):
        // a stored row of it waits for nothing from now on (storePr), and a
        // run still queued for it (automatic, manual or a retry) is dropped
        for (const n of listed)
            if (mine(n) && reviews.getPr(repo, n.number)) {
                storePr(repo, n, def, login)
                for (const run of reviews.runsByStatus(["queued"]))
                    if (run.repo === repo && run.number === n.number)
                        finishRun(run, {
                            status: "cancelled",
                            error: "PR is not reviewable",
                        })
            }
        const changed = listed
            .filter((n) => !mine(n))
            .filter((n) => stale(reviews.getPr(repo, n.number), n, full))
            .map((n) => n.number)
        // only a complete list tells which stored-open PRs left it
        const gone = complete
            ? reviews
                  .openPrs(repo)
                  .map((p) => p.number)
                  .filter((n) => !seen.has(n))
                  .slice(0, MAX_GONE_LOOKUP)
            : []
        const classified = []
        // the author: from the list, else (a PR that left it) the stored one
        const authorOf = new Map(
            listed.map((n) => [n.number, (n.author && n.author.login) || null])
        )
        const numbers = [...changed, ...gone].map((n) => ({
            number: n,
            author: authorOf.has(n)
                ? authorOf.get(n)
                : (reviews.getPr(repo, n) || {}).author || null,
        }))
        for (let i = 0; i < numbers.length; i += DETAIL_BATCH) {
            const batch = numbers.slice(i, i + DETAIL_BATCH)
            // aliases GitHub answered with an error (a field missing, a PR
            // not found) are skipped: their stored state stays as it was
            const bad = new Set()
            const res = await gh.graphql(
                prsByNumberQuery(batch),
                { owner, name: repo, me: login },
                { partial: true }
            )
            const d = res.data
            for (const e of res.errors) {
                const at = Array.isArray(e.path) ? e.path : []
                if (at[0] !== "repository" || !at[1])
                    throw new Error(`gh graphql: ${e.message || "error"}`)
                bad.add(at[1])
            }
            const rr = (d && d.repository) || {}
            for (const { number: n } of batch) {
                const node = rr[`p${n}`]
                if (!node || bad.has(`p${n}`)) continue
                // older comments unreadable now: this PR keeps its stored
                // state (classified without them it could miss an answer)
                try {
                    await olderOwnReviews(owner, repo, node, login)
                    await olderComments(owner, repo, node, login)
                } catch (err) {
                    log.warn(
                        { err: errMessage(err), repo, pr: n },
                        "review scan: older comments"
                    )
                    continue
                }
                const s = storePr(repo, node, def, login)
                if (s && s.row.state === "OPEN") classified.push(s)
            }
        }
        await backfill(repo, def, login)
        return classified
    }

    /**
     * First scan: the recently closed PRs we reviewed (stats history).
     * Optional: a failure is logged and retried on the next scan.
     */
    async function backfill(repo, def, login) {
        const tracked = reviews.getRepo(repo)
        if (!tracked || tracked.backfilled) return
        let d
        try {
            d = await gh.graphql(CLOSED_PRS_QUERY, {
                owner: gh.org,
                name: repo,
                me: login,
            })
        } catch (err) {
            log.warn({ err: errMessage(err), repo }, "review history backfill")
            return
        }
        // a history page that failed: try the backfill again next scan
        let failed = false
        for (const node of d?.repository?.pullRequests?.nodes || []) {
            if (!node) continue
            try {
                await olderOwnReviews(gh.org, repo, node, login)
            } catch (err) {
                log.warn(
                    { err: errMessage(err), repo, pr: node.number },
                    "review history backfill: older reviews"
                )
                failed = true
                continue
            }
            const pr = normalizeNode(node)
            const c = classifyPr(pr, { me: login, defaultBranch: def })
            if (c.attempts > 0) storePr(repo, node, def, login)
        }
        if (!failed) reviews.markBackfilled(repo)
    }

    /** Run fn after earlier reads-and-writes of the repo (scans, fetches). */
    function withRepoLock(repo, fn) {
        const prev = repoLocks.get(repo) || Promise.resolve()
        const run = prev.then(fn)
        const tail = run.catch(() => {})
        repoLocks.set(repo, tail)
        tail.then(() => {
            if (repoLocks.get(repo) === tail) repoLocks.delete(repo)
        })
        return run
    }

    /**
     * Scan one repo now (one at a time per repo). full: refresh every open
     * PR, not only the changed ones (newly tracked, auto-review switched
     * on, Scan now).
     */
    function scanRepo(repo, { full = false } = {}) {
        if (scans.has(repo)) return scans.get(repo)
        const p = (async () => {
            let classified = []
            try {
                classified = await withRepoLock(repo, () =>
                    scanInner(repo, { full })
                )
                reviews.markScanned(repo, null)
            } catch (err) {
                log.warn({ err: errMessage(err), repo }, "review scan failed")
                reviews.markScanned(repo, errMessage(err))
                // whatever was stored before the failure still goes through
                // the queue (reconciled from the stored PRs)
                await serial(() => syncQueue(repo))
                pump()
                emit()
                return { repo, error: errMessage(err) }
            }
            const queued = await serial(() => syncQueue(repo))
            emit()
            pump()
            return { repo, prs: classified.length, queued }
        })().finally(() => scans.delete(repo))
        scans.set(repo, p)
        return p
    }

    function trackedRepos() {
        return reviews
            .listRepos()
            .filter((r) => r.track)
            .map((r) => r.name)
    }

    /** Scan every tracked repo now (manual "Scan now"), one after another. */
    async function scanAll() {
        const out = []
        for (const repo of trackedRepos())
            out.push(await scanRepo(repo, { full: true }))
        return out
    }

    /** Next timer: one repo per poll period / number of tracked repos. */
    function scheduleScan() {
        if (!running) return
        const n = trackedRepos().length
        const period = settings().poll_minutes * 60000
        scanTimer = clock.setTimeout(scanTick, n ? period / n : period)
    }

    async function scanTick() {
        scanTimer = null
        const repos = trackedRepos()
        if (repos.length) {
            const repo = repos[cursor % repos.length]
            cursor = (cursor + 1) % repos.length
            await scanRepo(repo)
        }
        scheduleScan()
    }

    // ---- agents --------------------------------------------------------

    // names picked by launches whose agent has not started yet
    const naming = new Set()

    /** Remove a run's checkout, only a folder of its own in the reviews dir. */
    /**
     * Remove a run's checkout and the "<checkout>-…" siblings its agent
     * made next to it (e.g. "-artifacts"); only inside the reviews dir. The
     * run id ends the name, so r4 never matches r40's folders.
     */
    async function removeFolder(run) {
        const folder = run.folder
        if (!folder) return
        const resolved = path.resolve(folder)
        const parent = path.resolve(dir)
        if (path.dirname(resolved) !== parent) return
        const base = path.basename(resolved)
        let names = [base]
        try {
            const all = await fs.promises.readdir(parent)
            names = all.filter((n) => n === base || n.startsWith(`${base}-`))
        } catch {
            // can't list: the checkout itself only
        }
        for (const name of names) {
            const target = path.join(parent, name)
            try {
                await fs.promises.rm(target, { recursive: true, force: true })
            } catch (err) {
                log.warn(
                    { err: errMessage(err), folder: target },
                    "review folder removal"
                )
            }
        }
    }

    /**
     * Close a run's workspace, then remove its checkout. A failed close
     * (herdr unreachable) keeps both, so nothing is deleted under a live
     * agent and the close can be retried: returns false. A workspace herdr
     * no longer knows counts as closed.
     */
    async function closeAgent(run) {
        if (run.workspace_id) {
            try {
                await herdr.workspaceClose(run.workspace_id)
            } catch (err) {
                const gone =
                    /not[_ ]found/i.test(String(err && err.code)) ||
                    /not found/i.test(errMessage(err))
                if (!gone) {
                    log.warn({ err: errMessage(err) }, "review workspace close")
                    return false
                }
            }
        }
        await removeFolder(run)
        // only the workspace closed here: a launch may have stored a new one
        // meanwhile (cancelled while starting), which stays to be closed
        if (reviews.getRun(run.id).workspace_id === run.workspace_id)
            reviews.updateRun(run.id, { workspace_id: null })
        return true
    }

    /** Close or throw (dashboard actions). */
    async function mustClose(run) {
        if (!(await closeAgent(run)))
            throw new AppError(
                "close_failed",
                `could not close the agent of review run ${run.id}; is herdr running?`,
                { status: 502 }
            )
    }

    function finishRun(run, patch) {
        return reviews.updateRun(run.id, { finished_at: now(), ...patch })
    }

    async function failRun(run, error, { close = false } = {}) {
        if (close) await closeAgent(run)
        finishRun(run, { status: "failed", error })
        emit()
        // a close herdr refused is retried by the monitor
        ensureMonitor()
    }

    /** Does an automatic retry after a usage limit still qualify? */
    function retryStillWanted(run, pr) {
        const repo = reviews.getRepo(run.repo)
        if (!repo || !repo.track || !repo.auto_review || ineligibleReason(pr))
            return false
        // something to review after our latest word (also after a decision
        // the stopped agent landed: a new head, an answer)
        if (pr.needs_review) return true
        // A decision of ours landed after the stopped attempt began and the
        // PR needs no review under the re-review rule (docs/09): dropped,
        // as an uninterrupted review would end. By design this includes an
        // approval followed by a new head: an approved PR is never
        // re-reviewed automatically (classifyPr). Attempts run one at a
        // time, so a decision before the stopped attempt began is an
        // earlier one: that attempt was started for something after it (an
        // answer) and its own partial comment must not end the retries.
        // An answer that came in while the stopped attempt was still at work
        // after its own decision, followed by its comment, ends like the
        // uninterrupted review would: our word is the latest (classifyPr).
        const stopped = lastStarted(run)
        if (!stopped || !pr.decided_at) return true
        // GitHub's times are whole seconds: only a later second counts as
        // after the start (the same second keeps the retry)
        const sec = (iso) => Math.floor(Date.parse(iso) / 1000)
        return !(sec(pr.decided_at) > sec(stopped.started_at))
    }

    /** The newest earlier attempt of a retry chain that started, if any. */
    function lastStarted(run) {
        let cur = run
        const seen = new Set()
        while (cur && cur.retry_of && !seen.has(cur.id)) {
            seen.add(cur.id)
            cur = reviews.getRun(cur.retry_of)
            if (cur && cur.started_at) return cur
        }
        return null
    }

    /** Does an automatic run still qualify (tracking, PR state)? */
    function autoStillWanted(run, pr) {
        const repo = reviews.getRepo(run.repo)
        return Boolean(
            repo &&
            repo.track &&
            repo.auto_review &&
            pr.needs_review &&
            !ineligibleReason(pr)
        )
    }

    /** Take a slot for a queued run (on the chain); null: not startable. */
    function claimRun(run, kind, model = DEFAULT_REVIEW_MODEL) {
        const pr = reviews.getPr(run.repo, run.number)
        if (!pr || pr.state !== "OPEN") {
            finishRun(run, { status: "cancelled", error: "PR is not open" })
            return null
        }
        // its author's account is gone (a scan or fetch stored that)
        if (!pr.author) {
            finishRun(run, {
                status: "cancelled",
                error: "PR is not reviewable",
            })
            return null
        }
        // a retry after a usage limit: the PR was fetched fresh just now,
        // so an automatic one is judged on the current state below (dropped
        // when the stopped agent's review landed); a manual one goes on,
        // its prompt says to check what was already posted
        // auto-review switched off, reviewed meanwhile, …: drop it. An
        // automatic retry: only when tracking stopped or a review decision
        // of ours landed after its first attempt began (the stopped agent's
        // partial comments don't end it)
        if (
            !run.manual &&
            !(run.retry_of
                ? retryStillWanted(run, pr)
                : autoStillWanted(run, pr))
        ) {
            finishRun(run, {
                status: "cancelled",
                error: "no review needed any more",
            })
            return null
        }
        // it would now stand for a state reviewed (or failed) before
        if (
            !run.manual &&
            pr.trigger_key !== run.trigger_key &&
            reviewedBefore(run, pr.trigger_key)
        ) {
            finishRun(run, { status: "cancelled", error: REVIEWED_BEFORE })
            return null
        }
        launching.add(run.id)
        return reviews.updateRun(run.id, {
            status: "running",
            started_at: now(),
            agent_kind: kind,
            // a model of another kind (the settings changed): its default
            agent_model: reviewModel(kind, model)
                ? model
                : DEFAULT_REVIEW_MODEL,
            folder: path.join(
                dir,
                reviewFolderName(run.repo, run.number, run.id)
            ),
            head_sha: pr.head_sha,
            // the run stands for the state it reviews now (a manual one
            // keeps its kind, but records the state too: it may settle it).
            // A retry the stopped agent's partial comment made look
            // reviewed keeps its own kind and state
            trigger_key: pr.trigger_key || run.trigger_key,
            ...(run.manual ? {} : { kind: pr.needs_review || run.kind }),
        })
    }

    /** Workspace + agent + prompt for a claimed run (off the chain). */
    async function launchRun(run) {
        const pr = reviews.getPr(run.repo, run.number)
        const kind = run.agent_kind
        const title = reviewTitle(pr)
        const folder = run.folder
        let cur = run
        let name = null
        // cancelled while it was starting: close what exists, stop here
        const cancelled = async () => {
            const latest = reviews.getRun(run.id)
            if (latest.status === "running" && !cancelling.has(run.id))
                return false
            await closeAgent({ ...latest, workspace_id: cur.workspace_id })
            return true
        }
        try {
            await fs.promises.mkdir(dir, { recursive: true })
            const login = await whoami()
            name = await freeAgentName(
                reviewAgentName(run.repo, run.number),
                (n) => herdr.agentGet(n),
                { reserved: naming }
            )
            cur = reviews.updateRun(run.id, { agent_name: name })
            const ws = await herdr.workspaceCreate({
                cwd: dir,
                label: title,
                env: {
                    ...agentEnv(),
                    ...REVIEW_AGENT_ENV,
                    CC_REVIEW_ID: String(run.id),
                },
                focus: false,
            })
            cur = reviews.updateRun(run.id, {
                workspace_id: ws.workspaceId ?? null,
                pane_id: ws.paneId ?? null,
            })
            if (await cancelled()) return
            await herdr.agentStart({
                name,
                kind,
                paneId: ws.paneId,
                args: [
                    ...mcpArgs(kind),
                    ...quietLaunchArgs(kind),
                    ...reviewSandboxArgs(kind),
                    ...reviewModelArgs(kind, run.agent_model),
                    ...(kind === "claude" ? ["--name", title] : []),
                ],
                timeoutMs: startTimeoutMs,
            })
            if (await cancelled()) return
            try {
                await herdr.agentPrompt(
                    name,
                    reviewPrompt({
                        pr,
                        run: cur,
                        org: gh.org,
                        folder,
                        me: login,
                        retry: cur.retry_of ? firstAttempt(cur) : null,
                    }),
                    { wait: false }
                )
            } catch (err) {
                // herdr may have taken the prompt before the error (socket,
                // timeout): the agent runs, the monitor follows it and sends
                // the prompt again if it never starts working
                log.warn({ err: errMessage(err), run: run.id }, "review prompt")
            }
        } catch (err) {
            log.warn({ err: errMessage(err), run: run.id }, "review start")
            await serial(async () => {
                const latest = reviews.getRun(run.id)
                // cancelled meanwhile: still close the workspace this launch
                // made (its id stays stored if herdr refuses: retried)
                if (latest.status !== "running") {
                    if (latest.workspace_id) await closeAgent(latest)
                    emit()
                    return
                }
                // stopped at its usage limit while starting (a blocked or
                // timed-out start): the same hand-over as later on
                if (
                    latest.agent_name &&
                    latest.workspace_id &&
                    (await checkLimit(latest))
                )
                    return
                await failRun(cur, `start failed: ${errMessage(err)}`, {
                    close: true,
                })
            })
            pump()
            return
        } finally {
            // started (herdr knows it now) or failed: no longer reserved
            if (name) naming.delete(name)
            launching.delete(run.id)
            // a close herdr refused on any path is retried by the monitor
            ensureMonitor()
        }
        emit()
        ensureMonitor()
    }

    /**
     * Start queued runs while slots are free: the slot is taken on the
     * chain, the (slow) herdr launch runs off it.
     */
    function pump() {
        if (!running) return Promise.resolve()
        // retries' GitHub reads first, off the chain; stop() waits for them
        // ordinary runs start at once (slots are kept for the retries
        // ahead of them); each retry is claimed right after its own fetch,
        // and one whose slot went to another run is fetched again next time
        const p = serial(() => claimQueued())
            .then(() => prepareRetries())
            .catch((err) =>
                log.warn({ err: errMessage(err) }, "review retry prepare")
            )
            .then(() => serial(() => claimQueued({ repump: true })))
        background.add(p)
        p.finally(() => background.delete(p))
        return p
    }

    /**
     * Retries after a usage limit that could start now (a free slot, a
     * free kind): fetch their PRs fresh, off the run-state chain, and
     * claim each right after its fetch (no stale state while other fetches
     * run). One GitHub can't read waits a minute before it is tried again.
     */
    async function prepareRetries() {
        let room =
            settings().parallel - reviews.runsByStatus(SLOT_RUN_STATUSES).length
        for (const run of reviews.runsByStatus(["queued"])) {
            if (!running || room <= 0) return
            // every allowed kind limited: wake up when the first one lifts
            const pick = kindForRun(run)
            if (!pick.kind) {
                holdUntil(pick.until)
                return
            }
            // a retry waiting out its delay, or fetched by another pump
            // right now, takes no slot from the ones behind it
            if (run.retry_of) {
                if (reconciling.has(run.id)) continue
                if ((retryAfter.get(run.id) || 0) > nowMs()) {
                    // wake up when its delay ends
                    holdUntil(retryAfter.get(run.id))
                    continue
                }
            }
            room--
            if (!run.retry_of) continue
            reconciling.add(run.id)
            try {
                const got = await reconcileRetry(run)
                if (got && got.drop) {
                    retryAfter.delete(run.id)
                    await serial(() => {
                        const cur = reviews.getRun(run.id)
                        if (cur.status !== "queued") return
                        finishRun(cur, { status: "cancelled", error: got.drop })
                        emit()
                    })
                    // its slot goes to the next one
                    room++
                } else if (got) {
                    retryAfter.delete(run.id)
                    await serial(() =>
                        claimQueued({ fetched: new Set([run.id]) })
                    )
                    // dropped at its start: its slot goes to the next one
                    if (reviews.getRun(run.id).status === "cancelled") room++
                } else {
                    retryAfter.set(run.id, nowMs() + 60000)
                    holdUntil(nowMs() + 60000)
                    // its kept slot is free again: a retry fetched meanwhile
                    // by another pass may take it (this one waits out its
                    // delay, so no loop)
                    if (
                        reviews
                            .runsByStatus(["queued"])
                            .some((r) => r.id !== run.id)
                    )
                        pump()
                    // not startable now: its slot goes to the next one
                    room++
                }
            } finally {
                reconciling.delete(run.id)
            }
        }
    }

    /**
     * Claim queued runs into free slots (on the chain, no awaits). A retry
     * only when its PR was fetched just now (`fetched`); an unfetched one
     * (not waiting out its delay) keeps a slot from the runs behind it.
     * `repump`: pump again when a dropped run freed a slot a skipped retry
     * could use.
     */
    function claimQueued({ fetched = new Set(), repump = false } = {}) {
        // stopped meanwhile: start nothing
        if (!running) return
        {
            const claimed = []
            let changed = false
            let unfetched = false
            let reserved = 0
            for (const next of reviews.runsByStatus(["queued"])) {
                const busy = reviews.runsByStatus(SLOT_RUN_STATUSES).length
                if (busy + reserved >= settings().parallel) break
                // every allowed kind at its usage limit: the queue waits
                const pick = kindForRun(next)
                if (!pick.kind) {
                    holdUntil(pick.until)
                    break
                }
                // a retry starts only after its PR was fetched fresh
                if (next.retry_of && !fetched.has(next.id)) {
                    unfetched = true
                    if (!((retryAfter.get(next.id) || 0) > nowMs())) reserved++
                    continue
                }
                const run = claimRun(next, pick.kind, pick.model)
                // null: claimRun dropped it (cancelled)
                if (run) claimed.push(run)
                else changed = true
            }
            if (claimed.length || changed) emit()
            for (const run of claimed) bg(launchRun(run), "review launch")
            // a dropped run freed the slot a skipped retry could use: fetch
            // it now (each pass drops a run, so this ends)
            if (repump && changed && unfetched) pump()
        }
    }

    /** Start the queue again once a usage limit lifts. */
    function holdUntil(until) {
        if (!running) return
        const at = Math.max(nowMs() + 1000, until + 1000)
        // already waking up earlier: keep that one
        if (holdTimer && holdAt <= at) return
        if (holdTimer) clock.clearTimeout(holdTimer)
        // timers can't wait longer than ~24.8 days: wake up then and look
        // again
        const delay = Math.min(at - nowMs(), MAX_TIMER_MS)
        holdAt = nowMs() + delay
        holdTimer = clock.setTimeout(() => {
            holdTimer = null
            // a limit may have lifted: the page's badge follows
            emit()
            wakeAtNextLimit()
            pump()
        }, delay)
    }

    /** Wake up when the next usage limit lifts (also with nothing queued). */
    function wakeAtNextLimit() {
        const t = nowMs()
        const next = [...limitedUntil.values()].filter((u) => u > t)
        if (next.length) holdUntil(Math.min(...next))
    }

    /** Limit deadlines: kept in the settings table across restarts. */
    function saveLimits() {
        if (!settingsRepo || !settingsRepo.set) return
        const t = nowMs()
        const out = {}
        for (const [k, until] of limitedUntil) if (until > t) out[k] = until
        try {
            settingsRepo.set(LIMITS_KEY, out)
        } catch (err) {
            log.warn({ err: errMessage(err) }, "review limits not saved")
        }
    }

    function loadLimits() {
        let saved = null
        try {
            saved = settingsRepo ? settingsRepo.get(LIMITS_KEY, null) : null
        } catch {
            saved = null
        }
        const t = nowMs()
        for (const [k, until] of Object.entries(saved || {}))
            if (Number(until) > t) limitedUntil.set(k, Number(until))
    }

    /**
     * The agent stopped at its usage limit (banner on its visible screen)?
     * Its kind is limited until the banner's reset time, the run is noted,
     * its agent closed, and replaceLimited hands its review over.
     */
    /** Stopped at a usage limit (noted on the run before its close)? */
    function limitMarked(run) {
        return String(run.error || "").startsWith(USAGE_LIMIT_ERROR)
    }

    /**
     * The visible screen of the run's agent; by its pane when herdr does
     * not know the name (a start that timed out before it took the name).
     */
    async function readScreen(run) {
        const opts = { lines: 40, source: "visible" }
        try {
            return await herdr.agentRead(run.agent_name, opts)
        } catch (err) {
            if (!run.pane_id) throw err
            return herdr.agentRead(run.pane_id, opts)
        }
    }

    async function checkLimit(run) {
        // marked before and its close refused: only the close is retried,
        // whatever the screen shows now (the same banner read again must
        // not move the deadline)
        if (limitMarked(run)) {
            if (await closeAgent(run)) replaceLimited(run)
            return true
        }
        let text
        try {
            // the screen as it is now: an old banner in the scrollback of an
            // agent that went on since must not count
            text = await readScreen(run)
        } catch {
            return false
        }
        const line = findLimitLine(text)
        if (!line) return false
        const kind = run.agent_kind
        // the reset time may be wrapped onto the next line
        const until = limitResetAt(findLimitText(text), nowMs())
        if (until > (limitedUntil.get(kind) || 0)) {
            limitedUntil.set(kind, until)
            saveLimits()
            wakeAtNextLimit()
        }
        log.warn({ run: run.id, kind, line }, "review agent at its usage limit")
        // noted on the run first: a stop between the close and the hand-
        // over is finished after a restart (the agent-gone path)
        const error = `${USAGE_LIMIT_ERROR} (${kind}): ${String(line).trim().slice(0, 200)}`
        const marked = reviews.updateRun(run.id, { error })
        // the page's limit badge, whether or not the close goes through
        emit()
        // herdr refused the close: the run stays as it is (the next tick
        // sees the banner again and retries); no second agent meanwhile
        if (!(await closeAgent(marked))) return true
        replaceLimited(marked)
        return true
    }

    /**
     * Fail a run stopped by a usage limit and queue its replacement in one
     * transaction: the review is never lost. On the fallback kind when
     * there is one other than this one, else whatever kind is free when it
     * starts (it waits for the limit to lift). It waits for a fresh scan of
     * its repo and is dropped if the stopped agent's review landed.
     */
    function replaceLimited(run) {
        const fallback = settings().fallback_kind
        const repo = reviews.getRepo(run.repo)
        // auto-review switched off meanwhile: no automatic replacement (the
        // state is not spent; syncQueue queues its retry once auto-review
        // is back: droppedRetry)
        if (!run.manual && !(repo && repo.track && repo.auto_review)) {
            finishRun(run, { status: "failed", error: run.error })
            emit()
            return
        }
        reviews.failAndReplace(
            run.id,
            { status: "failed", finished_at: now(), error: run.error },
            {
                repo: run.repo,
                number: run.number,
                kind: run.kind,
                trigger_key: run.trigger_key,
                manual: run.manual,
                head_sha: run.head_sha,
                agent_kind:
                    fallback &&
                    fallback !== "none" &&
                    fallback !== run.agent_kind
                        ? fallback
                        : null,
                retry_of: run.id,
            }
        )
        emit()
    }

    /**
     * A retry after a usage limit: fetch its PR fresh before it starts
     * (the stopped agent may have submitted its review), so claimRun judges
     * the current state. False when GitHub could not be read: it stays
     * queued and is tried again in a minute. { drop: reason } when the PR
     * can never be reviewed (closed, no author, ours).
     */
    async function reconcileRetry(run) {
        // scans and retry fetches of a repo take turns: a slower read never
        // overwrites a newer one
        return withRepoLock(run.repo, () => reconcileRetryInner(run))
    }

    /**
     * Fetch one PR and store it (call it under the repo lock) ->
     * { node, stored }: stored is null when the PR is not storable (no
     * author, ours). Throws when the PR can't be read.
     */
    async function fetchPr(repo, number) {
        const pr = reviews.getPr(repo, number)
        const login = await whoami()
        const res = await gh.graphql(
            prsByNumberQuery([{ number, author: pr && pr.author }]),
            { owner: gh.org, name: repo, me: login },
            { partial: true }
        )
        const r = (res.data && res.data.repository) || {}
        const node = r[`p${number}`]
        if (!node || res.errors.length) throw new Error("PR not readable")
        await olderOwnReviews(gh.org, repo, node, login)
        await olderComments(gh.org, repo, node, login)
        const stored = storePr(
            repo,
            node,
            (r.defaultBranchRef && r.defaultBranchRef.name) || null,
            login
        )
        return { node, stored }
    }

    async function reconcileRetryInner(run) {
        try {
            const { node, stored } = await fetchPr(run.repo, run.number)
            // readable but not storable (the author's account is gone, or
            // it is ours): never reviewable, the retry is dropped
            if (!stored)
                return {
                    drop:
                        node.state && node.state !== "OPEN"
                            ? "PR is not open"
                            : "PR is not reviewable",
                }
            return true
        } catch (err) {
            log.warn(
                { err: errMessage(err), run: run.id },
                "review retry: PR not reconciled"
            )
            return false
        }
    }

    /** The first run of a retry chain (where the review began). */
    function firstAttempt(run) {
        let cur = run
        const seen = new Set()
        while (cur && cur.retry_of && !seen.has(cur.id)) {
            seen.add(cur.id)
            const prev = reviews.getRun(cur.retry_of)
            if (!prev) break
            cur = prev
        }
        return cur
    }

    async function checkRun(run) {
        // claimed, but the process stopped before its agent got a name
        // (launches in this process are skipped by the monitor)
        if (!run.agent_name) {
            await failRun(run, "interrupted before its agent started", {
                close: true,
            })
            bg(scanRepo(run.repo), "review rescan")
            return
        }
        let info
        try {
            info = await herdr.agentGet(run.agent_name)
        } catch (err) {
            log.warn({ err: errMessage(err) }, "review agent check")
            return // herdr unreachable: look again later
        }
        // the name now belongs to another agent: ours is gone
        if (info && !sameAgent(run, info)) info = null
        if (info === null) {
            // its workspace may still be there (a closed agent leaves it)
            const closed = await closeAgent(run)
            // stopped by a usage limit, the hand-over was interrupted: once
            // its workspace is gone (else the next tick tries again)
            if (run.status === "running" && limitMarked(run)) {
                if (closed) replaceLimited(reviews.getRun(run.id))
                return
            }
            if (run.status === "reported") finishRun(run, { status: "done" })
            else
                finishRun(run, {
                    status: "failed",
                    error: "agent exited without a report",
                })
            emit()
            bg(scanRepo(run.repo), "review rescan")
            return
        }
        const state = info.status
        // stopped at its usage limit (idle or at a dialog): fall back
        if (
            run.status === "running" &&
            (state !== "working" || limitMarked(run)) &&
            (await checkLimit(run))
        )
            return
        if (state === "working" || state === "blocked") {
            if (!run.seen_working || run.idle_since)
                reviews.updateRun(run.id, {
                    seen_working: state === "working" || run.seen_working,
                    idle_since: null,
                })
            return
        }
        if (state !== "idle" && state !== "done") return
        if (run.status === "reported") {
            // herdr unreachable: still reported, the next tick retries
            if (!(await closeAgent(run))) return
            finishRun(run, { status: "done" })
            emit()
            bg(scanRepo(run.repo), "review rescan")
            return
        }
        const startedMs = run.started_at ? Date.parse(run.started_at) : nowMs()
        if (!run.seen_working && nowMs() - startedMs < startGraceMs) return
        if (!run.idle_since) {
            reviews.updateRun(run.id, { idle_since: now() })
            return
        }
        const idleMs = nowMs() - Date.parse(run.idle_since)
        if (!run.nudged_at) {
            if (idleMs < nudgeAfterMs) return
            // never worked: the review prompt did not land (a startup
            // dialog took it): send it again; else remind it to report
            const pr = run.seen_working
                ? null
                : reviews.getPr(run.repo, run.number)
            const text = pr
                ? reviewPrompt({
                      pr,
                      run,
                      org: gh.org,
                      folder: run.folder,
                      me: await whoami(),
                      retry: run.retry_of ? firstAttempt(run) : null,
                  })
                : reviewNudgePrompt(run)
            try {
                await herdr.agentPrompt(run.agent_name, text, {
                    wait: false,
                })
            } catch (err) {
                // not delivered: the next tick tries again
                log.warn({ err: errMessage(err) }, "review nudge")
                return
            }
            reviews.updateRun(run.id, { nudged_at: now(), idle_since: null })
            return
        }
        if (idleMs >= failAfterNudgeMs) {
            // the agent stays open for a look (Close agent on the dashboard)
            await failRun(run, NO_REPORT)
        }
    }

    function monitorTick() {
        monitorTimer = null
        return serial(async () => {
            for (const run of reviews.runsByStatus(SLOT_RUN_STATUSES))
                if (!launching.has(run.id)) await checkRun(run)
            // finished runs whose workspace close failed: retry
            for (const run of reviews.leftOpen())
                if (await closeAgent(run)) emit()
        })
            .catch((err) =>
                log.warn({ err: errMessage(err) }, "review monitor")
            )
            .then(() => pump())
            .finally(() => ensureMonitor())
    }

    function ensureMonitor(delay = monitorMs) {
        if (!running || monitorTimer) return
        if (
            !reviews.runsByStatus(SLOT_RUN_STATUSES).length &&
            !reviews.leftOpen().length
        )
            return
        monitorTimer = clock.setTimeout(monitorTick, delay)
    }

    // ---- public operations ---------------------------------------------

    /** MCP cc_review_report: the agent's verdict. */
    function report({ review_id, verdict, issues, summary }, ctx = {}) {
        const id = Number(review_id)
        if (ctx.callerTaskId)
            throw new AppError(
                "wrong_caller",
                "a task agent can't report a PR review",
                { status: 403 }
            )
        if (ctx.callerReviewId && Number(ctx.callerReviewId) !== id)
            throw new AppError(
                "wrong_review",
                `this session reviews run ${ctx.callerReviewId}, not ${id}`,
                { status: 403 }
            )
        if (!VERDICTS.includes(verdict))
            throw new ValidationError("invalid verdict", { verdict })
        return serial(() => {
            const run = reviews.getRun(id)
            if (!run) throw new NotFoundError(`review run ${id}`)
            if (!["running", "reported", "failed"].includes(run.status))
                throw new AppError(
                    "run_not_active",
                    `review run ${id} is ${run.status}`,
                    { status: 409 }
                )
            // "unchanged": our earlier change request stands, so only a
            // re-review of one can end that way (after our approval, the
            // new head needs a new review)
            const reviewed = reviews.getPr(run.repo, run.number)
            if (
                verdict === SETTLED_VERDICT &&
                (run.kind !== "re_review" ||
                    (reviewed && reviewed.decision === "approved"))
            )
                throw new ValidationError(
                    "unchanged is only for a re-review of our change request",
                    { verdict, kind: run.kind }
                )
            // failed and replaced by a newer run: keep the verdict for the
            // record, but the run stays over (one active run per PR)
            const latest = reviews.latestRun(run.repo, run.number)
            if (run.status === "failed" && latest && latest.id !== run.id) {
                reviews.updateRun(id, {
                    reported_at: now(),
                    verdict,
                    issues: Number.isInteger(issues) ? issues : null,
                    summary: summary ? String(summary).slice(0, 4000) : null,
                })
                emit()
                return {
                    ok: true,
                    run_id: id,
                    note: "Recorded, but a newer review of this PR replaced this one. Stop now.",
                }
            }
            const next = reviews.updateRun(id, {
                // a run failed for "no report" still takes a late report
                status: "reported",
                error: null,
                finished_at: null,
                reported_at: now(),
                verdict,
                issues: Number.isInteger(issues) ? issues : null,
                summary: summary ? String(summary).slice(0, 4000) : null,
            })
            emit()
            // close soon: the agent is usually idle right after reporting
            if (monitorTimer) clock.clearTimeout(monitorTimer)
            monitorTimer = null
            ensureMonitor(5000)
            return {
                ok: true,
                run_id: next.id,
                note: "Recorded. This session is closed once you are idle; stop now.",
            }
        })
    }

    /** "Review" / "Re-review" from the dashboard. */
    function requestReview(repo, number) {
        return serial(async () => {
            const pr = reviews.getPr(repo, number)
            if (!pr) throw new NotFoundError(`PR ${repo}#${number}`)
            if (pr.state !== "OPEN")
                throw new AppError(
                    "pr_not_open",
                    `PR ${repo}#${number} is not open`,
                    {
                        status: 409,
                    }
                )
            // its author's account is gone (a scan stored that): never
            // reviewed
            if (!pr.author)
                throw new AppError(
                    "pr_not_reviewable",
                    `PR ${repo}#${number} has no author any more`,
                    { status: 409 }
                )
            const active = reviews
                .runsByStatus(ACTIVE_RUN_STATUSES)
                .find((r) => r.repo === repo && r.number === Number(number))
            if (active) return active
            // a failed run left its agent open: close it first
            const last = reviews.latestRun(repo, number)
            if (last && last.workspace_id) await mustClose(last)
            const run = reviews.createRun({
                repo,
                number,
                kind: pr.decision ? "re_review" : "new",
                manual: true,
                head_sha: pr.head_sha,
            })
            emit()
            return run
        }).then((run) => {
            pump()
            return run
        })
    }

    /**
     * "Approve" from the dashboard: an approving review without a comment,
     * as the gh user, on headSha (the head the dashboard showed). Not
     * while a review run is open (its agent would decide too); every
     * finished run's leftover agent is closed first. All of it runs on the chain,
     * so no review is queued or started between the checks and the stored
     * approval; the GitHub part holds the repo lock (approveLive).
     */
    function approvePr(repo, number, headSha) {
        const n = Number(number)
        return serial(async () => {
            if (!reviews.getPr(repo, n))
                throw new NotFoundError(`PR ${repo}#${n}`)
            const refuse = (code, message) => {
                throw new AppError(code, `PR ${repo}#${n} ${message}`, {
                    status: 409,
                })
            }
            if (!headSha) refuse("pr_changed", "head commit not given")
            const active = reviews
                .runsByStatus(ACTIVE_RUN_STATUSES)
                .some((r) => r.repo === repo && r.number === n)
            if (active)
                refuse("review_running", "has a review run: cancel it first")
            // finished runs that left their agent open (a failed one kept
            // for a look, a refused close): none may decide later
            for (const left of reviews.prLeftOpen(repo, n))
                await mustClose(left)
            let fresh
            try {
                fresh = await withRepoLock(repo, () =>
                    approveLive(repo, n, headSha, refuse)
                )
            } finally {
                // a refusal may follow a fresh read: the page shows it
                emit()
            }
            if (!fresh) bg(scanRepo(repo), "review rescan")
            syncQueue(repo)
            emit()
            return { ok: true }
        }).then((out) => {
            pump()
            return out
        })
    }

    /**
     * The GitHub part of an approval (under the repo lock, so a scan in
     * progress has stored its read first and none overwrites ours):
     * read the live PR (a push since the last scan must not be approved
     * unseen), approve headSha, store the approval at once, read the PR
     * again. -> false when that last read failed (the stored approval
     * stands until the next scan). The review is on headSha even if a push
     * lands meanwhile: the owner approved what they saw.
     */
    async function approveLive(repo, n, headSha, refuse) {
        let live
        try {
            live = await fetchPr(repo, n)
        } catch (err) {
            throw new AppError(
                "pr_unreadable",
                `PR ${repo}#${n} could not be read from GitHub: ${errMessage(err)}`,
                { status: 502 }
            )
        }
        const pr = live.stored && live.stored.row
        if ((pr ? pr.state : live.node.state) !== "OPEN")
            refuse("pr_not_open", "is not open")
        if (!pr) refuse("pr_not_reviewable", "is not reviewed here")
        if (pr.head_sha !== headSha)
            refuse("pr_changed", "has new commits: reload and look again")
        const res = await gh.approvePr(repo, n, { headSha })
        storeApproval(repo, n, headSha, res)
        try {
            await fetchPr(repo, n)
            return true
        } catch (err) {
            log.warn(
                { err: errMessage(err), repo, number: n },
                "approve: PR not refreshed"
            )
            return false
        }
    }

    /**
     * Our approval as GitHub accepted it (res: the REST review), stored
     * the way a scan would: decided, nothing waits. Its node_id is the id
     * a scan stores the same review under.
     */
    function storeApproval(repo, number, headSha, res) {
        const pr = reviews.getPr(repo, number)
        const at = (res && res.submitted_at) || now()
        reviews.upsertPr({
            ...pr,
            decision: "approved",
            decided_at: at,
            decided_sha: headSha,
            first_review_at: pr.first_review_at || at,
            attempts: (pr.attempts || 0) + 1,
            needs_review: null,
            trigger_key: null,
        })
        if (res && res.node_id)
            reviews.addDecisions(repo, number, [
                {
                    id: res.node_id,
                    state: "APPROVED",
                    submittedAt: at,
                    commit: headSha,
                },
            ])
    }

    /** Cancel a queued run, or close a run's agent (running / failed). */
    function cancelRun(id) {
        return serial(async () => {
            const run = reviews.getRun(id)
            if (!run) throw new NotFoundError(`review run ${id}`)
            // handed over at a usage limit before this ran (the hand-over
            // and the cancel take turns on the chain): the cancel is meant
            // for the review, so it goes to the replacement
            const replacement = activeRetry(run)
            if (replacement) {
                await cancelOne(replacement)
                emit()
                return reviews.getRun(run.id)
            }
            const next = await cancelOne(run)
            emit()
            return next
        }).then((run) => {
            pump()
            return run
        })
    }

    /**
     * The active run a usage-limit retry chain from `run` ended in: each
     * limited attempt's replacement, followed while it failed at a limit
     * too (handed over again before the cancel). null: none active.
     */
    function activeRetry(run) {
        let cur = run
        const seen = new Set()
        while (
            cur &&
            cur.status === "failed" &&
            limitMarked(cur) &&
            !seen.has(cur.id)
        ) {
            seen.add(cur.id)
            const id = cur.id
            const active = reviews
                .runsByStatus(ACTIVE_RUN_STATUSES)
                .find((r) => r.retry_of === id)
            if (active) return active
            cur = reviews
                .runsByStatus(["failed"])
                .find((r) => r.retry_of === id)
        }
        return null
    }

    /** Cancel one run (on the chain): queued, running, or close its agent. */
    async function cancelOne(run) {
        let next = run
        if (run.status === "queued")
            next = finishRun(run, {
                status: "cancelled",
                error: CANCELLED_BY_OWNER,
            })
        else if (SLOT_RUN_STATUSES.includes(run.status)) {
            // a launch still in progress sees this and stops
            cancelling.add(run.id)
            try {
                await mustClose(run)
            } finally {
                cancelling.delete(run.id)
            }
            next = finishRun(run, {
                status: "cancelled",
                error: CANCELLED_BY_OWNER,
            })
        } else if (run.workspace_id) {
            await mustClose(run)
            next = reviews.getRun(run.id)
        }
        return next
    }

    async function focusRun(id) {
        const run = reviews.getRun(id)
        if (!run || !run.agent_name) throw new NotFoundError(`review run ${id}`)
        await herdr.agentFocus(run.agent_name)
        return { ok: true }
    }

    /** Every repo from the repo table with its tracking flags. */
    function listRepos() {
        const rows = new Map(reviews.listRepos().map((r) => [r.name, r]))
        const open = new Map()
        for (const p of reviews.listPrs())
            if (p.state === "OPEN")
                open.set(p.repo, (open.get(p.repo) || 0) + 1)
        const names = new Set([
            ...(repoTable ? repoTable.list() || [] : []).map((r) => r.name),
            ...rows.keys(),
        ])
        return [...names].sort().map((name) => {
            const r = rows.get(name) || {}
            return {
                name,
                description: (knownRepo(name) || {}).description || null,
                track: Boolean(r.track),
                auto_review: Boolean(r.auto_review),
                last_scan_at: r.last_scan_at || null,
                open: open.get(name) || 0,
                error: r.error || null,
            }
        })
    }

    function setRepo(name, flags) {
        if (!knownRepo(name) && !reviews.getRepo(name))
            throw new NotFoundError(`repo ${name}`)
        const before = reviews.getRepo(name)
        const after = reviews.setRepo(name, flags)
        // auto-review (or tracking) switched off: queued automatic runs go
        if (!after.auto_review)
            for (const r of reviews.runsByStatus(["queued"]))
                if (r.repo === name && !r.manual)
                    finishRun(r, {
                        status: "cancelled",
                        error: AUTO_OFF,
                    })
        emit()
        // newly tracked or auto-review switched on: scan now
        if (
            running &&
            after.track &&
            (!before ||
                !before.track ||
                (!before.auto_review && after.auto_review))
        )
            bg(scanRepo(name, { full: true }), "review scan")
        return listRepos().find((r) => r.name === name)
    }

    // ---- lifecycle -----------------------------------------------------

    function start() {
        if (running) return
        running = true
        loadLimits()
        wakeAtNextLimit()
        // a changed review agent / fallback may free the waiting queue
        if (bus && bus.subscribe)
            unsubscribe = bus.subscribe((ev) => {
                if (ev && ev.type === "settings.updated") {
                    // the page's agent / fallback label follows
                    emit()
                    pump()
                }
            })
        scanTimer = clock.setTimeout(scanTick, startDelayMs)
        ensureMonitor(startDelayMs)
        pump()
    }

    /**
     * Stop the timers and wait until no work is left: the chain, scans and
     * background launches (a chain step may add more of those).
     */
    async function stop() {
        running = false
        if (scanTimer) clock.clearTimeout(scanTimer)
        if (monitorTimer) clock.clearTimeout(monitorTimer)
        if (holdTimer) clock.clearTimeout(holdTimer)
        if (unsubscribe) unsubscribe()
        unsubscribe = null
        scanTimer = null
        monitorTimer = null
        holdTimer = null
        for (;;) {
            const tail = chain
            await Promise.allSettled([...scans.values(), ...background, tail])
            if (!scans.size && !background.size && chain === tail) return
        }
    }

    /** Wait for queued work (tests). */
    async function idle() {
        for (let i = 0; i < 10; i++) {
            await Promise.allSettled([...scans.values(), ...background])
            await chain
            if (!scans.size && !background.size) return
        }
    }

    return {
        start,
        stop,
        idle,
        scanRepo,
        scanAll,
        report,
        requestReview,
        approvePr,
        cancelRun,
        focusRun,
        listRepos,
        setRepo,
        settings: settingsView,
        whoami: () => me,
        monitorTick,
        pump,
    }
}
