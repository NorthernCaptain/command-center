/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// When a task captured from a Slack thread gets its Asana task, reply in the
// thread with the Asana link, through Brain (TraceBot posts it), so the
// people who asked see that the request is being worked on.
//
// - Attempts: an "slack_asana_link" event { gid, thread, brain_job, attempt }
//   when a Brain job starts ("slack_asana_link_failed" { gid, error } when it
//   could not start). Asana creation starts the first attempt once per
//   Asana task; Leo can start another from the task page (post()). Each
//   attempt has its own Brain idempotency key (the first one keeps
//   cc-T<id>-slack-asana-<gid>), which covers a crash between start and
//   event.
// - Outcome: Brain runs the post on its own and says how it went in its
//   answer, so the notifier follows the job to the end and records a
//   "slack_asana_link_result" event { gid, brain_job, status, answer }:
//   posted | not_posted (Brain answered but did not post) | failed (the job
//   failed) | unknown (no clear answer). A job still running after the
//   watch gives up stays "pending"; opening the task page (state()) picks
//   the watch up again, e.g. after a restart.
// - Anything but "posted" raises the task's Now flag with NOTICE_REASON;
//   a later "posted" clears that flag (only that reason).
// - Never thrown into the caller: Asana creation is not undone or failed
//   because of Slack.

import { errMessage } from "./jobs/util.js"
import { brainOutput } from "../integrations/brain/brainClient.js"
import { ForbiddenError } from "../util/errors.js"
import { nullLogger } from "../util/logger.js"

export const EV_LINK = "slack_asana_link"
export const EV_LINK_FAILED = "slack_asana_link_failed"
export const EV_RESULT = "slack_asana_link_result"
// "never tried" seen for this Asana task: raised the Now flag once
export const EV_MISSING = "slack_asana_link_missing"
// Leo dismissed the notice (handled it himself, or does not want it)
export const EV_DISMISSED = "slack_asana_link_dismissed"
export const NOTICE_REASON = "Slack thread not told about the Asana task"
const ACTOR = "center"
// Brain answers within a minute or two; a parked job can take 30+ minutes
const WATCH_POLLS = 90 // x 30s wait each
const POLL_WAIT_SECONDS = 30
const MAX_POLL_ERRORS = 3
const MAX_ANSWER = 1000
// the notice still needs Leo (and a place in Now)
const UNRESOLVED = new Set(["missing", "not_posted", "failed", "unknown"])
const OPEN = [
    "inbox",
    "ready",
    "active",
    "ready_for_pr",
    "pr_open",
    "pr_feedback",
    "review",
    "waiting",
]
const SWEEP_MS = 10 * 60 * 1000

/** The Brain instruction: one reply in the thread, then a verdict line. */
export function slackReplyPrompt({ threadUrl, asanaUrl }) {
    return [
        `Reply in the Slack thread at ${threadUrl} with this text:`,
        `"Tracking this in Asana: ${asanaUrl}"`,
        "Post it once, as a reply in that thread (not in the channel). If your",
        "posting tool needs a recipient or adds a mention, address the person",
        "who started the thread; that is fine. Do nothing else: no other",
        "messages or reactions.",
        "End your answer with exactly one line: RESULT: POSTED, or",
        "RESULT: NOT POSTED - <the reason>.",
    ].join(" ")
}

export function brainKey(taskId, gid, attempt = 1) {
    const base = `cc-T${taskId}-slack-asana-${gid}`
    return attempt > 1 ? `${base}-${attempt}` : base
}

// a refusal in prose (no RESULT line)
const NEGATION_RE =
    /\b(?:no|not|nothing|never|unable|cannot|failed|refused)\b|n['’]t\b/i

/**
 * Brain's answer -> "posted" | "not_posted" | "unknown". Only the RESULT
 * line can say posted; without it, prose that negates posting is
 * not_posted and anything else is unknown (Leo checks the thread).
 */
export function verdictOf(answer) {
    const a = String(answer || "")
    // the last RESULT line decides (an earlier one may be quoted)
    const verdict = a
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^RESULT:/i.test(l))
        .at(-1)
    if (verdict) {
        if (/^RESULT:\s*NOT[\s_-]*POSTED\b/i.test(verdict)) return "not_posted"
        if (/^RESULT:\s*POSTED\s*\.?$/i.test(verdict)) return "posted"
        return "unknown"
    }
    const mentionsPost = /\bpost(?:ed|ing)?\b/i.test(a)
    return NEGATION_RE.test(a) && mentionsPost ? "not_posted" : "unknown"
}

