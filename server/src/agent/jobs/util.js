/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Small helpers shared by job modules.

import crypto from "node:crypto"

/** Valid ISO date string (normalized to UTC ISO) or null. */
export function isoOrNull(value, { clock, future = false } = {}) {
    if (typeof value !== "string" || !value.trim()) return null
    const t = Date.parse(value)
    if (Number.isNaN(t)) return null
    if (future && clock && t <= clock.now().getTime()) return null
    return new Date(t).toISOString()
}

/** Resolve a "when" phrase via deps.dateParser.parseWhen, else ISO. */
export function resolveWhen(when, { deps, clock }) {
    if (typeof when !== "string" || !when.trim()) return null
    let iso = null
    if (
        deps &&
        deps.dateParser &&
        typeof deps.dateParser.parseWhen === "function"
    ) {
        try {
            iso = deps.dateParser.parseWhen(when)
        } catch {
            iso = null
        }
    }
    return isoOrNull(iso || when, { clock, future: true })
}

export function newLinkId() {
    return `l_${crypto.randomBytes(5).toString("hex")}`
}

/** Kind of the task source URL: "slack" | "asana" | null. */
export function sourceKind(task) {
    const src = task.source || {}
    const url = src.url || ""
    if (src.type === "slack" || /slack\.com\//i.test(url))
        return url ? "slack" : null
    if (src.type === "asana" || /app\.asana\.com\//i.test(url))
        return url ? "asana" : null
    return null
}

/** Asana task gid from a task URL (old /0/<project>/<task> and new /task/<gid>). */
export function asanaGidFromUrl(url) {
    const s = String(url || "")
    const m =
        /\/task\/(\d+)/.exec(s) ||
        /app\.asana\.com\/0\/\d+\/(\d+)/.exec(s) ||
        /app\.asana\.com\/\d+\/\d+\/project\/\d+\/task\/(\d+)/.exec(s)
    return m ? m[1] : null
}

/** Asana service from deps (contracts name it asanaService; enrich row says asana). */
export function asanaOf(deps) {
    return (deps && (deps.asanaService || deps.asana)) || null
}

export function errMessage(err) {
    return (err && (err.message || String(err))) || "unknown error"
}

/** "- [ ] item" checklist from strings. */
export function checklist(items) {
    return (items || [])
        .map((s) => String(s).trim())
        .filter(Boolean)
        .map((s) => `- [ ] ${s.replace(/^-\s*(\[[ x]\]\s*)?/i, "")}`)
        .join("\n")
}

const PENDING_JOB = ["queued", "running", "parked"]

/**
 * Enqueue a task job unless one of the same type is already pending for the
 * task. Returns { job, existing } or null without a usable runner.
 */
export function enqueueOnce(runner, type, taskId, input = {}) {
    if (!runner || typeof runner.enqueue !== "function") return null
    const pending =
        typeof runner.list === "function"
            ? (
                  runner.list({ task_id: taskId, status: PENDING_JOB }) || []
              ).find((j) => j.type === type)
            : null
    if (pending) return { job: pending, existing: true }
    return {
        job: runner.enqueue(type, input, { task_id: taskId }),
        existing: false,
    }
}
