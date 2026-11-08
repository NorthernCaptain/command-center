/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Relative and short absolute time formatting, plus the snooze presets.

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
]

function toDate(value) {
    if (value === null || value === undefined || value === "") return null
    const d = value instanceof Date ? value : new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
}

function pad(n) {
    return String(n).padStart(2, "0")
}

/** "14:05" in local time. */
export function clockTime(value) {
    const d = toDate(value)
    if (!d) return ""
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "Nov 7" (adds the year when it differs from `now`). */
export function shortDate(value, now = new Date()) {
    const d = toDate(value)
    if (!d) return ""
    const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`
    return d.getFullYear() === toDate(now).getFullYear()
        ? base
        : `${base}, ${d.getFullYear()}`
}

/**
 * Relative time: "just now", "5m ago", "in 2h", "3d ago". Beyond a week it
 * falls back to a short date.
 */
export function relativeTime(value, now = new Date()) {
    const d = toDate(value)
    const n = toDate(now)
    if (!d || !n) return ""
    const diff = d.getTime() - n.getTime()
    const abs = Math.abs(diff)
    const future = diff > 0
    if (abs < 45 * 1000) return future ? "in a moment" : "just now"
    let amount
    if (abs < HOUR) amount = `${Math.round(abs / MIN)}m`
    else if (abs < DAY) amount = `${Math.round(abs / HOUR)}h`
    else if (abs < 7 * DAY) amount = `${Math.round(abs / DAY)}d`
    else return shortDate(d, n)
    return future ? `in ${amount}` : `${amount} ago`
}

function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/**
 * Calendar-ish label for due / wake times: "today 10:00", "tomorrow 09:00",
 * "Mon 09:00" (within a week), "yesterday 18:00", else "Nov 12 09:00".
 */
export function formatDue(value, now = new Date()) {
    const d = toDate(value)
    const n = toDate(now)
    if (!d || !n) return ""
    const days = Math.round(
        (startOfDay(d).getTime() - startOfDay(n).getTime()) / DAY
    )
    const t = clockTime(d)
    if (days === 0) return `today ${t}`
    if (days === 1) return `tomorrow ${t}`
    if (days === -1) return `yesterday ${t}`
    if (days > 1 && days < 7) return `${WEEKDAYS[d.getDay()]} ${t}`
    return `${shortDate(d, n)} ${t}`
}

/** Next local 09:00 that is `daysAhead` days from `now`. */
function nineAm(now, daysAhead) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    d.setDate(d.getDate() + daysAhead)
    d.setHours(9, 0, 0, 0)
    return d
}

/** Next Monday 09:00 (always at least one day ahead). */
function nextMonday(now) {
    const ahead = (8 - now.getDay()) % 7 || 7
    return nineAm(now, ahead)
}

/** Snooze presets with concrete ISO times computed in local time. */
export function snoozePresets(now = new Date()) {
    return [
        {
            id: "2h",
            label: "2 hours",
            when: "in 2h",
            at: new Date(now.getTime() + 2 * HOUR).toISOString(),
        },
        {
            id: "tomorrow",
            label: "Tomorrow 9am",
            when: "tomorrow 9am",
            at: nineAm(now, 1).toISOString(),
        },
        {
            id: "next_week",
            label: "Next week",
            when: "next week",
            at: nextMonday(now).toISOString(),
        },
    ]
}

const UNIT_MS = { m: MIN, h: HOUR, d: DAY, w: 7 * DAY }

/**
 * Small local parser for custom snooze text, so the common forms can be
 * applied as a PATCH (waiting + snooze_until). Understands "2h", "in 30m",
 * "3d", "1w", "tomorrow", "tomorrow 9am", "next week". Returns an ISO
 * string or null (callers then let the server parse it).
 */
export function parseWhenLocal(text, now = new Date()) {
    const s = String(text || "")
        .trim()
        .toLowerCase()
    if (!s) return null
    const rel = s.match(
        /^(?:in\s+)?(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)$/
    )
    if (rel) {
        const unit = rel[2][0]
        return new Date(
            now.getTime() + Number(rel[1]) * UNIT_MS[unit]
        ).toISOString()
    }
    if (s === "next week") return nextMonday(now).toISOString()
    const tm = s.match(
        /^tomorrow(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/
    )
    if (tm) {
        const d = nineAm(now, 1)
        if (tm[1]) {
            let h = Number(tm[1]) % 12
            if (tm[3] === "pm") h += 12
            if (!tm[3] && Number(tm[1]) >= 12) h = Number(tm[1])
            if (h > 23) return null
            d.setHours(h, tm[2] ? Number(tm[2]) : 0, 0, 0)
        }
        return d.toISOString()
    }
    return null
}

/** Value for <input type="datetime-local"> -> ISO (or null). */
export function localInputToIso(value) {
    const d = toDate(value)
    return d ? d.toISOString() : null
}