/**
 * The thread notice for the task's current Asana task, from its events
 * (newest first): null when it does not apply (no Slack thread or no Asana
 * task), else { status, thread, gid, attempts, brain_job, answer, error,
 * at }. status: missing (never tried) | pending | posted | not_posted |
 * failed | unknown | dismissed (Leo dismissed it after the last attempt;
 * a later "posted" result still shows as posted).
 */
export function noticeState(task, events) {
    const s = attemptState(task, events)
    if (!s) return null
    const { last, ...state } = s
    if (state.status === "posted") return state
    // events are newest first: a dismissal listed before the latest
    // attempt came after it
    const list = events || []
    const dismissed = list.findIndex(
        (e) =>
            e && e.type === EV_DISMISSED && e.data && e.data.gid === state.gid
    )
    const lastTry = last ? list.indexOf(last) : list.length
    if (dismissed !== -1 && dismissed < lastTry)
        return { ...state, status: "dismissed", at: list[dismissed].at }
    return state
}

function attemptState(task, events) {
    const src = (task && task.source) || {}
    const gid = task && task.asana && task.asana.gid
    if (src.type !== "slack" || !src.url || !gid) return null
    const mine = (events || []).filter(
        (e) =>
            e &&
            [EV_LINK, EV_LINK_FAILED, EV_RESULT].includes(e.type) &&
            e.data &&
            e.data.gid === gid
    )
    const tries = mine.filter((e) => e.type !== EV_RESULT)
    const base = {
        thread: src.url,
        gid,
        attempts: tries.length,
        brain_job: null,
        answer: null,
        error: null,
        at: null,
    }
    const last = tries[0]
    if (!last) return { ...base, status: "missing" }
    base.last = last
    if (last.type === EV_LINK_FAILED)
        return {
            ...base,
            status: "failed",
            error: last.data.error || null,
            at: last.at,
        }
    const job = last.data.brain_job
    const result = mine.find(
        (e) => e.type === EV_RESULT && e.data.brain_job === job
    )
    if (!result)
        return { ...base, status: "pending", brain_job: job, at: last.at }
    // older records kept Brain's whole tool text: its own words are inside
    const raw = result.data.answer || null
    const out = brainOutput(raw)
    const answer = out.output || raw
    return {
        ...base,
        status: result.data.status,
        brain_job: job,
        answer,
        reason: reasonOf(answer),
        transcript: result.data.transcript || out.transcript || null,
        error: result.data.error || null,
        at: result.at,
    }
}

/** "RESULT: NOT POSTED - <reason>" (the last such line) -> the reason. */
export function reasonOf(answer) {
    const lines = String(answer || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^RESULT:\s*NOT[\s_-]*POSTED/i.test(l))
    const m = /^RESULT:\s*NOT[\s_-]*POSTED\s*[-–—:]+\s*(.+)$/i.exec(
        lines.at(-1) || ""
    )
    return m ? m[1].trim() : null
}

/** Did Leo change the task's flags himself at or after `since`? */
export function dismissedSince(events, since) {
    return Boolean(
        since &&
        (events || []).some(
            (e) =>
                e &&
                e.type === "updated" &&
                e.actor === "me" &&
                String(e.at) >= String(since) &&
                ((e.data && e.data.changed) || []).includes("flags")
        )
    )
}

/**
 * @param {object} deps { store, brain: { start, result }, log, sleep,
 *   watchPolls }
 */
