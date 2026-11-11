/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Worker service: starts herdr workers for tasks, delivers prompts through
// the persistent outbox, follows agent status events, revives gone agents
// and runs the task-page actions. See docs/implementation/phase2-contracts.md
// (C) and docs/04-herdr-integration.md.
//
// Serialization: every herdr-facing operation of a task (start, revive,
// flush, status handling) runs on a per-task promise chain, so two
// deliveries/starts for one task never interleave. task.json read-modify-
// write goes through store.withTaskLock. Public methods take the chain;
// internal do*/flush helpers assume they already run on it.

import { enqueueOnce, errMessage } from "../agent/jobs/util.js"
import { currentRound, feedbackDedupeKey } from "../contracts/feedback.js"
import { canCreatePr, canTransition } from "../contracts/lifecycle.js"
import { WORKER_KINDS } from "../contracts/schemas.js"
import { systemClock } from "../util/clock.js"
import { AppError, NotFoundError, ValidationError } from "../util/errors.js"
import { nullLogger } from "../util/logger.js"
import { mcpLaunchArgs } from "./mcpArgs.js"
import {
    agentName,
    defaultBranch,
    folderName,
    truncateName,
} from "./identity.js"
import {
    cleanPrompt,
    createPrPrompt,
    feedbackPrompt,
    freshContextPrompt,
    kickoffPrompt,
    oneLine,
    orderedRepos,
    resumePrompt,
    sendToAgentPrompt,
} from "./prompts.js"

// Claude Code's own limit banners, at the start of a line (after box and
// bullet glyphs): "You've hit your usage limit · resets 5pm", "5-hour limit
// reached ∙ resets 3pm", "Claude AI usage limit reached|…", "Credit balance
// is too low", "API Error: 429 … rate_limit_error". The agent's own prose
// that mentions rate limits (e.g. a question about a gateway's per-IP rate
// limits) is not a banner and must not match.
export const USAGE_LIMIT_RE =
    /^[^\p{L}\p{N}]*(?:you['’]ve hit your (?:usage )?limit\b|you['’]re out of (?:extra )?usage\b|(?:claude(?: ai)?|5-hour|session|weekly|opus weekly|sonnet weekly)(?: usage)? limit reached\b|credit balance is too low\b|api error:.*\b(?:429|rate_limit_error)\b)/iu
export const BLOCKED_REASON = "Agent needs you (blocked)"
export const UNAVAILABLE_REASON = "Claude unavailable"
export const START_FAILED_REASON = "Agent failed to start"
export const PROMPT_FAILED_REASON = "Prompt not delivered"
export const UNCONFIRMED_REASON = "Agent prompt not confirmed"
export const UNCERTAIN_REASON = "Delivery uncertain"
// Now reason of cc_report(review) (mcp/tools.js)
export const REVIEW_REASON = "Ready for review"
export const ACTIONS = [
    "create-pr",
    "address-feedback",
    "clean",
    "close-agent",
    "focus",
    "send",
    "relaunch-codex",
    "stop",
    "retry",
    "cancel",
]
const START_STATUSES = ["inbox", "ready", "active"]
// agent states in which Leo may close its workspace
const IDLE_STATES = ["idle", "done"]
const SENDABLE = ["idle", "done"]
// agent_sessions.close_after: Close agent with "Clean folders" queued the
// clean-up prompt as outbox row <id>, recorded before it is sent:
// "clean:<id>", plus ":working" once the agent worked after it was sent.
// The workspace closes when it is idle again and the folders are gone.
export const CLEAN_LEFT_REASON = "Clean-up left folders; agent kept open"
// runtime setting (default on): a task that moves to done gets its agent's
// folders cleaned and its workspace closed (autoCloseOnDone)
export const AUTO_CLEAN_SETTING = "workers.auto_clean_on_done"

/** "clean:<id>[:working]" -> { rowId, working } or null. */
export function parseCloseAfter(value) {
    const m = /^clean:(\d+)(:working)?$/.exec(String(value || ""))
    return m ? { rowId: Number(m[1]), working: Boolean(m[2]) } : null
}
// A wait:true prompt that has not settled after this long is working: the
// agent took it (herdr reports agent_prompt_stalled within 5 s otherwise).
const CONFIRM_MS = 8000
// After a wait:false send, hold further sends until a status event arrives
// (or this long passes), so two prompts never land in one turn.
const SETTLE_MS = 15000
// A failed revive (herdr down) is retried by resync only after this long.
const REVIVE_BACKOFF_MS = 5 * 60 * 1000
// Usage-limit banners are at the bottom of the pane; only these lines count.
const USAGE_TAIL_LINES = 12
const WAIT_ACTION =
    "wait for my next message (it follows right after this one) and act on it"
const MAX_TEXT = 100000

function toId(raw) {
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0)
        throw new ValidationError("invalid task id", { id: raw })
    return n
}

/**
 * herdr answered with this error (server side), as opposed to a transport
 * failure. herdrClient puts herdr's error object into details; its own
 * timeouts and socket errors carry none.
 */
export function isServerError(err) {
    const d = err && err.details
    return Boolean(d && typeof d === "object" && (d.fromServer || d.code))
}

/** No reliable answer from herdr: the prompt may or may not have arrived. */
export function isTransportError(err) {
    if (!err) return false
    if (err.code === "socket") return true
    return err.code === "timeout" && !isServerError(err)
}

// Tasks that never get agent work again (revive, relaunch).
const CLOSED_STATUSES = ["done", "cancelled"]

/** A claimed PR not merged yet: the PR watcher keeps polling the task. */
function hasOpenPr(task) {
    return (task.deliverables || []).some(
        (d) => d.disposition === "pr" && d.pr && !d.merged_at
    )
}

function conflict(code, message, details) {
    return new AppError(code, message, { status: 409, details })
}

/**
 * @param {object} deps  see docs/implementation/phase2-contracts.md (C)
 * @param {string} [deps.localToken]  bearer token handed to workers (CC_TOKEN)
 * @param {number} [deps.confirmMs]   wait for kickoff/resume confirmation
 * @param {number} [deps.settleMs]
 * @param {number} [deps.reviveBackoffMs]
 * @param {number} [deps.tickMs]      periodic resync (default herdr.pollMs × 3)
 * @param {string|false} [deps.mcpHeadersHelper] headers helper for the
 *        worker's command-center MCP server (default install/mcp-headers.sh);
 *        false launches workers without the MCP flags
 */
