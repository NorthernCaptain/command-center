/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Keeps the Asana task's managed tracking block (status, branches, PRs) and
// link attachments in step with the local task.
//
// - Triggered by task.created / task.updated bus events for tasks that have
//   an Asana gid, plus one reconcile pass at start (changes made while the
//   server was down, or syncs that never succeeded).
// - Debounced per task (a burst of edits -> one sync), serialized per task
//   (never two syncs of one task at once).
// - Skips when trackingFingerprint(task) equals asana.tracking_hash. After a
//   sync it stores the new hash and the attachment list; that write emits
//   task.updated again, which then matches the hash and stops: no loop.
// - Failures retry with backoff (RETRY_DELAYS_MS). Attachments that failed
//   count as a failure: the ones that worked are stored, the hash is not,
//   so the retry (or the next reconcile) adds the rest. A 404 (task deleted
//   in Asana) or exhausted retries are logged and left for the next change.

import { trackingFingerprint } from "./asanaNotes.js"

export const DEBOUNCE_MS = 3000
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000]
/** Periodic catch-up (URL detected later, syncs that gave up, missed events). */
export const RECONCILE_MS = 15 * 60_000
const ACTOR = "system"
const EVENTS = new Set(["task.created", "task.updated"])

/** True when the task needs a sync now (artifactUrl: what Asana should link). */
export function needsSync(task, artifactUrl = null, org = null) {
    const gid = task && task.asana && task.asana.gid
    if (!gid) return false
    return (
        trackingFingerprint(task, artifactUrl, org) !==
        (task.asana.tracking_hash || null)
    )
}

/**
 * @param {{ store, bus, asanaService, clock, log?, debounceMs?,
 *           retryDelaysMs? }} deps
 */