export function createThreadNotifier({
    store,
    brain,
    log = nullLogger,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    watchPolls = WATCH_POLLS,
    timers = { setInterval, clearInterval },
}) {
    const watching = new Map() // brain job id -> promise
    let stopping = false
    // one attempt decision at a time per task (double clicks, Asana
    // creation racing a manual post): check the state and start inside it
    const queues = new Map() // task id -> tail promise

    function serial(taskId, fn) {
        const key = String(taskId)
        const prev = queues.get(key) || Promise.resolve()
        const run = prev.then(fn, fn)
        const tail = run.catch(() => {})
        queues.set(key, tail)
        tail.then(() => {
            if (queues.get(key) === tail) queues.delete(key)
        })
        return run
    }

    // the whole history: an attempt must never fall out of a window
    async function eventsOf(taskId) {
        return (
            (await store.listEvents(taskId, {
                limit: Number.MAX_SAFE_INTEGER,
            })) || []
        )
    }

    // read + update under the task lock: another writer (the PR watcher)
    // may set its own Now reason meanwhile, which must not be cleared or
    // overwritten
    function locked(taskId, fn) {
        return typeof store.withTaskLock === "function"
            ? store.withTaskLock(taskId, fn)
            : fn()
    }

    function setNowFlag(taskId, status) {
        return locked(taskId, async () => {
            const { task } = await store.getTask(taskId)
            const flags = task.flags || {}
            const raise = status !== "posted" && status !== "dismissed"
            // dismissed by Leo: never raised again for this attempt
            if (
                raise &&
                noticeState(task, await eventsOf(taskId))?.status ===
                    "dismissed"
            )
                return
            if (!raise) {
                if (flags.now && flags.now_reason === NOTICE_REASON)
                    await store.updateTask(
                        taskId,
                        { flags: { now: false, now_reason: null } },
                        {
                            actor: ACTOR,
                            reason: `slack notice ${status}`,
                        }
                    )
            } else if (
                !flags.now &&
                // a closed task never comes back to Now
                !["done", "cancelled"].includes(task.status)
            ) {
                await store.updateTask(
                    taskId,
                    { flags: { now: true, now_reason: NOTICE_REASON } },
                    { actor: ACTOR, reason: "slack notice not posted" }
                )
            }
        })
    }

    /**
     * A job still without an answer needs Leo: raise Now unless he changed
     * the flags himself since that attempt started.
     */
    async function flagPending(taskId, job) {
        const events = await eventsOf(taskId)
        const startedAt = (
            events.find(
                (e) =>
                    e &&
                    e.type === EV_LINK &&
                    e.data &&
                    e.data.brain_job === job
            ) || {}
        ).at
        if (!dismissedSince(events, startedAt))
            await setNowFlag(taskId, "pending")
    }

    async function record(
        taskId,
        gid,
        job,
        status,
        answer,
        error = null,
        extra = {}
    ) {
        const data = {
            gid,
            brain_job: job,
            status,
            answer: answer ? String(answer).slice(0, MAX_ANSWER) : null,
            ...extra,
        }
        if (error) data.error = String(error).slice(0, 300)
        await store.appendEvent(taskId, { type: EV_RESULT, data }, ACTOR)
        const line = { task_id: taskId, brain_job: job, status }
        if (status === "posted")
            log.info(line, "slack thread: Asana link posted")
        else
            log.warn(
                { ...line, answer: data.answer, err: data.error },
                "slack thread: Asana link not posted"
            )
        try {
            await setNowFlag(taskId, status)
        } catch (err) {
            log.warn(
                { task_id: taskId, err: errMessage(err) },
                "slack thread: Now flag not updated"
            )
        }
        return status
    }

    /** Wait for the Brain job's answer and record it (once per job). */
    function watch(
        taskId,
        gid,
        job,
        polls = watchPolls,
        wait = POLL_WAIT_SECONDS
    ) {
        if (!brain || typeof brain.result !== "function") return null
        if (watching.has(job)) return watching.get(job)
        // shutting down: leave it pending, picked up after the restart
        if (stopping) return null
        const run = (async () => {
            let errors = 0
            for (let i = 0; i < polls; i++) {
                if (stopping) return "pending"
                let r
                try {
                    r = await brain.result(job, { waitSeconds: wait })
                } catch (err) {
                    errors += 1
                    if (errors >= MAX_POLL_ERRORS) {
                        // the job may still post: keep it pending (Check
                        // now / the next page view asks again), no new try
                        log.warn(
                            {
                                task_id: taskId,
                                brain_job: job,
                                err: errMessage(err),
                            },
                            "slack thread: Brain result unavailable"
                        )
                        await flagPending(taskId, job)
                        return "pending"
                    }
                    if (!stopping) await sleep(5000)
                    continue
                }
                if (!r || r.status === "running") continue
                const extra = r.transcript ? { transcript: r.transcript } : {}
                if (r.status === "failed")
                    return record(
                        taskId,
                        gid,
                        job,
                        "failed",
                        r.answer,
                        r.error,
                        extra
                    )
                return record(
                    taskId,
                    gid,
                    job,
                    verdictOf(r.answer),
                    r.answer,
                    null,
                    extra
                )
            }
            log.warn(
                { task_id: taskId, brain_job: job },
                "slack thread: Brain still running, stopped waiting"
            )
            // no answer in time: Leo should look (Check now on the page)
            await flagPending(taskId, job)
            return "pending"
        })()
            .catch((err) => {
                log.warn(
                    { task_id: taskId, brain_job: job, err: errMessage(err) },
                    "slack thread: watch failed"
                )
                return "pending"
            })
            .finally(() => watching.delete(job))
        watching.set(job, run)
        return run
    }

    async function start(taskId, task, attempt) {
        const src = task.source || {}
        const { gid, url: asanaUrl } = task.asana
        try {
            const job = await brain.start({
                prompt: slackReplyPrompt({ threadUrl: src.url, asanaUrl }),
                title: `cc T-${taskId} Asana link to Slack`,
                idempotencyKey: brainKey(taskId, gid, attempt),
            })
            await store.appendEvent(
                taskId,
                {
                    type: EV_LINK,
                    data: { gid, thread: src.url, brain_job: job, attempt },
                },
                ACTOR
            )
            log.info(
                { task_id: taskId, brain_job: job, attempt },
                "slack thread: Brain job started"
            )
            watch(taskId, gid, job)
            return { started: true, brain_job: job }
        } catch (err) {
            const error = errMessage(err).slice(0, 300)
            log.warn(
                { task_id: taskId, err: error },
                "slack thread: Asana link not posted"
            )
            try {
                await store.appendEvent(
                    taskId,
                    { type: EV_LINK_FAILED, data: { gid, error, attempt } },
                    ACTOR
                )
                await setNowFlag(taskId, "failed")
            } catch {
                // the warning above is enough
            }
            return { started: false, error }
        }
    }

    function applies(task) {
        if (!brain || typeof brain.start !== "function")
            return { skipped: "no_brain" }
        const src = task.source || {}
        if (src.type !== "slack" || !src.url) return { skipped: "no_slack" }
        if (!task.asana || !task.asana.gid || !task.asana.url)
            return { skipped: "no_asana" }
        return null
    }

    /** First attempt, right after the Asana task was created. */
    function asanaCreated(taskId) {
        return serial(taskId, async () => {
            const { task } = await store.getTask(taskId)
            const skip = applies(task)
            if (skip) return skip
            const state = noticeState(task, await eventsOf(taskId))
            if (state.attempts) return { skipped: "already_started" }
            return start(taskId, task, 1)
        })
    }

    /**
     * Brain jobs started for the current Asana task. A start that failed
     * (EV_LINK_FAILED) does not count: Brain may have created the job before
     * the error, so the retry reuses that attempt's idempotency key and
     * Brain answers with the same job instead of posting twice.
     */
    function startedJobs(task, events) {
        const gid = task.asana.gid
        return events.filter(
            (e) => e && e.type === EV_LINK && e.data && e.data.gid === gid
        ).length
    }

    /** Leo asked to post (again): a new attempt unless one is running. */
    function post(taskId) {
        return serial(taskId, async () => {
            const { task } = await store.getTask(taskId)
            const skip = applies(task)
            if (skip) return skip
            const events = await eventsOf(taskId)
            // the attempt itself (a dismissed pending job is still running)
            const state = attemptState(task, events)
            if (state.status === "pending") return { skipped: "pending" }
            if (state.status === "posted") return { skipped: "already_posted" }
            return start(taskId, task, startedJobs(task, events) + 1)
        })
    }

    /** The notice state; a pending job nobody watches is watched again. */
    async function state(taskId, task) {
        const events = await eventsOf(taskId)
        // a pending job is followed even when Leo dismissed the notice: its
        // outcome is still recorded (a later post shows)
        const attempt = attemptState(task, events)
        if (attempt && attempt.status === "pending" && attempt.brain_job)
            watch(taskId, attempt.gid, attempt.brain_job)
        const s = noticeState(task, events)
        if (s) await reconcile(taskId, task, s, events)
        return s
    }

    /**
     * An unresolved notice keeps the task in Now: raise the flag when nothing
     * holds it (e.g. PR feedback held it and was cleared since), unless Leo
     * changed the flags himself after the notice went wrong (his dismissal
     * stands). "missing" (never tried, e.g. Asana created before the notice
     * existed) is dated by a marker event written the first time it is seen.
     */
    async function reconcile(taskId, task, s, events) {
        if (!UNRESOLVED.has(s.status)) return
        try {
            let since = s.at
            if (s.status === "missing") {
                const marker = events.find(
                    (e) =>
                        e &&
                        e.type === EV_MISSING &&
                        e.data &&
                        e.data.gid === s.gid
                )
                if (!marker) {
                    await store.appendEvent(
                        taskId,
                        { type: EV_MISSING, data: { gid: s.gid } },
                        ACTOR
                    )
                    log.warn(
                        { task_id: taskId, gid: s.gid },
                        "slack thread: never told about the Asana task"
                    )
                }
                since = marker ? marker.at : null
            }
            if (task.flags && task.flags.now) return
            if (!dismissedSince(events, since))
                await setNowFlag(taskId, s.status)
        } catch (err) {
            log.warn(
                { task_id: taskId, err: errMessage(err) },
                "slack thread: Now flag not updated"
            )
        }
    }

    /** Reconcile every open Slack-captured Asana task (periodic). */
    async function sweep() {
        if (stopping) return 0
        let tasks = []
        try {
            const res = await store.query({ status: OPEN, limit: 1000 })
            tasks = (res && res.tasks) || []
        } catch (err) {
            log.warn({ err: errMessage(err) }, "slack thread: sweep failed")
            return 0
        }
        let n = 0
        for (const t of tasks) {
            if (applies(t)) continue
            try {
                const { task } = await store.getTask(t.id)
                await state(t.id, task)
                n += 1
            } catch (err) {
                log.warn(
                    { task_id: t.id, err: errMessage(err) },
                    "slack thread: sweep failed"
                )
            }
        }
        return n
    }

    let timer = null
    /** Sweep now and every `intervalMs` (default 10 minutes). */
    function startSweep(intervalMs = SWEEP_MS) {
        if (timer) return
        sweep()
        timer = timers.setInterval(sweep, intervalMs)
        if (timer && typeof timer.unref === "function") timer.unref()
    }
    /**
     * Stop the sweep and the watches: each watch ends after its current
     * Brain request (at most one wait); unfinished jobs stay pending.
     */
    function stopSweep() {
        stopping = true
        if (timer) timers.clearInterval(timer)
        timer = null
        return settled()
    }

    /**
     * Leo dismisses the notice (handled it in Slack himself, or does not
     * want it): recorded, out of the header and out of Now.
     */
    function dismiss(taskId) {
        return serial(taskId, async () => {
            const { task } = await store.getTask(taskId)
            const src = task.source || {}
            const gid = task.asana && task.asana.gid
            if (src.type !== "slack" || !src.url || !gid)
                return { skipped: "no_notice" }
            await store.appendEvent(
                taskId,
                { type: EV_DISMISSED, data: { gid } },
                "me"
            )
            log.info({ task_id: taskId, gid }, "slack thread: notice dismissed")
            await setNowFlag(taskId, "dismissed")
            return { dismissed: true }
        })
    }

    /** Ask Brain once (no wait) about the pending job -> the new state. */
    async function check(taskId) {
        const { task } = await store.getTask(taskId)
        const s = attemptState(task, await eventsOf(taskId))
        if (
            s &&
            s.status === "pending" &&
            s.brain_job &&
            !watching.has(s.brain_job)
        ) {
            await watch(taskId, s.gid, s.brain_job, 1, 0)
        }
        const { task: now } = await store.getTask(taskId)
        return noticeState(now, await eventsOf(taskId))
    }

    /** Resolves once every running watch has finished (tests, shutdown). */
    function settled() {
        return Promise.all([...watching.values()])
    }

    return {
        asanaCreated,
        post,
        dismiss,
        state,
        check,
        settled,
        sweep,
        start: startSweep,
        stop: stopSweep,
        store,
    }
}

