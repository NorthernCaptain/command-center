/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Morning digest: once a day at `digest.time` ("HH:MM", local wall clock in
// the configured timezone) when `digest.enabled`. Runs the stale sweep,
// then builds a deterministic summary (no LLM): Now items, overdue tasks,
// PRs waiting on Leo, blocked agents, stale tasks. Sends one notification
// and emits bus "digest.updated". The latest digest is kept in memory and,
// when stateFile is given, on disk so a restart neither loses it nor sends
// a second digest the same day.
//
// Scheduling compares wall-clock strings ("YYYY-MM-DD", "HH:MM") in the
// timezone on every check, so DST jumps cannot skip or repeat a day: a
// skipped 02:30 fires at 03:00, a repeated hour finds today already done.

import nodeFs from "node:fs"
import path from "node:path"
import { systemClock } from "../util/clock.js"
import { nullLogger } from "../util/logger.js"
import { PHASE3_DEFAULTS } from "./defaults.js"
import { queryAll } from "./stale.js"

export const DEFAULT_DIGEST_TIME = PHASE3_DEFAULTS["digest.time"]
export const DEFAULT_DIGEST_ENABLED = PHASE3_DEFAULTS["digest.enabled"]
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const OPEN_STATUSES = [
    "inbox",
    "ready",
    "waiting",
    "active",
    "ready_for_pr",
    "pr_open",
    "pr_feedback",
    "review",
]
const PR_REASONS = {
    ready_for_pr: "ready for PR",
    pr_feedback: "PR feedback",
}
const CLOSED_UNMERGED_RE = /closed without merge/i
const STALE_RE = /^stale:/i
const CHECK_MS = 60000

/** Local "YYYY-MM-DD" and "HH:MM" of a Date in a timezone. */
export function localParts(date, timeZone) {
    const parts = {}
    for (const p of new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date))
        parts[p.type] = p.value
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${parts.hour}:${parts.minute}`,
    }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`

/** "Morning: 3 in Now, 2 PRs, ..." (zero counts left out). */
export function summaryLine(d) {
    const parts = []
    if (d.now.length) parts.push(`${d.now.length} in Now`)
    if (d.prs.length) parts.push(plural(d.prs.length, "PR"))
    if (d.overdue.length) parts.push(`${d.overdue.length} overdue`)
    if (d.blocked.length) parts.push(plural(d.blocked.length, "blocked agent"))
    if (d.stale.length) parts.push(`${d.stale.length} stale`)
    return parts.length ? `Morning: ${parts.join(", ")}` : "Morning: all clear"
}

const brief = (t, extra = {}) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    ...extra,
})

/**
 * @param {{ store: object, settingsRepo?: object, notifier?: object,
 *           bus?: object, staleSweep?: { sweep: Function },
 *           workerService?: { states: Function }, clock?: object,
 *           log?: object, timezone?: string, stateFile?: string|null,
 *           fs?: object, checkMs?: number }} deps
 *   workerService may be bound later with setWorkerService().
 */
