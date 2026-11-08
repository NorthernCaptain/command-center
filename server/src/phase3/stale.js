/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Stale sweep: tasks in ready | active | waiting (without a snooze) that
// nobody touched for `stale.days` (runtime setting, default 7) get
// flags.now "Stale: no change in N days" once, with a `stale_flagged`
// event. Not again until the task changes: the event records the task's
// updated_at after flagging, and a task already in Now is left alone.

import { systemClock } from "../util/clock.js"
import { nullLogger } from "../util/logger.js"
import { PHASE3_DEFAULTS } from "./defaults.js"

export const STALE_STATUSES = ["ready", "active", "waiting"]
export const DEFAULT_STALE_DAYS = PHASE3_DEFAULTS["stale.days"]
export const EV_STALE = "stale_flagged"
const ACTOR = "system"
const DAY_MS = 86400000
const PAGE = 1000

export const staleReason = (days) =>
    `Stale: no change in ${days} day${days === 1 ? "" : "s"}`

/** Page through store.query() for every task matching params. */
export async function queryAll(store, params) {
    const out = []
    for (;;) {
        const { tasks, total } = await store.query({
            ...params,
            limit: PAGE,
            offset: out.length,
        })
        out.push(...tasks)
        if (!tasks.length || out.length >= total) break
    }
    return out
}

/** Stale days from settings; a bad value falls back to the default. */
export async function staleDays(settingsRepo) {
    const v = settingsRepo
        ? await settingsRepo.get("stale.days", DEFAULT_STALE_DAYS)
        : DEFAULT_STALE_DAYS
    return Number.isInteger(v) && v >= 1 ? v : DEFAULT_STALE_DAYS
}

/** Pure check on a task (no event history). */
export function isStaleCandidate(task, nowMs, days) {
    if (!STALE_STATUSES.includes(task.status)) return false
    if (task.status === "waiting" && task.snooze_until) return false
    if (task.flags && task.flags.now) return false
    const updated = new Date(task.updated_at).getTime()
    if (Number.isNaN(updated)) return false
    return nowMs - updated >= days * DAY_MS
}

/**
 * @param {{ store: object, settingsRepo?: object, clock?: object,
 *           log?: object }} deps
 */
export function createStaleSweep({
    store,
    settingsRepo = null,
    clock = systemClock,
    log = nullLogger,
}) {
    async function flaggedSinceChange(id, task) {
        const events = (await store.listEvents(id, { limit: 500 })) || []
        const last = events.find((e) => e.type === EV_STALE)
        return Boolean(
            last && last.data && last.data.updated_at === task.updated_at
        )
    }

    async function flagOne(id, days) {
        const run = async () => {
            const { task, revision } = await store.getTask(id)
            const nowMs = clock.now().getTime()
            if (!isStaleCandidate(task, nowMs, days)) return null
            if (await flaggedSinceChange(id, task)) return null
            const reason = staleReason(days)
            const res = await store.updateTask(
                id,
                { flags: { ...task.flags, now: true, now_reason: reason } },
                { actor: ACTOR, baseRevision: revision, reason: "stale sweep" }
            )
            const updated = (res && res.task) || task
            await store.appendEvent(
                id,
                {
                    type: EV_STALE,
                    data: { days, updated_at: updated.updated_at },
                },
                ACTOR
            )
            return { id, title: updated.title, status: updated.status, days }
        }
        return typeof store.withTaskLock === "function"
            ? store.withTaskLock(id, run)
            : run()
    }

    /**
     * Flag every stale task once.
     * @returns {Promise<{ days: number, checked: number,
     *           flagged: Array<{id, title, status, days}> }>}
     */
    async function sweep() {
        const days = await staleDays(settingsRepo)
        const nowMs = clock.now().getTime()
        const tasks = await queryAll(store, { status: STALE_STATUSES })
        const candidates = tasks.filter((t) => isStaleCandidate(t, nowMs, days))
        const flagged = []
        for (const t of candidates) {
            try {
                const hit = await flagOne(t.id, days)
                if (hit) flagged.push(hit)
            } catch (err) {
                log.warn(
                    { task_id: t.id, err: err && err.message },
                    "stale flag failed"
                )
            }
        }
        if (flagged.length)
            log.info({ count: flagged.length, days }, "stale tasks flagged")
        return { days, checked: tasks.length, flagged }
    }

    return { sweep }
}