export function createAsanaSync({
    store,
    bus,
    asanaService,
    clock,
    log,
    debounceMs = DEBOUNCE_MS,
    retryDelaysMs = RETRY_DELAYS_MS,
    reconcileMs = RECONCILE_MS,
    githubOrg = null,
}) {
    // The artifact URL depends on the (lazily detected) public base URL.
    const urlFor = (task) =>
        typeof asanaService.artifactUrlFor === "function"
            ? asanaService.artifactUrlFor(task) || null
            : null
    const stale = (task) => needsSync(task, urlFor(task), githubOrg)
    let reconcileTimer = null
    const timers = new Map() // task id -> timer handle
    const chains = new Map() // task id -> promise of the running sync
    const attempts = new Map() // task id -> failed attempts in a row
    const writing = new Set() // task ids with our own update in flight
    let off = null
    let stopped = true

    function schedule(id, delay = debounceMs) {
        if (stopped) return
        const prev = timers.get(id)
        if (prev !== undefined) clock.clearTimeout(prev)
        timers.set(
            id,
            clock.setTimeout(() => {
                timers.delete(id)
                return run(id)
            }, delay)
        )
    }

    /** Sync one task now (serialized per task). Resolves when done. */
    function run(id) {
        const prev = chains.get(id) || Promise.resolve()
        const next = prev.then(() => syncOnce(id))
        chains.set(id, next)
        return next.finally(() => {
            if (chains.get(id) === next) chains.delete(id)
        })
    }

    async function syncOnce(id) {
        let task
        try {
            task = (await store.getTask(id)).task
        } catch (err) {
            log?.warn?.({ task_id: id, err: err?.message }, "asana sync: task")
            return false
        }
        if (!stale(task)) {
            attempts.delete(id)
            return false
        }
        const hash = trackingFingerprint(task, urlFor(task), githubOrg)
        const gid = task.asana.gid
        // Attachments recorded for another Asana task (re-linked) do not
        // exist on this one: start its list over. null = legacy, same gid.
        const syncedGid = task.asana.synced_gid
        const before =
            syncedGid && syncedGid !== gid ? [] : task.asana.attachments || []
        try {
            const res = await asanaService.syncTracking({
                ...task,
                asana: { ...task.asana, attachments: before },
            })
            const attachments = Array.isArray(res && res.attachments)
                ? res.attachments
                : before
            const failed = Array.isArray(res && res.failed) ? res.failed : []
            // Keep what did get attached; only a complete sync records the
            // hash, so an incomplete one is retried (and reconciled later).
            const patch = { attachments, synced_gid: gid }
            if (!failed.length) patch.tracking_hash = hash
            if (
                !failed.length ||
                JSON.stringify(attachments) !==
                    JSON.stringify(task.asana.attachments || [])
            ) {
                if (!(await writeOwn(id, gid, { asana: patch }))) {
                    // Re-linked while we synced: this bookkeeping belongs to
                    // the old Asana task. Sync the new link instead.
                    attempts.delete(id)
                    schedule(id)
                    return false
                }
            }
            if (failed.length)
                throw new Error(
                    `${failed.length} Asana attachment(s) failed: ${failed.join(", ")}`
                )
            attempts.delete(id)
            log?.info?.({ task_id: id, gid: task.asana.gid }, "asana synced")
            await catchUp(id)
            return true
        } catch (err) {
            const status = err?.details?.status
            const n = (attempts.get(id) || 0) + 1
            if (status === 404 || n > retryDelaysMs.length) {
                attempts.delete(id)
                log?.error?.(
                    { task_id: id, err: err?.message, attempts: n },
                    "asana sync failed, giving up until the next change"
                )
                return false
            }
            attempts.set(id, n)
            log?.warn?.(
                { task_id: id, err: err?.message, attempt: n },
                "asana sync failed, retrying"
            )
            schedule(id, retryDelaysMs[n - 1])
            return false
        }
    }

    /**
     * Events are ignored while our bookkeeping write runs (it may wait for
     * the task lock behind another writer). Re-read afterwards so a change
     * made meanwhile, whose event was ignored, still gets synced.
     */
    async function catchUp(id) {
        try {
            const { task } = await store.getTask(id)
            if (stale(task)) schedule(id)
        } catch (err) {
            log?.warn?.(
                { task_id: id, err: err?.message },
                "asana sync: recheck"
            )
        }
    }

    /** Our bookkeeping write; its task.updated event is not a new change. */
    async function writeOwn(id, gid, patch) {
        writing.add(id)
        try {
            // Under the task lock, and only while the task still points at
            // the Asana task we synced. Returns false when it was re-linked.
            const write = async () => {
                const { task } = await store.getTask(id)
                if (!task.asana || task.asana.gid !== gid) return false
                await store.updateTask(id, patch, {
                    actor: ACTOR,
                    reason: "asana sync",
                })
                return true
            }
            return typeof store.withTaskLock === "function"
                ? await store.withTaskLock(id, write)
                : await write()
        } finally {
            writing.delete(id)
        }
    }

    function onEvent(ev) {
        if (!ev || !EVENTS.has(ev.type) || ev.task_id == null) return
        if (writing.has(ev.task_id)) return
        const task = ev.data && ev.data.task
        // Cheap pre-filter on the event's task; syncOnce re-reads anyway.
        if (task && !stale(task)) return
        attempts.delete(ev.task_id) // a new change restarts the retries
        schedule(ev.task_id)
    }

    /** Schedule every Asana-linked task whose sync is behind. */
    async function reconcile() {
        let n = 0
        if (stopped) return 0
        try {
            // Most recently updated first; 1000 covers a personal board.
            const { tasks } = await store.query({ limit: 1000 })
            for (const t of tasks || []) {
                if (!stale(t)) continue
                schedule(t.id)
                n++
            }
        } catch (err) {
            log?.warn?.({ err: err?.message }, "asana sync reconcile failed")
        }
        return n
    }

    return {
        run,
        reconcile,
        start() {
            if (!stopped) return
            stopped = false
            off = bus.subscribe(onEvent)
            const loop = () => {
                reconcileTimer = clock.setTimeout(async () => {
                    reconcileTimer = null
                    if (stopped) return
                    await reconcile()
                    if (!stopped) loop()
                }, reconcileMs)
            }
            if (reconcileMs > 0) loop()
            return reconcile()
        },
        async stop() {
            stopped = true
            if (off) off()
            off = null
            if (reconcileTimer !== null) clock.clearTimeout(reconcileTimer)
            reconcileTimer = null
            for (const h of timers.values()) clock.clearTimeout(h)
            timers.clear()
            await Promise.allSettled([...chains.values()])
        },
        pending: () => timers.size,
    }
}