export function createDigest({
    store,
    settingsRepo = null,
    notifier = null,
    bus = null,
    staleSweep = null,
    workerService = null,
    clock = systemClock,
    log = nullLogger,
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    stateFile = null,
    fs = nodeFs,
    checkMs = CHECK_MS,
}) {
    let latest = null
    let lastRunDate = null
    let timer = null
    let running = false
    let inFlight = null
    let checking = null // the timer loop's check() in progress
    let stopped = false

    function loadState() {
        if (!stateFile) return
        try {
            const data = JSON.parse(fs.readFileSync(stateFile, "utf8"))
            if (data && typeof data === "object") {
                latest = data.latest || null
                lastRunDate = data.last_run_date || null
            }
        } catch (err) {
            if (err.code !== "ENOENT")
                log.warn({ err: err.message }, "digest state unreadable")
        }
    }

    function saveState() {
        if (!stateFile) return
        try {
            fs.mkdirSync(path.dirname(stateFile), { recursive: true })
            const tmp = `${stateFile}.tmp`
            fs.writeFileSync(
                tmp,
                JSON.stringify({ last_run_date: lastRunDate, latest }) + "\n"
            )
            fs.renameSync(tmp, stateFile)
        } catch (err) {
            log.warn({ err: err.message }, "digest state not saved")
        }
    }

    async function setting(key, fallback) {
        return settingsRepo ? settingsRepo.get(key, fallback) : fallback
    }

    async function schedule() {
        const enabled =
            (await setting("digest.enabled", DEFAULT_DIGEST_ENABLED)) === true
        const raw = await setting("digest.time", DEFAULT_DIGEST_TIME)
        const time = TIME_RE.test(String(raw)) ? raw : DEFAULT_DIGEST_TIME
        return { enabled, time }
    }

    async function blockedAgents(byId) {
        if (!workerService || typeof workerService.states !== "function")
            return []
        try {
            const states = (await workerService.states()) || {}
            return Object.entries(states)
                .filter(([, s]) => s === "blocked")
                .map(([id]) => {
                    const t = byId.get(Number(id))
                    return t
                        ? brief(t, { state: "blocked" })
                        : { id: Number(id), title: null, status: null }
                })
        } catch (err) {
            log.warn({ err: err && err.message }, "agent states unavailable")
            return []
        }
    }

    /** Deterministic digest of the current board. */
    async function buildDigest({ staleFlagged = [] } = {}) {
        const now = clock.now()
        const nowMs = now.getTime()
        const tasks = await queryAll(store, { status: OPEN_STATUSES })
        const byId = new Map(tasks.map((t) => [t.id, t]))
        const flags = (t) => t.flags || {}

        const nowItems = tasks
            .filter((t) => flags(t).now)
            .map((t) => brief(t, { reason: flags(t).now_reason || null }))
        const overdue = tasks
            .filter((t) => {
                if (!t.due_at) return false
                const due = new Date(t.due_at).getTime()
                return !Number.isNaN(due) && due < nowMs
            })
            .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)))
            .map((t) => brief(t, { kind: t.kind, due_at: t.due_at }))
        const prs = []
        for (const t of tasks) {
            if (PR_REASONS[t.status])
                prs.push(brief(t, { reason: PR_REASONS[t.status] }))
            else if (CLOSED_UNMERGED_RE.test(flags(t).now_reason || ""))
                prs.push(brief(t, { reason: "PR closed without merge" }))
        }
        const stale = []
        const seen = new Set()
        for (const s of staleFlagged) {
            seen.add(s.id)
            stale.push({ id: s.id, title: s.title, status: s.status })
        }
        for (const t of tasks) {
            if (seen.has(t.id) || !STALE_RE.test(flags(t).now_reason || ""))
                continue
            if (!flags(t).now) continue
            stale.push(brief(t))
        }
        const digest = {
            generated_at: now.toISOString(),
            date: localParts(now, timezone).date,
            now: nowItems,
            overdue,
            prs,
            blocked: await blockedAgents(byId),
            stale,
        }
        digest.summary = summaryLine(digest)
        return digest
    }

    function bodyOf(d) {
        const lines = []
        const top = (label, list) => {
            if (!list.length) return
            lines.push(
                `${label}: ${list
                    .slice(0, 3)
                    .map((t) => `T-${t.id}`)
                    .join(", ")}${list.length > 3 ? "…" : ""}`
            )
        }
        top("Now", d.now)
        top("PRs", d.prs)
        top("Overdue", d.overdue)
        top("Blocked", d.blocked)
        return lines.join(" · ")
    }

    /**
     * Stale sweep + digest; stores it as latest and emits digest.updated.
     * @param {{ notify?: boolean }} [opts] notify: send the notification
     */
    async function runNow({ notify = true } = {}) {
        let staleFlagged = []
        if (staleSweep) {
            try {
                staleFlagged = (await staleSweep.sweep()).flagged || []
            } catch (err) {
                log.warn({ err: err && err.message }, "stale sweep failed")
            }
        }
        const digest = await buildDigest({ staleFlagged })
        latest = digest
        lastRunDate = digest.date
        saveState()
        if (bus)
            bus.emit("digest.updated", {
                data: {
                    generated_at: digest.generated_at,
                    date: digest.date,
                    summary: digest.summary,
                },
            })
        if (notify && notifier) {
            try {
                await notifier.notify({
                    title: digest.summary,
                    body: bodyOf(digest),
                    sound: "none",
                    url: "/",
                })
            } catch (err) {
                log.warn({ err: err && err.message }, "digest notify failed")
            }
        }
        return digest
    }

    /** Concurrent runs share one. */
    function run(opts) {
        if (inFlight) return inFlight
        inFlight = runNow(opts).finally(() => {
            inFlight = null
        })
        return inFlight
    }

    /** Run when enabled, the local time reached digest.time and today has
     *  no digest yet. Returns the digest or null. Never throws. */
    async function check() {
        try {
            const { enabled, time } = await schedule()
            // stop() began while the settings were read: no new run
            if (stopped) return null
            if (!enabled) return null
            const local = localParts(clock.now(), timezone)
            if (lastRunDate === local.date || local.time < time) return null
            return await run({ notify: true })
        } catch (err) {
            log.error({ err: err && err.message }, "digest run failed")
            return null
        }
    }

    async function loop() {
        timer = null
        if (!running) return
        checking = check()
        try {
            await checking
        } finally {
            checking = null
        }
        if (running) timer = clock.setTimeout(loop, checkMs)
    }

    function start() {
        if (running) return
        running = true
        stopped = false
        loadState()
        timer = clock.setTimeout(loop, 0)
    }

    /** Resolves once the timer's check and any run in flight settled. */
    async function stop() {
        running = false
        stopped = true
        if (timer !== null) {
            clock.clearTimeout(timer)
            timer = null
        }
        if (checking) await checking
        return inFlight ? inFlight : null
    }

    /** Latest digest (memory, else the saved state), or null. */
    function getLatest() {
        if (!latest) loadState()
        return latest
    }

    function setWorkerService(ws) {
        workerService = ws || null
    }

    return {
        start,
        stop,
        check,
        run,
        buildDigest,
        latest: getLatest,
        setWorkerService,
    }
}