export function createWorkerService({
    store,
    herdr,
    events,
    sessions,
    outbox,
    identity,
    settingsRepo,
    jobRunner,
    notifier,
    bus,
    config,
    clock = systemClock,
    log = nullLogger,
    localToken = "",
    confirmMs = CONFIRM_MS,
    settleMs = SETTLE_MS,
    reviveBackoffMs = REVIVE_BACKOFF_MS,
    tickMs,
    mcpHeadersHelper,
    // runs fn in one database transaction (outbox + sessions share the db);
    // fn must be synchronous
    transaction = (fn) => fn(),
}) {
    const herdrCfg = (config && config.herdr) || {}
    const treeDir = config.treeDir
    const localPort =
        (config.listeners &&
            config.listeners.local &&
            config.listeners.local.port) ||
        7788
    const tickEvery = tickMs ?? (herdrCfg.pollMs || 10000) * 3
    const now = () => clock.now().toISOString()
    /** Flags giving the worker the command-center MCP server (mcpArgs.js). */
    const mcpArgs = (kind) =>
        mcpHeadersHelper === false
            ? []
            : mcpLaunchArgs(kind, {
                  url: `http://127.0.0.1:${localPort}/mcp`,
                  ...(mcpHeadersHelper
                      ? { headersHelper: mcpHeadersHelper }
                      : {}),
              })

    const chains = new Map()
    const inflight = new Map() // taskId -> ms of the last wait:false send
    const blockedNotified = new Set() // session ids
    const limited = new Set() // session ids showing a usage-limit banner
    const reviveFailedAt = new Map() // taskId -> ms of the last failed revive
    const reviving = new Set() // task ids revived by reviveOrphans right now
    const background = new Set()
    let started = false
    let unsubscribeBus = null
    // PR watcher ({ addressFeedback }), bound after both exist (system.js)
    let feedbackDelivery = null
    function setFeedbackDelivery(fd) {
        feedbackDelivery =
            fd && typeof fd.addressFeedback === "function" ? fd : null
    }
    let timer = null
    let resyncing = null

    // ---- plumbing --------------------------------------------------------

    /** Run fn after every earlier operation of the task finished. */
    function serial(taskId, fn) {
        const prev = chains.get(taskId) || Promise.resolve()
        const run = prev.then(fn)
        const tail = run.catch(() => {})
        chains.set(taskId, tail)
        tail.then(() => {
            if (chains.get(taskId) === tail) chains.delete(taskId)
        })
        return run
    }

    /** Fire-and-forget with logging (event handlers). */
    let recovered = null // recover() promise

    function bg(promise, what) {
        const p = Promise.resolve(promise)
            .catch((err) =>
                log.warn({ err: errMessage(err) }, `worker ${what} failed`)
            )
            .finally(() => background.delete(p))
        background.add(p)
        return p
    }

    function emitState(taskId, state) {
        try {
            bus.emit("agent.updated", { task_id: taskId, data: { state } })
        } catch (err) {
            log.warn({ err: errMessage(err) }, "agent.updated listener failed")
        }
    }

    async function logEvent(taskId, type, data, actor = "system") {
        try {
            await store.appendEvent(taskId, { type, data }, actor)
        } catch (err) {
            log.warn({ err: errMessage(err), type }, "worker event not logged")
        }
    }

    async function patchFlags(taskId, flags, reason) {
        try {
            await store.updateTask(
                taskId,
                { flags },
                { actor: "system", reason }
            )
        } catch (err) {
            log.warn({ err: errMessage(err) }, "worker flags not updated")
        }
    }

    /**
     * The agent went back to work on a task waiting for Leo's review (he
     * answered it, or asked for more): it is not ready any more. review ->
     * active (pr_open when a claimed PR is still open, so the PR watcher
     * keeps polling it) and the "Ready for review" Now flag goes; the agent
     * reports review / ready_for_pr again when it is done.
     */
    async function leaveReview(taskId) {
        let left = null
        try {
            await store.withTaskLock(taskId, async () => {
                const { task } = await store.getTask(taskId)
                if (task.status !== "review") return
                const patch = { status: hasOpenPr(task) ? "pr_open" : "active" }
                const reason = String(
                    (task.flags && task.flags.now_reason) || ""
                )
                if (
                    task.flags &&
                    task.flags.now &&
                    reason.startsWith(REVIEW_REASON)
                )
                    patch.flags = { now: false, now_reason: null }
                await store.updateTask(taskId, patch, {
                    actor: "system",
                    reason: "agent working again",
                })
                left = {
                    to: patch.status,
                    now_reason: patch.flags ? reason : null,
                }
            })
        } catch (err) {
            log.warn({ err: errMessage(err), task: taskId }, "review not left")
            return null
        }
        if (left)
            await logEvent(taskId, "agent_resumed_work", { from: "review" })
        return left
    }

    /**
     * Undo leaveReview() when the agent could not be relaunched after all:
     * back to review unless the task moved on meanwhile. The "Ready for
     * review" Now flag comes back only when no other Now flag (e.g. the
     * launch failure) took its place.
     */
    async function restoreReview(taskId, left) {
        if (!left) return
        try {
            await store.withTaskLock(taskId, async () => {
                const { task } = await store.getTask(taskId)
                const f = task.flags || {}
                if (
                    task.status !== left.to ||
                    !canTransition(task.status, "review")
                )
                    return
                const patch = { status: "review" }
                if (left.now_reason && !f.now)
                    patch.flags = { now: true, now_reason: left.now_reason }
                await store.updateTask(taskId, patch, {
                    actor: "system",
                    reason: "agent relaunch failed",
                })
            })
        } catch (err) {
            log.warn(
                { err: errMessage(err), task: taskId },
                "review not restored"
            )
        }
    }

    /** Clear flags.now when it was set for `reason` (and nothing else). */
    async function clearNowIf(taskId, reason, extra = {}) {
        try {
            await store.withTaskLock(taskId, async () => {
                const { task } = await store.getTask(taskId)
                const f = task.flags || {}
                if (!f.now || !String(f.now_reason || "").startsWith(reason))
                    return
                await store.updateTask(
                    taskId,
                    { flags: { now: false, now_reason: null, ...extra } },
                    { actor: "system", reason: `${reason}: resolved` }
                )
            })
        } catch (err) {
            log.warn({ err: errMessage(err) }, "worker flags not cleared")
        }
    }

    async function notify(title, body) {
        if (!notifier) return
        try {
            await notifier.notify({ title, body, sound: "request" })
        } catch (err) {
            log.warn({ err: errMessage(err) }, "notification failed")
        }
    }

    async function retrack() {
        try {
            const live = await sessions.live()
            events.track(live.map((s) => s.pane_id).filter(Boolean))
        } catch (err) {
            log.warn({ err: errMessage(err) }, "herdr track failed")
        }
    }

    async function kindFor(task, kind) {
        let k = kind || task.worker_kind
        if (!k && settingsRepo) {
            try {
                k = await settingsRepo.get("workers.default_kind", null)
            } catch {
                k = null
            }
        }
        k = k || "claude"
        if (!WORKER_KINDS.includes(k))
            throw new ValidationError(`invalid worker kind: ${k}`)
        return k
    }

    function envFor(taskId) {
        return {
            CC_TASK_ID: String(taskId),
            CC_URL: `http://127.0.0.1:${localPort}`,
            CC_TOKEN: localToken || "",
        }
    }

    async function getAgent(name) {
        try {
            return await herdr.agentGet(name)
        } catch (err) {
            log.warn({ err: errMessage(err), name }, "herdr agent.get failed")
            return undefined // unknown (herdr unreachable), not "absent"
        }
    }

    /**
     * Is herdr's agent `info` (looked up by name) the one recorded in
     * `rec` (a session row)? Names can be reused by another agent, so the
     * pane decides when both sides know it (a resumed conversation may get a
     * new session id in the same pane); otherwise the session id, when both
     * know it. Nothing to compare: trusted.
     */
    function sameAgent(rec, info) {
        if (!rec || !info) return true
        if (rec.pane_id && info.paneId) return rec.pane_id === info.paneId
        if (rec.session_id && info.sessionId)
            return rec.session_id === info.sessionId
        return true
    }

    /** base, else base-2 … base-9 (first name herdr does not know). */
    async function freeName(base) {
        if ((await getAgent(base)) === null) return base
        const stem = truncateName(base, 29)
        for (let n = 2; n < 10; n++) {
            const name = `${stem}-${n}`
            if ((await getAgent(name)) === null) return name
        }
        throw conflict(
            "agent_name_taken",
            `no free herdr agent name for ${base}`
        )
    }

    /**
     * Prompt and wait briefly for the agent to take it. "confirmed" when it
     * finished or herdr's own wait expired (it went working); "stalled" when
     * herdr says it took the text but did not start working; "uncertain" on a
     * transport failure (no herdr answer). Other errors are thrown; never
     * retried.
     */
    async function submitConfirmed(name, text) {
        try {
            await herdr.agentPrompt(name, text, {
                wait: true,
                timeoutMs: confirmMs,
            })
            return "confirmed"
        } catch (err) {
            if (isTransportError(err)) return "uncertain"
            if (err && err.code === "timeout") return "confirmed"
            if (err && err.code === "agent_prompt_stalled") return "stalled"
            throw err
        }
    }

    async function flagUncertain(taskId, what, err) {
        await patchFlags(
            taskId,
            {
                error: `${UNCERTAIN_REASON} — check the agent (${what}: ${errMessage(err)})`,
                now: true,
                now_reason: UNCERTAIN_REASON,
            },
            "delivery uncertain"
        )
    }

    async function recordGone(taskId, base, error) {
        try {
            const row = await sessions.create({ ...base, state: "gone" })
            await sessions.end(row.id, "gone")
        } catch (err) {
            log.warn({ err: errMessage(err) }, "gone session not recorded")
        }
        await patchFlags(
            taskId,
            {
                error: `herdr: ${error}`,
                now: true,
                now_reason: START_FAILED_REASON,
            },
            "agent start failed"
        )
        emitState(taskId, "gone")
    }

    async function endSession(session, state = "gone") {
        await sessions.end(session.id, state)
        inflight.delete(session.task_id)
        limited.delete(session.id)
        blockedNotified.delete(session.id)
        emitState(session.task_id, state)
        await retrack()
    }

    async function folderInfo(task) {
        let folders = []
        try {
            folders = task.slug ? await identity.scanFolders(task.slug) : []
        } catch (err) {
            log.warn({ err: errMessage(err) }, "tree scan failed")
        }
        const names = folders.map((f) => f.folder)
        const main =
            folders.find((f) => f.role === "main") ||
            (orderedRepos(task)[0] &&
                folders.find((f) => f.repo === orderedRepos(task)[0].name))
        let mainFolder = main ? main.folder : null
        const repo = orderedRepos(task)[0]
        if (!mainFolder && repo && task.branch && task.slug)
            mainFolder = folderName({
                repo: repo.name,
                branch: task.branch,
                slug: task.slug,
            })
        return { names, mainFolder }
    }

    /**
     * Workspace + agent + first prompt. Failures after the workspace exists
     * record a gone session and flag the task; the workspace is never closed.
     */
    async function launch(taskId, task, opts) {
        const { kind, name, args = [], prompt, eventType, actor, data } = opts
        let ws
        try {
            ws = await herdr.workspaceCreate({
                cwd: treeDir,
                label: `T-${taskId} ${oneLine(task.title, 40)}`,
                env: envFor(taskId),
                focus: false,
            })
        } catch (err) {
            await patchFlags(
                taskId,
                {
                    error: `herdr: workspace create failed: ${errMessage(err)}`,
                    now: true,
                    now_reason: START_FAILED_REASON,
                },
                "agent start failed"
            )
            throw err
        }
        const base = {
            task_id: taskId,
            name,
            workspace_id: ws.workspaceId,
            pane_id: ws.paneId,
            kind,
            session_id: null,
        }
        let delivery
        try {
            await herdr.agentStart({
                name,
                kind,
                paneId: ws.paneId,
                args: [...mcpArgs(kind), ...args],
                timeoutMs: herdrCfg.startTimeoutMs,
            })
            delivery = await submitConfirmed(name, prompt)
        } catch (err) {
            await recordGone(taskId, base, errMessage(err))
            await logEvent(
                taskId,
                "agent_failed",
                { name, kind, error: errMessage(err) },
                actor
            )
            throw err
        }
        const info = await getAgent(name)
        const session = await sessions.create({
            ...base,
            session_id: (info && info.sessionId) || null,
            state:
                (info && info.status) ||
                (delivery === "confirmed" ? "working" : "unknown"),
        })
        const what = eventType === "agent_started" ? "kickoff" : "resume"
        if (delivery === "uncertain")
            await flagUncertain(taskId, `${what} prompt`, {
                message: "no answer from herdr",
            })
        if (delivery === "stalled")
            await patchFlags(
                taskId,
                {
                    error: `herdr: ${name} did not start working on the ${what} prompt; check the pane`,
                    now: true,
                    now_reason: UNCONFIRMED_REASON,
                },
                "agent prompt not confirmed"
            )
        try {
            await herdr.reportMetadata(ws.workspaceId, {
                task: `T-${taskId}`,
                status: "active",
            })
        } catch (err) {
            log.debug?.({ err: errMessage(err) }, "herdr metadata skipped")
        }
        await logEvent(
            taskId,
            eventType,
            {
                name,
                kind,
                workspace_id: ws.workspaceId,
                pane_id: ws.paneId,
                session_id: session.session_id,
                delivery,
                ...(data || {}),
            },
            actor
        )
        emitState(taskId, session.state)
        await retrack()
        return { session, delivery }
    }

    // ---- start -------------------------------------------------------------

    /** Launch delivery -> public status: "ok" | "stalled" | "uncertain". */
    function launchStatus(delivery) {
        return delivery === "confirmed" ? "ok" : delivery
    }

    async function doStart(id, { kind, actor = "system" } = {}) {
        const { task } = await store.getTask(id)
        if (
            !START_STATUSES.includes(task.status) ||
            !canTransition(task.status, "active")
        )
            throw conflict(
                "invalid_state",
                `T-${id} is ${task.status}; Start needs inbox, ready or active`,
                { status: task.status }
            )
        if (await sessions.current(id))
            throw conflict("agent_running", `T-${id} already has a live agent`)
        const repos = orderedRepos(task)
        if (!repos.length)
            throw conflict("no_repo", `T-${id} has no repos; set them first`)
        const k = await kindFor(task, kind)

        if (task.wants_asana && !(task.asana && task.asana.gid)) {
            try {
                enqueueOnce(jobRunner, "asana_create", id)
            } catch (err) {
                log.warn({ err: errMessage(err) }, "asana_create not queued")
            }
        }

        const slug = task.slug || (await identity.newSlug())
        const branch = task.branch || defaultBranch(task)
        const work = [
            repos[0].name,
            ...repos
                .slice(1)
                .filter((r) => r.role === "work")
                .map((r) => r.name),
        ]
        const warnings = []
        for (const repo of work) {
            const r = await identity.checkBranch(repo, branch, id)
            if (!r.ok)
                throw conflict("branch_conflict", r.reason, {
                    repo,
                    branch,
                    suggestion: r.suggestion ?? null,
                })
            if (r.warning) warnings.push(r.warning)
        }

        // The agent name needs herdr: pick it before the task changes, so a
        // failure here leaves the task as it was.
        const name = await freeName(agentName(task))

        let prevStatus = null
        const updated = await store.withTaskLock(id, async () => {
            const { task: cur } = await store.getTask(id)
            // re-check under the lock: the branch checks above are async and
            // Leo may have finished or cancelled the task meanwhile
            if (
                !START_STATUSES.includes(cur.status) ||
                !canTransition(cur.status, "active")
            )
                throw conflict(
                    "invalid_state",
                    `T-${id} is ${cur.status}; Start needs inbox, ready or active`,
                    { status: cur.status }
                )
            if (await sessions.current(id))
                throw conflict(
                    "agent_running",
                    `T-${id} already has a live agent`
                )
            prevStatus = cur.status
            const deliverables = [...(cur.deliverables || [])]
            for (const repo of work) {
                if (deliverables.some((d) => d.repo === repo)) continue
                deliverables.push({
                    repo,
                    branch,
                    role: "work",
                    created_at: now(),
                    disposition: "pending",
                    pr: null,
                    claimed_at: null,
                    merged_at: null,
                })
            }
            const r = await store.updateTask(
                id,
                {
                    slug,
                    branch,
                    deliverables,
                    worker_kind: k,
                    flags: { error: null },
                    // active BEFORE the kickoff goes out, so the worker can
                    // report review / ready_for_pr as soon as it starts
                    ...(cur.status !== "active" ? { status: "active" } : {}),
                },
                { actor, reason: "start" }
            )
            return r.task
        })

        let launched
        try {
            launched = await launch(id, updated, {
                kind: k,
                name,
                prompt: kickoffPrompt({
                    task: updated,
                    repos: orderedRepos(updated),
                    branch,
                    slug,
                    treeDir,
                }),
                eventType: "agent_started",
                actor,
                data: warnings.length ? { warnings } : undefined,
            })
        } catch (err) {
            // the worker never came up: undo "active", unless the task moved
            // on meanwhile (Leo or another path changed it). active -> inbox
            // is not a lifecycle move, so an inbox start rolls back to ready.
            // The launch error is what the caller sees, never a rollback one.
            if (prevStatus && prevStatus !== "active") {
                const back = canTransition("active", prevStatus)
                    ? prevStatus
                    : "ready"
                try {
                    await store.withTaskLock(id, async () => {
                        const { task: now2 } = await store.getTask(id)
                        if (now2.status === "active")
                            await store.updateTask(
                                id,
                                { status: back },
                                { actor, reason: "agent start failed" }
                            )
                    })
                } catch (rollbackErr) {
                    log.warn(
                        { err: errMessage(rollbackErr), task: id },
                        "start rollback failed"
                    )
                }
            }
            throw err
        }
        const { session, delivery } = launched
        return {
            session,
            warnings,
            delivery,
            status: launchStatus(delivery),
        }
    }

    // ---- revive ------------------------------------------------------------

    function resumeArgs(kind, sessionId) {
        return kind === "codex"
            ? ["resume", sessionId]
            : ["--resume", sessionId]
    }

    async function doRevive(id, opts = {}) {
        const {
            action,
            fresh = false,
            kind: kindOverride,
            actor = "system",
        } = opts
        const { task } = await store.getTask(id)
        const cur = await sessions.current(id)
        if (cur) {
            // Already live: an action is just a delivery.
            if (!action) return { session: cur, revived: false }
            await outbox.enqueue({
                task_id: id,
                text: action,
                reason: "revive",
            })
            const r = await flushTask(id, { revive: false })
            // every revive path reports { delivery, status, error? } alike
            return {
                session: cur,
                revived: false,
                delivery: r.status,
                status: r.status,
                ...(r.error ? { error: r.error } : {}),
            }
        }
        const kind = await kindFor(task, kindOverride)
        const history = [...((await sessions.history(id)) || [])].sort(
            (a, b) => b.id - a.id
        )
        const last = history[0] || null
        const base = agentName(task)
        const { names, mainFolder } = await folderInfo(task)

        // The agent this task launched still runs (session record was
        // stopped or lost): adopt it instead of starting a second one. Only
        // under the name it was recorded with (start may have used a
        // suffixed name because another agent held the base one) and, when
        // both are known, with the same herdr session id.
        const adoptName = (last && last.name) || base
        const existing = fresh ? null : await getAgent(adoptName)
        if (
            existing &&
            existing.kind === kind &&
            existing.paneId &&
            sameAgent(last, existing)
        ) {
            const session = await sessions.create({
                task_id: id,
                name: adoptName,
                workspace_id: existing.workspaceId ?? null,
                pane_id: existing.paneId,
                kind,
                session_id:
                    existing.sessionId ?? (last && last.session_id) ?? null,
                state: existing.status || "unknown",
            })
            await logEvent(
                id,
                "agent_adopted",
                { name: adoptName, kind },
                actor
            )
            emitState(id, session.state)
            await retrack()
            if (!action) return { session, revived: true, adopted: true }
            // more work for it: not ready for review any more (before the
            // prompt goes out, so its next review report is not undone)
            await leaveReview(id)
            await outbox.enqueue({
                task_id: id,
                text: resumePrompt({ task, folder: mainFolder, action }),
                reason: "revive",
            })
            const r = await flushTask(id, { revive: false })
            return {
                session,
                revived: true,
                adopted: true,
                delivery: r.status,
                status: r.status,
                ...(r.error ? { error: r.error } : {}),
            }
        }

        // A relaunched agent always gets work (an action, the message that
        // follows, or "continue"), and its session starts as working, so no
        // idle -> working transition will leave review later: do it now,
        // before the prompt goes out (undone if the launch fails).
        const left = await leaveReview(id)
        let name
        try {
            name = await freeName(base)
        } catch (err) {
            await restoreReview(id, left)
            throw err
        }
        const canResume = Boolean(
            !fresh && last && last.kind === kind && last.session_id
        )
        let prompt
        if (canResume) {
            prompt = resumePrompt({ task, folder: mainFolder, action })
        } else {
            const [artifact, feedback] = await Promise.all([
                store.getArtifact(id).catch(() => null),
                store.listFeedback
                    ? store.listFeedback(id).catch(() => [])
                    : [],
            ])
            prompt = freshContextPrompt({
                task,
                artifact,
                feedback,
                folders: names,
                treeDir,
            })
            if (action) prompt += `\n\nThen: ${String(action).trim()}`
        }
        let launched
        try {
            launched = await launch(id, task, {
                kind,
                name,
                args: canResume ? resumeArgs(kind, last.session_id) : [],
                prompt,
                eventType: "agent_revived",
                actor,
                data: { resumed: canResume },
            })
        } catch (err) {
            await restoreReview(id, left)
            throw err
        }
        const { session, delivery } = launched
        return {
            session,
            revived: true,
            resumed: canResume,
            delivery,
            status: launchStatus(delivery),
        }
    }

    // ---- outbox flush ------------------------------------------------------

    async function markBlocked(id, session) {
        if (blockedNotified.has(session.id)) return
        blockedNotified.add(session.id)
        await patchFlags(
            id,
            { now: true, now_reason: BLOCKED_REASON },
            "agent blocked"
        )
        let title = ""
        try {
            title = (await store.getTask(id)).task.title
        } catch {
            title = ""
        }
        await notify(`T-${id}: agent needs you`, title || BLOCKED_REASON)
        await logEvent(id, "agent_blocked", { name: session.name })
    }

    /**
     * Send the oldest pending prompt when the agent can take it.
     * -> { status: "empty"|"sent"|"queued"|"blocked"|"failed", outbox_id?, error? }
     */
    /**
     * Closed tasks get no queued work: a cancelled task drops every pending
     * prompt; a done task keeps only the explicit Clean prompt. Returns the
     * pending rows that may still be sent.
     */
    async function dropClosedWork(id, pending) {
        let task
        try {
            task = (await store.getTask(id)).task
        } catch {
            return pending
        }
        // the Clean prompt only fits a done task: one still queued when the
        // task was reopened is dropped too
        const open = task.status !== "cancelled" && task.status !== "done"
        if (open && !pending.some((r) => r.reason === "clean")) return pending
        const keep = (r) =>
            open
                ? r.reason !== "clean"
                : task.status === "done" && r.reason === "clean"
        const dropped = pending.filter((r) => !keep(r))
        for (const r of dropped) await outbox.cancel(r.id)
        if (dropped.length)
            await logEvent(id, "agent_prompts_dropped", {
                status: task.status,
                outbox_ids: dropped.map((r) => r.id),
                reasons: dropped.map((r) => r.reason),
            })
        return pending.filter(keep)
    }

    async function flushTask(id, { revive = true } = {}) {
        let revived = false
        for (let attempt = 0; attempt < 2; attempt++) {
            const pending = await dropClosedWork(id, await outbox.pending(id))
            if (!pending.length) return { status: "empty" }
            let session = await sessions.current(id)
            if (!session) {
                if (!revive || revived) return { status: "queued" }
                revived = true
                let r
                try {
                    r = await doRevive(id, { action: WAIT_ACTION })
                } catch (err) {
                    reviveFailedAt.set(id, clock.now().getTime())
                    throw err
                }
                reviveFailedAt.delete(id)
                session = r.session
                // Unknown whether the resume prompt landed: hold the queue.
                if (r.status === "uncertain") return { status: "queued" }
            }
            if (limited.has(session.id)) return { status: "queued" }
            const since = inflight.get(id)
            if (since !== undefined && clock.now().getTime() - since < settleMs)
                return { status: "queued" }
            const info = await getAgent(session.name)
            if (info === undefined) return { status: "queued" }
            // gone, or the name now belongs to another agent: never send
            // there; end the session (the next attempt revives safely)
            if (info === null || !sameAgent(session, info)) {
                await endSession(session, "gone")
                continue
            }
            const state = info.status || "unknown"
            if (state !== session.state) {
                await sessions.update(session.id, { state })
                emitState(id, state)
                if (state === "working") await leaveReview(id)
            }
            if (state === "blocked") {
                await markBlocked(id, session)
                return { status: "blocked" }
            }
            if (!SENDABLE.includes(state)) return { status: "queued" }

            const row = pending[0]
            // Persist "sending" before herdr gets the prompt: a crash mid-send
            // leaves the row 'sending', and startup fails it as uncertain
            // instead of sending it a second time.
            if (
                typeof outbox.markSending === "function" &&
                !(await outbox.markSending(row.id))
            )
                return { status: "queued" }
            try {
                await herdr.agentPrompt(session.name, row.text, { wait: false })
            } catch (err) {
                // herdr refused the prompt outright (nothing was submitted):
                // back to pending so a later flush can send it
                const refused = [
                    "agent_blocked",
                    "agent_not_ready",
                    "agent_not_found",
                ].includes(err && err.code)
                if (refused && typeof outbox.release === "function")
                    await outbox.release(row.id)
                if (err && err.code === "agent_blocked") {
                    await markBlocked(id, session)
                    return { status: "blocked" }
                }
                if (err && err.code === "agent_not_ready")
                    return { status: "queued" }
                if (err && err.code === "agent_not_found") {
                    await endSession(session, "gone")
                    continue
                }
                const msg = errMessage(err)
                if (isTransportError(err)) {
                    await outbox.markFailed(
                        row.id,
                        `delivery uncertain: ${msg}`
                    )
                    await flagUncertain(id, row.reason, err)
                    await logEvent(id, "agent_prompt_uncertain", {
                        outbox_id: row.id,
                        reason: row.reason,
                        error: msg,
                    })
                    return {
                        status: "uncertain",
                        outbox_id: row.id,
                        error: msg,
                    }
                }
                await outbox.markFailed(row.id, msg)
                await patchFlags(
                    id,
                    {
                        error: `${PROMPT_FAILED_REASON} (${row.reason}): ${msg}`,
                        now: true,
                        now_reason: PROMPT_FAILED_REASON,
                    },
                    "agent prompt failed"
                )
                await logEvent(id, "agent_prompt_failed", {
                    outbox_id: row.id,
                    reason: row.reason,
                    error: msg,
                })
                return { status: "failed", outbox_id: row.id, error: msg }
            }
            await outbox.markSent(row.id)
            inflight.set(id, clock.now().getTime())
            await logEvent(id, "agent_prompt_sent", {
                outbox_id: row.id,
                reason: row.reason,
                name: session.name,
            })
            return { status: "sent", outbox_id: row.id }
        }
        return { status: "queued" }
    }

    // ---- herdr events ------------------------------------------------------

    async function checkUsage(id, session) {
        let text
        try {
            text = await herdr.agentRead(session.name, { lines: 40 })
        } catch {
            return
        }
        const tail = String(text || "")
            .split(/\r?\n/)
            .filter((l) => l.trim())
            .slice(-USAGE_TAIL_LINES)
        const line = [...tail].reverse().find((l) => USAGE_LIMIT_RE.test(l))
        if (!line) {
            limited.delete(session.id)
            return
        }
        if (limited.has(session.id)) return
        limited.add(session.id)
        const msg = `${UNAVAILABLE_REASON}: ${oneLine(line, 200)}`
        await patchFlags(
            id,
            { error: msg, now: true, now_reason: UNAVAILABLE_REASON },
            "claude unavailable"
        )
        await notify(`T-${id}: ${UNAVAILABLE_REASON}`, msg)
        await logEvent(id, "agent_unavailable", {
            name: session.name,
            line: oneLine(line, 200),
        })
    }

    async function applyStatus(id, sessionId, status) {
        const s = await sessions.current(id)
        if (!s || s.id !== sessionId) return
        const prev = s.state
        inflight.delete(id)
        await sessions.update(s.id, { state: status })
        if (status !== prev) emitState(id, status)
        if (prev === "blocked" && status !== "blocked") {
            blockedNotified.delete(s.id)
            await clearNowIf(id, BLOCKED_REASON)
        }
        if (status === "working") limited.delete(s.id)
        if (status === "working" && prev !== "working") await leaveReview(id)
        if (status === "blocked") await markBlocked(id, s)
        if (s.kind === "claude" && (status === "blocked" || status === "idle"))
            await checkUsage(id, s)
        if (s.close_after && (await settleCloseAfter(id, s, status))) return
        if (SENDABLE.includes(status)) await flushTask(id, { revive: false })
    }

    /**
     * A pending close (Close agent + Clean folders, or the automatic one
     * after done) on a task that is no longer done (reopened, e.g. after a
     * mistaken Done): cancel its clean-up prompt if still queued, clear the
     * mark, log agent_close_cancelled. True when it dropped the close. A
     * task that can't be read keeps it.
     */
    async function dropCloseIfReopened(id, s) {
        if (!s || !s.close_after) return false
        let task
        try {
            task = (await store.getTask(id)).task
        } catch {
            return false
        }
        if (task.status === "done") return false
        const mark = parseCloseAfter(s.close_after)
        const row = mark ? await outbox.byId(mark.rowId) : null
        if (row && row.status === "pending") await outbox.cancel(row.id)
        await sessions.update(s.id, { close_after: null })
        await logEvent(id, "agent_close_cancelled", {
            name: s.name,
            reason: `task is ${task.status}`,
            prompt: row
                ? row.status === "pending"
                    ? "cancelled"
                    : row.status
                : "missing",
        })
        return true
    }

    /**
     * Close after clean (on the task chain): "working" marks that the agent
     * took the clean-up turn; once it is idle again with the prompt
     * delivered, the workspace closes if the task's folders are gone. Folders
     * left after it worked mean the agent stopped (uncommitted or unpushed
     * work): the workspace stays open, Now is raised. Returns true when the
     * workspace was closed.
     */
    async function settleCloseAfter(id, s, status) {
        // the task was reopened meanwhile: no clean-up, no close
        if (await dropCloseIfReopened(id, s)) return false
        const mark = parseCloseAfter(s.close_after)
        const row = mark ? await outbox.byId(mark.rowId) : null
        // the clean-up prompt never reached the agent (failed, cancelled,
        // gone): no close
        if (!row || ["failed", "cancelled"].includes(row.status)) {
            await sessions.update(s.id, { close_after: null })
            await logEvent(id, "agent_close_cancelled", {
                name: s.name,
                prompt: row ? row.status : "missing",
            })
            return false
        }
        if (row.status !== "sent") return false
        if (status === "working") {
            if (!mark.working)
                await sessions.update(s.id, {
                    close_after: `clean:${mark.rowId}:working`,
                })
            return false
        }
        // only an idle agent that worked since the prompt was sent is done
        if (!SENDABLE.includes(status) || !mark.working) return false
        let left
        try {
            const { task } = await store.getTask(id)
            left =
                task.slug && identity && identity.scanFolders
                    ? (await identity.scanFolders(task.slug, {
                          strict: true,
                      })) || []
                    : []
        } catch (err) {
            log.warn({ err: errMessage(err), task: id }, "close after clean")
            return false
        }
        if (!left.length) {
            try {
                await closeWorkspace(id, s, "system", { after: "clean" })
                return true
            } catch (err) {
                log.warn(
                    { err: errMessage(err), task: id },
                    "close after clean: workspace close failed"
                )
                return false
            }
        }
        await sessions.update(s.id, { close_after: null })
        const folders = left.map((f) => f.folder)
        await patchFlags(
            id,
            { now: true, now_reason: CLEAN_LEFT_REASON },
            "clean left folders"
        )
        await notify(`T-${id}: ${CLEAN_LEFT_REASON}`, folders.join(", "))
        await logEvent(id, "agent_close_skipped", { name: s.name, folders })
        return false
    }

    async function handleStatus({ paneId, status }) {
        if (!paneId || !status) return
        const s = await sessions.byPane(paneId)
        if (!s) return
        await serial(s.task_id, () => applyStatus(s.task_id, s.id, status))
    }

    async function endIfLive(sessionId, taskId) {
        const cur = await sessions.current(taskId)
        if (!cur || cur.id !== sessionId) return
        await endSession(cur, "gone")
        await logEvent(taskId, "agent_gone", { name: cur.name })
    }

    async function handleExited({ paneId }) {
        const s = await sessions.byPane(paneId)
        if (!s) return
        await serial(s.task_id, () => endIfLive(s.id, s.task_id))
    }

    async function handleClosed({ workspaceId }) {
        const live = await sessions.live()
        for (const s of live.filter((x) => x.workspace_id === workspaceId))
            await serial(s.task_id, () => endIfLive(s.id, s.task_id))
    }

    /**
     * Tasks with pending prompts but no live agent (e.g. revive failed while
     * herdr was down): revive and flush, at most once per resync per task and
     * only when the last failed revive is older than reviveBackoffMs. Done /
     * cancelled tasks are skipped (done only for a pending Clean).
     */
    async function reviveOrphans() {
        let rows
        try {
            rows = (await outbox.pending()) || []
        } catch (err) {
            log.warn({ err: errMessage(err) }, "outbox scan failed")
            return
        }
        const byTask = new Map()
        for (const r of rows) {
            if (!byTask.has(r.task_id)) byTask.set(r.task_id, [])
            byTask.get(r.task_id).push(r)
        }
        const nowMs = clock.now().getTime()
        for (const [taskId, pending] of byTask) {
            if (reviving.has(taskId)) continue
            const failedAt = reviveFailedAt.get(taskId)
            if (failedAt !== undefined && nowMs - failedAt < reviveBackoffMs)
                continue
            if (await sessions.current(taskId)) continue
            let task
            try {
                task = (await store.getTask(taskId)).task
            } catch {
                continue
            }
            const cleanOnly =
                task.status === "done" &&
                pending.some((r) => r.reason === "clean")
            if (["done", "cancelled"].includes(task.status) && !cleanOnly)
                continue
            reviving.add(taskId)
            try {
                await serial(taskId, () => flushTask(taskId))
            } catch (err) {
                log.warn(
                    { err: errMessage(err), task: taskId },
                    "revive for queued prompts failed"
                )
            } finally {
                reviving.delete(taskId)
            }
        }
    }

    /** Reconcile live sessions with herdr's agent list; flush idle ones. */
    function resync() {
        if (resyncing) return resyncing
        resyncing = (async () => {
            let list
            try {
                list = await herdr.agentList()
            } catch (err) {
                log.warn({ err: errMessage(err) }, "herdr resync failed")
                return
            }
            const byPane = new Map(
                (list || []).filter((a) => a.paneId).map((a) => [a.paneId, a])
            )
            for (const s of await sessions.live()) {
                const a = byPane.get(s.pane_id)
                try {
                    // herdr may learn the agent's session id after launch
                    // (or the post-launch agentGet failed): keep it, so a
                    // later revive resumes the conversation.
                    if (
                        a &&
                        (!a.name || a.name === s.name) &&
                        a.sessionId &&
                        a.sessionId !== s.session_id
                    )
                        await sessions.update(s.id, {
                            session_id: a.sessionId,
                        })
                    // the pane now runs an agent under another name: ours
                    // is gone
                    if (!a || (a.name && a.name !== s.name)) {
                        await serial(s.task_id, () =>
                            endIfLive(s.id, s.task_id)
                        )
                    } else if (a.status && a.status !== s.state) {
                        await handleStatus({
                            paneId: s.pane_id,
                            status: a.status,
                        })
                    } else if (SENDABLE.includes(a.status)) {
                        await serial(s.task_id, async () => {
                            // a pending close whose idle event was missed
                            // (e.g. while the service was down)
                            if (
                                s.close_after &&
                                (await settleCloseAfter(s.task_id, s, a.status))
                            )
                                return
                            await flushTask(s.task_id, { revive: false })
                        })
                    }
                } catch (err) {
                    log.warn(
                        { err: errMessage(err), task: s.task_id },
                        "resync of a session failed"
                    )
                }
            }
            await reviveOrphans()
        })().finally(() => {
            resyncing = null
        })
        return resyncing
    }

    const listeners = {
        status: (ev) => bg(handleStatus(ev || {}), "status"),
        exited: (ev) => bg(handleExited(ev || {}), "exited"),
        closed: (ev) => bg(handleClosed(ev || {}), "closed"),
        resync: () => bg(resync(), "resync"),
    }

    function scheduleTick() {
        if (!started || !tickEvery) return
        timer = clock.setTimeout(async () => {
            timer = null
            await bg(resync(), "tick")
            scheduleTick()
        }, tickEvery)
    }

    // ---- public ------------------------------------------------------------

    /** Prompts cut off by a restart mid-send: uncertain, explicit Retry. */
    async function recoverInterrupted() {
        if (typeof outbox.recoverInterrupted !== "function") return
        for (const row of await outbox.recoverInterrupted()) {
            await flagUncertain(
                row.task_id,
                row.reason,
                new Error("interrupted while sending")
            )
            await logEvent(row.task_id, "agent_prompt_uncertain", {
                outbox_id: row.id,
                reason: row.reason,
                error: row.error,
            })
        }
    }

    /**
     * Fail prompts left 'sending' by a crash (once per process). Must run
     * before anything can send (scheduler, PR watcher, HTTP): a live
     * delivery in 'sending' would otherwise be failed as interrupted.
     * system.start() calls it first; start() awaits the same promise.
     */
    function recover() {
        if (!recovered)
            recovered = bg(recoverInterrupted(), "interrupted prompts")
        return recovered
    }

    async function start() {
        if (started) return
        started = true
        await recover()
        for (const [name, fn] of Object.entries(listeners)) events.on(name, fn)
        if (bus && typeof bus.subscribe === "function")
            unsubscribeBus = bus.subscribe(onBusEvent)
        await retrack()
        if (typeof events.start === "function") events.start()
        await bg(resync(), "startup resync")
        scheduleTick()
    }

    async function stop() {
        if (!started) return
        started = false
        for (const [name, fn] of Object.entries(listeners)) events.off(name, fn)
        if (unsubscribeBus) unsubscribeBus()
        unsubscribeBus = null
        if (timer !== null) clock.clearTimeout(timer)
        timer = null
        if (typeof events.stop === "function") events.stop()
        await idle()
    }

    /** Resolves when queued handlers and per-task chains are done. */
    async function idle() {
        for (let i = 0; i < 20; i++) {
            const work = [...background, ...chains.values()]
            if (!work.length) return
            await Promise.allSettled(work)
        }
    }

    async function startTask(taskId, opts = {}) {
        const id = toId(taskId)
        return serial(id, () => doStart(id, opts))
    }

    /**
     * Relaunch the task's agent. A done / cancelled task is never relaunched
     * here (the scheduler's launch_agent may fire after the task closed):
     * returns { skipped: true, status: "skipped", reason } instead.
     */
    async function revive(taskId, opts = {}) {
        const id = toId(taskId)
        return serial(id, async () => {
            const { task } = await store.getTask(id)
            if (CLOSED_STATUSES.includes(task.status))
                return {
                    skipped: true,
                    status: "skipped",
                    reason: `task is ${task.status}`,
                }
            return doRevive(id, opts)
        })
    }

    async function deliver(
        taskId,
        text,
        { reason = "prompt", dedupeKey } = {}
    ) {
        const id = toId(taskId)
        if (typeof text !== "string" || !text.trim())
            throw new ValidationError("prompt text is required")
        if (text.length > MAX_TEXT)
            throw new ValidationError("prompt text too long")
        await store.getTask(id)
        const row = await outbox.enqueue({
            task_id: id,
            text,
            reason,
            dedupe_key: dedupeKey ?? null,
        })
        if (row.status && row.status !== "pending")
            return { status: row.status, outbox_id: row.id, duplicate: true }
        return sendQueued(id, row)
    }

    /** Flush the task now and report what happened to this queued row. */
    async function sendQueued(id, row) {
        let res
        try {
            res = await serial(id, () => flushTask(id))
        } catch (err) {
            log.warn({ err: errMessage(err), task: id }, "delivery deferred")
            return {
                status: "queued",
                outbox_id: row.id,
                error: errMessage(err),
            }
        }
        if (
            res.outbox_id === row.id &&
            (res.status === "failed" || res.status === "uncertain")
        )
            return { status: res.status, outbox_id: row.id, error: res.error }
        if (res.outbox_id === row.id && res.status === "sent")
            return { status: "sent", outbox_id: row.id }
        if (res.status === "blocked")
            return { status: "blocked", outbox_id: row.id }
        return { status: "queued", outbox_id: row.id }
    }

    function requireStatus(task, statuses, what) {
        if (!statuses.includes(task.status))
            throw conflict(
                "invalid_state",
                `${what} needs status ${statuses.join(" or ")} (T-${task.id} is ${task.status})`,
                { status: task.status }
            )
    }

    /** Deliver unless the same kind of prompt is already queued. */
    async function deliverOnce(id, text, reason) {
        const dup = (await outbox.pending(id)).find((r) => r.reason === reason)
        if (dup) return { status: "queued", outbox_id: dup.id, duplicate: true }
        return deliver(id, text, { reason })
    }

    /**
     * "Address feedback": per PR, the OLDEST round with open actionable items
     * (later rounds wait for it). A prompt already queued under the shared
     * dedupe key is reused; a never-delivered round is sent under that key
     * (so the watcher will not send it again); a round already delivered is
     * re-sent without a key (Leo asked for it explicitly).
     */
    async function feedbackDeliveries(task) {
        const all = (await store.listFeedback(task.id)) || []
        const prs = [
            ...new Set(
                all
                    .filter((i) => i.status === "open" && i.actionable)
                    .map((i) => i.pr)
            ),
        ]
        if (!prs.length)
            throw conflict(
                "no_open_feedback",
                `T-${task.id} has no open feedback`
            )
        const rows = await outbox.list(task.id, { limit: 500 })
        const out = []
        for (const pr of prs) {
            const round = currentRound(all, pr)
            const items = all.filter(
                (i) =>
                    i.pr === pr &&
                    i.round === round &&
                    i.status === "open" &&
                    i.actionable
            )
            let key = null
            try {
                key = feedbackDedupeKey(pr, round)
            } catch {
                key = null
            }
            const prior = key && rows.find((r) => r.dedupe_key === key)
            if (prior && prior.status === "pending") {
                out.push({
                    status: "queued",
                    outbox_id: prior.id,
                    duplicate: true,
                })
                continue
            }
            const d = (task.deliverables || []).find((x) => x.pr === pr)
            const text = feedbackPrompt({
                task,
                pr,
                round,
                items,
                branch: (d && d.branch) || task.branch,
            })
            out.push(
                await deliver(task.id, text, {
                    reason: "pr_feedback",
                    dedupeKey: prior ? undefined : (key ?? undefined),
                })
            )
        }
        return out
    }

    function parseBody(body) {
        const b = body && typeof body === "object" ? body : {}
        const text = typeof b.text === "string" ? b.text.trim() : ""
        const quote = typeof b.quote === "string" ? b.quote.trim() : ""
        return { ...b, text, quote }
    }

    async function outboxRow(id, rawRowId, status) {
        const rowId = Number(rawRowId)
        if (!Number.isInteger(rowId) || rowId <= 0)
            throw new ValidationError("outbox id required")
        const row = await outbox.byId(rowId)
        if (!row || row.task_id !== id || row.status !== status)
            throw new NotFoundError(`${status} prompt ${rowId}`)
        return row
    }

    /**
     * The task's live agent, checked to be ours and idle (on the chain).
     * busyOk: any state will do (the automatic clean-up after done queues
     * its prompt for when the agent is idle).
     */
    async function idleAgent(id, { busyOk = false } = {}) {
        const cur = await sessions.current(id)
        if (!cur) throw conflict("no_agent", `T-${id} has no live agent`)
        const info = await herdr.agentGet(cur.pane_id || cur.name)
        const replaced = info && info.name && cur.name && info.name !== cur.name
        if (!info || !sameAgent(cur, info) || replaced)
            throw conflict(
                "agent_not_found",
                `${cur.name} is not running in its pane any more; close the workspace in herdr if you want it gone`
            )
        if (!busyOk && !IDLE_STATES.includes(info.status))
            throw conflict(
                "agent_busy",
                `${cur.name} is ${info.status}; close it when it is idle`,
                { state: info.status }
            )
        return cur
    }

    /** Close the session's herdr workspace and end it (on the chain). */
    async function closeWorkspace(id, cur, actor, extra = {}) {
        await herdr.workspaceClose(cur.workspace_id)
        await endSession(cur, "gone")
        await logEvent(
            id,
            "agent_closed",
            {
                name: cur.name,
                workspace_id: cur.workspace_id,
                pane_id: cur.pane_id,
                ...extra,
            },
            actor
        )
        // a closed workspace is no longer "kept open" (e.g. a second Clean
        // and close that removed the folders the first one left)
        await clearNowIf(id, CLEAN_LEFT_REASON)
        return { closed: true, workspace_id: cur.workspace_id }
    }

    /**
     * Close agent + Clean folders: queue the clean-up prompt, mark the
     * session close_after "clean:<outbox id>", then send it; settleCloseAfter
     * closes the workspace when that turn is over. A prompt that was not
     * delivered (failed / blocked, or later failed / cancelled) cancels it.
     * auto (after done, autoCloseOnDone): the agent may be busy, and a
     * blocked one keeps the prompt queued (sent, then closed, once it is
     * idle); only a failed prompt cancels.
     */
    async function closeAfterClean(id, task, actor, { auto = false } = {}) {
        requireStatus(task, ["done"], "Clean folders")
        if (!task.slug)
            throw conflict("no_slug", `T-${id} has no folders to clean`)
        // Queue the prompt and record its row on the task chain: no flush
        // can send it before the session knows which row to wait for.
        const { cur, row, duplicate } = await serial(id, async () => {
            const c = await idleAgent(id, { busyOk: auto })
            const dup = ((await outbox.pending(id)) || []).find(
                (r) => r.reason === "clean"
            )
            // the prompt row and the marker commit together (a restart
            // never leaves one without the other)
            const r = transaction(() => {
                const queued =
                    dup ||
                    outbox.enqueue({
                        task_id: id,
                        text: cleanPrompt({ task }),
                        reason: "clean",
                        dedupe_key: null,
                    })
                sessions.update(c.id, { close_after: `clean:${queued.id}` })
                return queued
            })
            return { cur: c, row: r, duplicate: Boolean(dup) }
        })
        const closeAfter = `clean:${row.id}`
        const delivery = duplicate
            ? { status: "queued", outbox_id: row.id, duplicate: true }
            : await sendQueued(id, row)
        const cancels = auto ? ["failed"] : ["failed", "blocked"]
        if (cancels.includes(delivery.status)) {
            await sessions.update(cur.id, { close_after: null })
            return { delivery, close_after: null }
        }
        await logEvent(
            id,
            "agent_close_requested",
            {
                name: cur.name,
                after: "clean",
                outbox_id: delivery.outbox_id,
                ...(auto ? { auto: true } : {}),
            },
            actor
        )
        return { delivery, close_after: closeAfter }
    }

    const SKIP_CODES = ["no_agent", "agent_not_found", "agent_busy"]

    /**
     * The task moved to done (close-out by the PR watcher or the Close out
     * button, or a plain Done): with the setting AUTO_CLEAN_SETTING (default
     * on) its agent cleans its folders and its workspace closes, as with
     * Close agent + Clean folders. A busy agent gets the clean-up prompt
     * when it is idle. Without folders (no slug) an idle agent is just
     * closed. No live agent, or a close already pending: nothing to do. An
     * agent that can't be reached is skipped with an activity event.
     * @returns {Promise<object>} what happened (tests, logs)
     */
    async function autoCloseOnDone(taskId) {
        const id = toId(taskId)
        if (
            settingsRepo &&
            (await settingsRepo.get(AUTO_CLEAN_SETTING, true)) === false
        )
            return { skipped: "disabled" }
        const { task } = await store.getTask(id)
        if (task.status !== "done") return { skipped: "status" }
        const cur = await sessions.current(id)
        if (!cur) return { skipped: "no_agent" }
        if (cur.close_after) return { skipped: "close_pending" }
        try {
            if (task.slug)
                return await closeAfterClean(id, task, "system", {
                    auto: true,
                })
            return await serial(id, async () =>
                closeWorkspace(id, await idleAgent(id), "system", {
                    after: "done",
                })
            )
        } catch (err) {
            if (!SKIP_CODES.includes(err && err.code)) throw err
            await logEvent(id, "agent_auto_close_skipped", {
                name: cur.name,
                reason: errMessage(err),
            })
            return { skipped: err.code }
        }
    }

    /**
     * A task that left done (reopened): drop a pending close and a Clean
     * prompt still queued, so neither runs on the reopened task.
     */
    async function cancelCleanOnReopen(taskId) {
        const id = toId(taskId)
        await serial(id, async () => {
            await dropCloseIfReopened(id, await sessions.current(id))
            const pending = (await outbox.pending(id)) || []
            if (pending.some((r) => r.reason === "clean"))
                await dropClosedWork(id, pending)
        })
    }

    /**
     * bus listener for task status changes: to done -> autoCloseOnDone;
     * to anything else -> cancelCleanOnReopen.
     */
    function onBusEvent(ev) {
        if (!ev || ev.type !== "task.updated" || !ev.data) return
        const { task, changed } = ev.data
        if (!task || !(changed || []).includes("status")) return
        if (task.status === "done")
            bg(autoCloseOnDone(ev.task_id), "auto close after done")
        else bg(cancelCleanOnReopen(ev.task_id), "cancel clean on reopen")
    }

    async function action(taskId, name, body, { actor = "system" } = {}) {
        const id = toId(taskId)
        if (!ACTIONS.includes(name)) throw new NotFoundError(`action ${name}`)
        const { task } = await store.getTask(id)
        const b = parseBody(body)
        let result = {}
        switch (name) {
            case "create-pr":
                if (!canCreatePr(task))
                    throw conflict(
                        "invalid_state",
                        `Create PR needs status ready_for_pr, or a PR state with a repo still without a PR (T-${id} is ${task.status})`,
                        { status: task.status }
                    )
                result.delivery = await deliverOnce(
                    id,
                    createPrPrompt({ task }),
                    "create_pr"
                )
                break
            case "address-feedback": {
                // The PR watcher owns the round queue (seals rounds, sends the
                // oldest first): go through it when it is wired.
                if (feedbackDelivery) {
                    const r = await feedbackDelivery.addressFeedback(id)
                    result = {
                        delivery: r.delivery,
                        round: r.round,
                        resent: r.resent,
                    }
                    break
                }
                const deliveries = await feedbackDeliveries(task)
                result = { delivery: deliveries[0], deliveries }
                break
            }
            case "clean":
                requireStatus(task, ["done"], "Clean folders")
                if (!task.slug)
                    throw conflict("no_slug", `T-${id} has no folders to clean`)
                result.delivery = await deliverOnce(
                    id,
                    cleanPrompt({ task }),
                    "clean"
                )
                break
            case "close-agent":
                // Leo closes the agent's herdr workspace, only while the
                // agent sits idle (never mid-work or at a dialog). With
                // clean: the clean-up prompt first, the close once it is done.
                if (b.clean === true) {
                    result = await closeAfterClean(id, task, actor)
                    break
                }
                result = await serial(id, async () =>
                    closeWorkspace(id, await idleAgent(id), actor)
                )
                break
            case "focus": {
                const cur = await sessions.current(id)
                if (!cur)
                    throw conflict("no_agent", `T-${id} has no live agent`)
                await herdr.agentFocus(cur.name)
                break
            }
            case "send":
                if (!b.text) throw new ValidationError("text is required")
                if (b.text.length > 20000 || b.quote.length > 5000)
                    throw new ValidationError("text too long")
                result.delivery = await deliver(
                    id,
                    sendToAgentPrompt({
                        task,
                        quote: b.quote || null,
                        comment: b.text,
                    }),
                    { reason: "send" }
                )
                break
            case "relaunch-codex":
                result = await serial(id, async () => {
                    // re-read under the queue: a closed task gets no worker
                    const cur0 = (await store.getTask(id)).task
                    if (CLOSED_STATUSES.includes(cur0.status))
                        throw conflict(
                            "task_closed",
                            `T-${id} is ${cur0.status}; no agent is relaunched`
                        )
                    await store.updateTask(
                        id,
                        { worker_kind: "codex" },
                        { actor, reason: "relaunch on codex" }
                    )
                    await clearNowIf(id, UNAVAILABLE_REASON, { error: null })
                    const cur = await sessions.current(id)
                    if (cur) await endSession(cur, "gone")
                    const r = await doRevive(id, {
                        fresh: true,
                        kind: "codex",
                        action: b.text || undefined,
                        actor,
                    })
                    return { session: r.session }
                })
                break
            case "stop":
                result = await serial(id, async () => {
                    const cur = await sessions.current(id)
                    if (cur) await endSession(cur, "gone")
                    return { stopped: Boolean(cur) }
                })
                break
            case "retry": {
                const row = await outboxRow(id, b.id, "failed")
                if (typeof outbox.requeue === "function") {
                    await outbox.requeue(row.id)
                    const res = await serial(id, () => flushTask(id))
                    result.delivery =
                        res.outbox_id === row.id
                            ? res
                            : { status: "queued", outbox_id: row.id }
                } else {
                    result.delivery = await deliver(id, row.text, {
                        reason: row.reason,
                    })
                }
                // only a retry that went out (or is queued) clears the flag,
                // and only when no other failed prompt is left
                const st = result.delivery && result.delivery.status
                const failedLeft = (await outbox.failed(id)).length > 0
                if (["sent", "queued"].includes(st) && !failedLeft)
                    await clearNowIf(id, PROMPT_FAILED_REASON)
                break
            }
            case "cancel": {
                const row = await outboxRow(id, b.id, "pending")
                result.cancelled = Boolean(await outbox.cancel(row.id))
                break
            }
        }
        await logEvent(id, "agent_action", { action: name }, actor)
        return { ok: true, ...result }
    }

    /**
     * Cancel the task's queued (not yet sent) prompts whose dedupe key
     * matches `match` (e.g. feedback for a PR that merged meanwhile).
     * @returns {Promise<number[]>} cancelled outbox ids
     */
    async function dropQueued(taskId, match, data = {}) {
        const id = toId(taskId)
        return serial(id, async () => {
            const rows = (await outbox.pending(id)).filter((r) =>
                match(r.dedupe_key || "")
            )
            const ids = []
            for (const r of rows) if (await outbox.cancel(r.id)) ids.push(r.id)
            if (ids.length)
                await logEvent(id, "agent_prompts_dropped", {
                    ...data,
                    outbox_ids: ids,
                })
            return ids
        })
    }

    async function agentState(taskId) {
        const id = toId(taskId)
        const cur = await sessions.current(id)
        let s = cur
        if (!s) {
            const hist = (await sessions.history(id)) || []
            s = [...hist].sort((a, b) => b.id - a.id)[0] || null
        }
        if (!s) return null
        const pending = await outbox.pending(id)
        return {
            state: cur ? cur.state : "gone",
            kind: s.kind,
            name: s.name,
            session_id: s.session_id ?? null,
            pane_id: s.pane_id ?? null,
            workspace_id: s.workspace_id ?? null,
            started_at: s.started_at ?? null,
            last_seen_at: s.last_seen_at ?? null,
            limited: Boolean(cur && limited.has(cur.id)),
            outbox: pending.length,
        }
    }

    async function queued(taskId) {
        return outbox.pending(toId(taskId))
    }

    /**
     * Prompts Leo can act on, oldest first: pending ones (Cancel) and failed
     * ones (Retry). Failed prompts are never resent automatically, so they
     * must stay visible until retried or cancelled.
     */
    async function outboxView(taskId) {
        const id = toId(taskId)
        const pending = await outbox.pending(id)
        // all failed rows, not a page of history: older failures must not
        // drop out of view behind newer sent prompts
        const failed = await outbox.failed(id)
        return [...pending, ...failed].sort((a, b) => a.id - b.id)
    }

    async function states() {
        const out = {}
        for (const s of await sessions.live()) out[s.task_id] = s.state
        return out
    }

    return {
        recover,
        start,
        stop,
        idle,
        resync,
        startTask,
        deliver,
        revive,
        action,
        autoCloseOnDone,
        agentState,
        queued,
        outboxView,
        setFeedbackDelivery,
        dropQueued,
        states,
    }
}
