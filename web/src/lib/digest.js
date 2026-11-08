/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Morning digest helpers: normalize GET /api/digest, "is it today's" and the
// per-day dismissal kept in localStorage.

export const SECTION_LABELS = {
    now: "Now",
    overdue: "Overdue reminders",
    reminders: "Overdue reminders",
    prs: "PRs waiting on you",
    blocked: "Blocked agents",
    agents: "Blocked agents",
    stale: "Stale tasks",
}

const SECTION_ORDER = [
    "now",
    "overdue",
    "reminders",
    "prs",
    "blocked",
    "agents",
    "stale",
]

/** Local calendar date "YYYY-MM-DD" of a Date / ISO string. */
export function localDate(at = new Date()) {
    const d = at instanceof Date ? at : new Date(at)
    if (Number.isNaN(d.getTime())) return null
    const p = (n) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function normItem(it) {
    if (!it || typeof it !== "object") return null
    const id = it.task_id ?? it.id ?? null
    const title = it.title || it.text || it.label || (id ? `T-${id}` : "")
    if (!title) return null
    return {
        id,
        title,
        note: it.note || it.reason || it.now_reason || it.status || null,
        url: it.url || null,
    }
}

function normSection(key, title, items) {
    const list = (Array.isArray(items) ? items : [])
        .map(normItem)
        .filter(Boolean)
    return { id: key, title: title || SECTION_LABELS[key] || key, items: list }
}

/**
 * GET /api/digest -> { date, generated_at, summary, sections:[{ id, title,
 * items:[{ id, title, note, url }] }] } | null. Accepts { digest } or the
 * digest itself; sections as an array, an object, or top-level arrays.
 */
export function normalizeDigest(res) {
    const raw =
        res && typeof res === "object" && "digest" in res ? res.digest : res
    if (!raw || typeof raw !== "object") return null
    const generated = raw.generated_at || raw.at || null
    const date = raw.date || (generated ? localDate(generated) : null)
    if (!date) return null
    let sections = []
    if (Array.isArray(raw.sections)) {
        sections = raw.sections.map((s, i) =>
            normSection(
                s.id || s.key || `s${i}`,
                s.title || s.label,
                s.items || s.tasks
            )
        )
    } else {
        const src =
            raw.sections && typeof raw.sections === "object"
                ? raw.sections
                : raw
        sections = SECTION_ORDER.filter((k) => Array.isArray(src[k])).map((k) =>
            normSection(k, null, src[k])
        )
    }
    return {
        date,
        generated_at: generated,
        summary: raw.summary || raw.title || raw.body || raw.text || "",
        sections: sections.filter((s) => s.items.length),
    }
}

export function isToday(digest, now = new Date()) {
    return Boolean(digest) && digest.date === localDate(now)
}

const DISMISS_KEY = "cc.digest.dismissed"

function storage(store) {
    if (store !== undefined) return store
    try {
        return globalThis.localStorage || null
    } catch {
        return null
    }
}

/** The date whose digest was dismissed on this device (or null). */
export function dismissedDate(store) {
    try {
        const s = storage(store)
        return s ? s.getItem(DISMISS_KEY) : null
    } catch {
        return null
    }
}

export function dismissDigest(date, store) {
    try {
        const s = storage(store)
        if (s) s.setItem(DISMISS_KEY, date)
    } catch {
        // private mode / blocked storage: dismissal lasts until reload
    }
}
