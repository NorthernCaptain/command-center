/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Durable timers. Schedules live in SQLite (schedulesRepo); a tick loop fires
// every schedule whose fire_at <= now. Missed schedules (service was down)
// fire on the first tick after start. See contracts.md "Scheduler".

import { ScheduleCreateSchema, taskKey } from "../contracts/schemas.js"
import { canTransition } from "../contracts/lifecycle.js"
import {
    NotFoundError,
    StaleRevisionError,
    ValidationError,
} from "../util/errors.js"
import { systemClock } from "../util/clock.js"
import { nullLogger } from "../util/logger.js"

export const NO_WORKER_ERROR = "worker service not available"
const ACTOR = "system"
const CLOSED = ["done", "cancelled"]
// Open statuses a surfaced "waiting" task may return to (prev_status).
const RESTORABLE = [
    "inbox",
    "ready",
    "active",
    "ready_for_pr",
    "pr_open",
    "pr_feedback",
    "review",
]
/** Consecutive StaleRevisionErrors before a surface schedule is failed. */
export const MAX_STALE_ATTEMPTS = 5
const SNOOZE_NOTE = /^snooze/i

/** Status a waiting task returns to when surfaced. */
function restoreStatus(prev) {
    return RESTORABLE.includes(prev) && canTransition("waiting", prev)
        ? prev
        : "ready"
}

/** Snooze-end schedules (payload.snooze, or created with a "snooze..." note)
 *  as opposed to plain reminders created by remind(). */
function isSnoozeSchedule(schedule, payload) {
    return (
        payload.snooze === true ||
        (typeof schedule.note === "string" && SNOOZE_NOTE.test(schedule.note))
    )
}

function sameInstant(a, b) {
    if (!a || !b) return false
    const ta = new Date(a).getTime()
    return !Number.isNaN(ta) && ta === new Date(b).getTime()
}

function errorMessage(err) {
    return (err && err.message) || String(err) || "unknown error"
}

function payloadOf(schedule) {
    if (schedule.payload && typeof schedule.payload === "object") {
        return schedule.payload
    }
    if (typeof schedule.payload_json === "string") {
        try {
            return JSON.parse(schedule.payload_json) || {}
        } catch {
            return {}
        }
    }
    return {}
}

/**
 * @param {{ schedulesRepo: object, store: object, bus: object,
 *           notifier?: object, jobRunner?: object, workerService?: object,
 *           clock?: object, log?: object, tickMs?: number }} deps
 *   workerService (deliver/revive) may also be bound later with
 *   setWorkerService(): it is created after the scheduler.
 */