/**
 * Owner routes: POST /api/tasks/:id/slack-notice (post again),
 * .../slack-notice/dismiss (Leo handled it) and .../slack-notice/check (ask
 * Brain now). Both answer
 * { slack_notice } (the new state) and what happened.
 */
export function mountThreadNotice(api, helpers, { notifier }) {
    const { parseTaskId, isViewer } = helpers
    const ownerOnly = (req) => {
        if (isViewer && isViewer(req)) throw new ForbiddenError("owner only")
    }
    const stateOf = async (id) => {
        const { task } = await notifier.store.getTask(id)
        return notifier.state(id, task)
    }
    api.post("/tasks/:id/slack-notice", async (req, res) => {
        ownerOnly(req)
        const id = parseTaskId(req.params.id)
        const result = await notifier.post(id)
        res.json({ result, slack_notice: await stateOf(id) })
    })
    api.post("/tasks/:id/slack-notice/dismiss", async (req, res) => {
        ownerOnly(req)
        const id = parseTaskId(req.params.id)
        const result = await notifier.dismiss(id)
        res.json({ result, slack_notice: await stateOf(id) })
    })
    api.post("/tasks/:id/slack-notice/check", async (req, res) => {
        ownerOnly(req)
        const id = parseTaskId(req.params.id)
        res.json({ slack_notice: await notifier.check(id) })
    })
}

/** taskExtras entry: { slack_notice } for GET /api/tasks/:id. */
export function noticeTaskExtras(notifier) {
    return async (id, task) => ({
        slack_notice: await notifier.state(id, task),
    })
}