export function createScheduler({
    schedulesRepo,
    store,
    bus,
    notifier = null,
    jobRunner = null,
    workerService = null,
    clock = systemClock,
    log = nullLogger,
    tickMs = 15000,
}) {
    let running = false
    let timer = null
    let inFlight = null
    /** schedule id -> consecutive StaleRevisionErrors (in memory). */
    const staleAttempts = new Map()

    function emit(schedule) {
        if (!schedule) return
        bus.emit("schedule.updated", {
            task_id: schedule.task_id ?? null,
            data: { schedule },
        })
    }

    /** Re-read a schedule after a repo write (fallback: patched copy). */
    async function reload(id, fallback) {
        const fresh = await schedulesRepo.get(id)
        return fresh || fallback
    }

    // ---- actions --------------------------------------------------------

    /** Task is waiting with a snooze that ends in the future (and so after
     *  the due fire_at, which is <= now when a schedule fires). */
    function snoozedPast(task) {
        if (task.status !== "waiting" || !task.snooze_until) return false
        const until = new Date(task.snooze_until).getTime()
        return !Number.isNaN(until) && until > clock.now().getTime()
    }

    /**
     * Read-modify-write of the task. Runs under store.withTaskLock when the
     * store has it: the real store's lock is re-entrant (AsyncLocalStorage),
     * so getTask + updateTask inside it are atomic against every other store
     * writer and the revision cannot go stale between read and write. The
     * baseRevision is still passed so a store without the lock reports a
     * conflict instead of overwriting; fire() then retries on a later tick.
     */
    async function surface(schedule, payload) {
        const taskId = schedule.task_id
        if (!taskId) throw new ValidationError("surface requires task_id")
        const reason = payload.reason || schedule.note || "Reminder"
        const snooze = isSnoozeSchedule(schedule, payload)

        const apply = async () => {
            // Re-check under the task lock: cancel() takes the same lock, so
            // a schedule cancelled (or moved) while we waited never fires.
            const fresh = await schedulesRepo.get(schedule.id)
            if (fresh && fresh.status && fresh.status !== "pending")
                return { skipped: true, gone: true, task: null }
            const current = await store.getTask(taskId)
            const task = current.task
            if (CLOSED.includes(task.status)) return { skipped: true, task }
            if (
                payload.due === true &&
                !sameInstant(task.due_at, schedule.fire_at)
            ) {
                // A due reminder for a due date the task no longer has
                // (moved, or cleared: a missing due_at is a mismatch too).
                return { skipped: true, task }
            }
            if (
                snooze &&
                (task.status !== "waiting" ||
                    !sameInstant(task.snooze_until, schedule.fire_at))
            ) {
                // Un-snoozed or re-snoozed since this schedule was created.
                return { skipped: true, task }
            }
            if (!snooze && snoozedPast(task)) {
                // A plain reminder inside an active snooze: the snooze-end
                // schedule surfaces the task; firing now would un-snooze it.
                return { skipped: true, task }
            }
            const patch = {
                // seen once Leo opens the task (clearsWhenSeen)
                flags: {
                    ...task.flags,
                    now: true,
                    now_reason: reason,
                    now_seen: reason,
                    now_seen_id: String(schedule.id),
                },
                snooze_until: null,
            }
            if (task.status === "waiting") {
                patch.status = restoreStatus(task.prev_status)
            }
            const res = await store.updateTask(taskId, patch, {
                actor: ACTOR,
                baseRevision: current.revision,
                reason: `schedule ${schedule.id}: ${reason}`,
            })
            await schedulesRepo.markFired(schedule.id)
            return { skipped: false, task: (res && res.task) || task }
        }

        const result =
            typeof store.withTaskLock === "function"
                ? await store.withTaskLock(taskId, apply)
                : await apply()
        if (!result.skipped && notifier) {
            await notifier.notify({
                title: reason,
                body: `${taskKey(taskId)} ${result.task.title}`,
                sound: "request",
            })
        }
        return result
    }

    async function centerJob(schedule, payload) {
        if (!jobRunner) throw new Error("job runner not available")
        if (!payload.job_type) {
            throw new ValidationError("center_job requires payload.job_type")
        }
        return jobRunner.enqueue(payload.job_type, payload.input || {}, {
            task_id: schedule.task_id ?? null,
        })
    }

    function requireWorker(schedule, action) {
        if (!workerService) throw new Error(NO_WORKER_ERROR)
        if (!schedule.task_id)
            throw new ValidationError(`${action} requires task_id`)
    }

    /** Follow-up prompt to the task's agent (outbox; revives if needed). */
    async function promptAgent(schedule, payload) {
        requireWorker(schedule, "prompt_agent")
        const prompt =
            typeof payload.prompt === "string" ? payload.prompt.trim() : ""
        if (!prompt)
            throw new ValidationError("prompt_agent requires payload.prompt")
        const res = await workerService.deliver(schedule.task_id, prompt, {
            reason: "follow-up",
            dedupeKey: `sched-${schedule.id}`,
        })
        // sent / queued / blocked: the prompt is in the outbox and goes out
        // when the agent can take it. failed / uncertain: never resent
        // automatically, so the schedule is a failure (shown with the reason).
        assertDelivered(res)
        return res
    }

    function assertDelivered(res) {
        const status = res && res.status
        // stalled: herdr saw no activity after the prompt; nothing ran and
        // nothing is queued for retry, so it is a failure too
        if (
            status === "failed" ||
            status === "uncertain" ||
            status === "stalled"
        )
            throw new Error(
                `prompt not delivered (${status})${res.error ? `: ${res.error}` : ""}`
            )
    }

    async function taskClosed(taskId) {
        if (taskId == null) return false
        const { task } = await store.getTask(taskId)
        return CLOSED.includes(task.status)
    }

    /** Relaunch the task's agent, with payload.prompt as the action. */
    async function launchAgent(schedule, payload) {
        requireWorker(schedule, "launch_agent")
        const prompt =
            typeof payload.prompt === "string" ? payload.prompt.trim() : ""
        const res = await workerService.revive(
            schedule.task_id,
            prompt ? { action: prompt } : {}
        )
        // closed while waiting for the task's worker queue
        if (res && res.skipped) return res
        assertDelivered(res)
        return res
    }

    /** Fire one schedule. Returns true when it fired successfully. */
    async function fire(schedule) {
        const id = schedule.id
        try {
            const fresh = await schedulesRepo.get(id)
            if (fresh && fresh.status && fresh.status !== "pending") {
                staleAttempts.delete(id)
                return false // cancelled or fired since listPending
            }
            const payload = payloadOf(schedule)
            switch (schedule.action) {
                case "surface": {
                    let res
                    try {
                        res = await surface(schedule, payload)
                    } catch (err) {
                        if (!(err instanceof StaleRevisionError)) throw err
                        const n = (staleAttempts.get(id) || 0) + 1
                        if (n >= MAX_STALE_ATTEMPTS) {
                            throw new Error(
                                `task ${schedule.task_id} kept changing: gave up after ${n} stale revision conflicts`
                            )
                        }
                        // Leave it pending: the next tick retries.
                        staleAttempts.set(id, n)
                        log.warn(
                            { schedule_id: id, attempt: n },
                            "surface hit a stale revision; will retry"
                        )
                        return false
                    }
                    if (res.gone) {
                        // Cancelled or fired while waiting for the lock.
                        staleAttempts.delete(id)
                        return false
                    }
                    if (res.skipped) {
                        // Task closed, or a stale snooze / due reminder:
                        // nothing to surface.
                        staleAttempts.delete(id)
                        await schedulesRepo.cancel(id)
                        emit(
                            await reload(id, {
                                ...schedule,
                                status: "cancelled",
                            })
                        )
                        return false
                    }
                    break
                }
                case "center_job":
                    await centerJob(schedule, payload)
                    break
                case "prompt_agent":
                case "launch_agent": {
                    // A task closed after the follow-up was scheduled gets
                    // no agent work: cancel the schedule instead of firing.
                    const res = (await taskClosed(schedule.task_id))
                        ? { skipped: true }
                        : schedule.action === "prompt_agent"
                          ? await promptAgent(schedule, payload)
                          : await launchAgent(schedule, payload)
                    if (res && res.skipped) {
                        staleAttempts.delete(id)
                        await schedulesRepo.cancel(id)
                        emit(
                            await reload(id, {
                                ...schedule,
                                status: "cancelled",
                            })
                        )
                        return false
                    }
                    break
                }
                default:
                    throw new Error(`unknown action: ${schedule.action}`)
            }
            staleAttempts.delete(id)
            // surface marked it fired under the task lock already
            if (schedule.action !== "surface") await schedulesRepo.markFired(id)
            emit(await reload(id, { ...schedule, status: "fired" }))
            return true
        } catch (err) {
            const msg = errorMessage(err)
            log.warn({ schedule_id: id, err: msg }, "schedule failed")
            staleAttempts.delete(id)
            try {
                await schedulesRepo.markFailed(id, msg)
                emit(
                    await reload(id, {
                        ...schedule,
                        status: "failed",
                        error: msg,
                    })
                )
            } catch (err2) {
                log.error(
                    { schedule_id: id, err: errorMessage(err2) },
                    "could not mark schedule failed"
                )
            }
            return false
        }
    }

    async function runTick() {
        const now = clock.now()
        const nowMs = now.getTime()
        let due
        try {
            due = (await schedulesRepo.listPending(now.toISOString())) || []
        } catch (err) {
            log.error({ err: errorMessage(err) }, "listPending failed")
            return 0
        }
        due = due
            .filter(
                (s) =>
                    (!s.status || s.status === "pending") &&
                    new Date(s.fire_at).getTime() <= nowMs
            )
            .sort(
                (a, b) =>
                    new Date(a.fire_at).getTime() -
                        new Date(b.fire_at).getTime() || a.id - b.id
            )
        let fired = 0
        for (const s of due) {
            if (await fire(s)) fired++
        }
        return fired
    }

    /** Fire everything due. Never throws; concurrent calls share one run. */
    function tick() {
        if (inFlight) return inFlight
        inFlight = runTick()
            .catch((err) => {
                log.error({ err: errorMessage(err) }, "scheduler tick failed")
                return 0
            })
            .finally(() => {
                inFlight = null
            })
        return inFlight
    }

    function schedule(ms) {
        timer = clock.setTimeout(loop, ms)
    }

    async function loop() {
        timer = null
        if (!running) return
        await tick()
        if (running) schedule(tickMs)
    }

    function start() {
        if (running) return
        running = true
        schedule(0) // first tick right away: fires missed schedules
    }

    function stop() {
        running = false
        if (timer !== null) {
            clock.clearTimeout(timer)
            timer = null
        }
        return inFlight || Promise.resolve(0)
    }

    // ---- CRUD -----------------------------------------------------------

    async function add({
        task_id = null,
        fire_at,
        action,
        payload,
        note,
    } = {}) {
        const parsed = ScheduleCreateSchema.safeParse({
            task_id,
            fire_at: fire_at instanceof Date ? fire_at.toISOString() : fire_at,
            action,
            payload: payload ?? {},
        })
        if (!parsed.success) {
            throw new ValidationError("invalid schedule", parsed.error.issues)
        }
        if (note != null && typeof note !== "string") {
            throw new ValidationError("note must be a string")
        }
        const created = await schedulesRepo.add({
            ...parsed.data,
            note: note ?? null,
        })
        emit(created)
        return created
    }

    async function cancel(id) {
        const existing = await schedulesRepo.get(id)
        if (!existing) throw new NotFoundError(`schedule ${id}`)
        if (existing.status && existing.status !== "pending") return existing
        // Same task lock as surface(): a firing in progress finishes first,
        // one that is waiting sees the cancellation and skips.
        const run = async () => {
            const cur = (await schedulesRepo.get(id)) || existing
            if (cur.status && cur.status !== "pending") return { cur }
            await schedulesRepo.cancel(id)
            return {
                cur: await reload(id, { ...existing, status: "cancelled" }),
                changed: true,
            }
        }
        const { cur, changed } =
            existing.task_id && typeof store.withTaskLock === "function"
                ? await store.withTaskLock(existing.task_id, run)
                : await run()
        if (changed) emit(cur)
        return cur
    }

    async function listForTask(taskId) {
        return (await schedulesRepo.listForTask(taskId)) || []
    }

    /** Schedule the due-date "surface" for a task at dueAt (payload.due
     *  marks it, see reconcileDue). Re-uses a pending due reminder at the
     *  same instant instead of creating a duplicate. */
    async function remind(taskId, dueAt, { note = null, reason } = {}) {
        const fireAt = dueAt instanceof Date ? dueAt.toISOString() : dueAt
        const existing = await listForTask(taskId)
        // Re-use only another due reminder: a follow-up or snooze at the
        // same instant is independent and may be cancelled on its own.
        const dup = existing.find((s) => {
            if (s.action !== "surface") return false
            if (s.status && s.status !== "pending") return false
            const payload = payloadOf(s)
            return (
                payload.due === true &&
                !isSnoozeSchedule(s, payload) &&
                new Date(s.fire_at).getTime() === new Date(fireAt).getTime()
            )
        })
        if (dup) return dup
        return add({
            task_id: taskId,
            fire_at: fireAt,
            action: "surface",
            payload: reason ? { reason, due: true } : { due: true },
            note,
        })
    }

    /**
     * Keep the due-date reminder in step with task.due_at after it changed:
     * cancel pending due reminders (only those remind() created, marked
     * payload.due) that are not at dueAt, then make sure one exists at dueAt
     * when it is in the future and either `ensure` is set (the task is a
     * reminder) or a due reminder was there before. Snoozes, follow-ups and
     * center jobs are never touched, even when they fire at the same time.
     * @returns {Promise<object|null>} the due reminder now pending, if any
     */
    async function reconcileDue(taskId, dueAt, { ensure = false } = {}) {
        const at = dueAt ? new Date(dueAt).getTime() : NaN
        let keep = null
        let had = false
        for (const s of await listForTask(taskId)) {
            if (s.action !== "surface") continue
            if (s.status && s.status !== "pending") continue
            const payload = payloadOf(s)
            if (payload.due !== true || isSnoozeSchedule(s, payload)) continue
            const t = new Date(s.fire_at).getTime()
            had = true
            if (t === at && !keep) keep = s
            else await cancel(s.id)
        }
        if (keep) return keep
        if (!(at > clock.now().getTime()) || !(ensure || had)) return null
        return remind(taskId, new Date(at).toISOString())
    }

    /** Late binding: the worker service is created after the scheduler. */
    function setWorkerService(ws) {
        workerService = ws || null
    }

    return {
        start,
        stop,
        tick,
        add,
        cancel,
        listForTask,
        remind,
        reconcileDue,
        setWorkerService,
    }
}
