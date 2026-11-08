/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Rule-based date parsing for captures ("remind me to X tomorrow 10am") and
// snooze/schedule inputs ("2h", "next week"). Built on chrono-node with
// forwardDate semantics. Local wall times are resolved in the configured
// IANA timezone (DST-aware), not in the process timezone.

import * as chrono from "chrono-node"
import { ValidationError } from "../util/errors.js"
import { systemClock } from "../util/clock.js"

const DEFAULT_HOUR = 9
const MAX_TITLE = 300

const REMINDER_PREFIX = /^\s*(?:remind\s+me\b|reminder\s*:)/i
const REMINDER_STRIP =
    /^\s*(?:remind\s+me|reminder\s*:)\s*(?:(?:to|that|about)\b\s*)?:?\s*/i
const TRAILING_CONNECTOR = /\s*\b(?:by|before|until|till|due|at|on)\s*$/i
const EDGE_PUNCT = /^[\s,.;:!?\-–—]+|[\s,.;:!?\-–—]+$/g
const CASUAL_TIME_TAG =
    /ENCasualTimeParser|casualReference\/(?:tonight|morning|afternoon|evening|noon|midnight|now)/
const DAY_MS = 86400000

// Capture-mode filters (see pickCapture).
// A bare duration with no anchor: "1w", "404s", "2 days", "a week".
const BARE_DURATION = /^(?:an?|\d+(?:\.\d+)?)\s*[a-z]+\.?$/i
// Just numbers: "9", "5:30", "9 to 5" (no am/pm, no connector).
const NUMERIC_ONLY =
    /^\d{1,2}(?:[:.]\d{2})?(?:\s*(?:-|–|to)\s*\d{1,2}(?:[:.]\d{2})?)?$/i
const PAST_WORD = /\bago\b|^(?:last|past|previous)\b/i
// "since monday", "from last friday": a past reference, not a due date.
const PAST_BEFORE = /\b(?:since|last|past|previous|ago)\s*$/i
const CONNECTOR_BEFORE = /\b(?:by|on|at|before|until|till|due|around)\s*$/i
const CONNECTOR_START = /^(?:by|on|at|before|until|till|due|in)\b/i
const CONNECTOR_WORD = /\b(?:tomorrow|today|tonight|next)\b/i
// Connectors that anchor an ambiguous single word ("on sun", "by 10/15",
// "this evening", "next mon").
const ANCHOR_WORDS = "on|at|by|before|until|till|due|this|next"
const ANCHOR_BEFORE = new RegExp(`\\b(?:${ANCHOR_WORDS})\\s*$`, "i")
const ANCHOR_START = new RegExp(`^(?:${ANCHOR_WORDS})\\s+`, "i")
// Ambiguous one-word matches and how much anchoring they need.
const NOW_WORD = /^(?:right\s+)?now$/i
const ABBR = "(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\\.?"
// "sun", "Mon.", "Mon-Fri", "tue/thu"
const WEEKDAY_ABBR = new RegExp(`^${ABBR}(?:\\s*[-–/]\\s*${ABBR})?$`, "i")
const WEEKDAY_FULL =
    /^(?:sun|mon|tues|wednes|thurs|fri|satur)day$|^(?:tonight|morning|afternoon|evening|noon|midnight)$/i
const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?$/
const POSSESSIVE = /^['’]s\b/i
const TRAILING_REST = /^[\s,.;:!?)\]\-–—]*$/
const REMINDER_ONLY = /^\s*(?:remind\s+me|reminder\s*:)\s*$/i

/** Offset (minutes east of UTC) of `timeZone` at instant `date`. */
export function tzOffsetMinutes(timeZone, date) {
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    })
    const p = {}
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value
    const asUtc = Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        Number(p.hour),
        Number(p.minute),
        Number(p.second)
    )
    const ms = Math.floor(date.getTime() / 1000) * 1000
    return Math.round((asUtc - ms) / 60000)
}

/** Local wall-clock parts of `date` in `timeZone`. */
function wallParts(timeZone, date) {
    const local = new Date(
        date.getTime() + tzOffsetMinutes(timeZone, date) * 60000
    )
    return {
        year: local.getUTCFullYear(),
        month: local.getUTCMonth() + 1,
        day: local.getUTCDate(),
        weekday: local.getUTCDay(),
        hour: local.getUTCHours(),
        minute: local.getUTCMinutes(),
    }
}

/** Convert a wall-clock time in `timeZone` to a UTC Date (DST-aware).
 *  A wall time inside a spring-forward gap (does not exist) resolves to the
 *  same distance past the gap start, e.g. 02:30 -> 03:30 DST. An ambiguous
 *  fall-back time resolves to one of its two occurrences. */
export function wallToUtc(
    timeZone,
    { year, month, day, hour = 0, minute = 0, second = 0 }
) {
    const guess = Date.UTC(year, month - 1, day, hour, minute, second)
    const off1 = tzOffsetMinutes(timeZone, new Date(guess))
    const first = guess - off1 * 60000
    const off2 = tzOffsetMinutes(timeZone, new Date(first))
    if (off2 === off1) return new Date(first)
    const second2 = guess - off2 * 60000
    if (tzOffsetMinutes(timeZone, new Date(second2)) === off2) {
        return new Date(second2)
    }
    // Neither candidate maps back to the wall time: it is in a DST gap.
    // The later candidate applies the pre-transition (standard) offset,
    // i.e. lands after the gap (01:30 PST would be an hour early). In
    // zones west of UTC that is the first candidate, east of UTC the second.
    return new Date(Math.max(first, second2))
}

/** Wall date shifted by `days` (calendar arithmetic, keeps the time). */
function addDays(wall, days) {
    const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days))
    return {
        ...wall,
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
    }
}

function assertTimezone(timeZone) {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone })
    } catch {
        throw new ValidationError(`invalid timezone: ${timeZone}`)
    }
}

/** A chrono result is meaningful when it pins a day, weekday, time or is
 *  relative ("in 2h"). A bare month/year ("March release") is ignored. */
function isUsable(result, tags) {
    const s = result.start
    return (
        s.isCertain("day") ||
        s.isCertain("weekday") ||
        s.isCertain("hour") ||
        tags.some((t) => t === "result/relativeDate" || CASUAL_TIME_TAG.test(t))
    )
}

function capitalize(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s
}

/**
 * Ambiguous one-word matches inside free text: "Sun" (a person), "now
 * playing", "24/7", "morning sync job", "the Sunday digest". Returns true
 * when the match is too weak to be a due date.
 *  - "now" never is (capture is not a timer);
 *  - weekday abbreviations need an anchor ("on sun", "next mon");
 *  - full weekday names and casual times ("tonight", "morning") need an
 *    anchor, or must be the trailing phrase, or directly follow
 *    "remind me" ("remind me sunday to ...");
 *  - "m/d" needs an anchor and a valid month ("by 10/15", not "24/7").
 */
function weakSingleWord(t, before, after) {
    const anchored = ANCHOR_START.test(t) || ANCHOR_BEFORE.test(before)
    const core = t.replace(ANCHOR_START, "").replace(/^the\s+/i, "")
    if (NOW_WORD.test(core)) return true
    if (WEEKDAY_ABBR.test(core)) return !anchored
    if (WEEKDAY_FULL.test(core)) {
        return !(
            anchored ||
            TRAILING_REST.test(after) ||
            REMINDER_ONLY.test(before)
        )
    }
    const slash = SLASH_DATE.exec(core)
    if (slash) return !(anchored && Number(slash[1]) <= 12)
    return false
}

/** Capture mode: drop matches that are unlikely to be a due date. */
function acceptForCapture({ result, tags }, line) {
    const t = result.text.trim()
    if (NOW_WORD.test(t)) return false // never a due date in capture
    if (t === line) return true // the whole input is the date phrase
    if (PAST_WORD.test(t)) return false // "2h ago", "last friday"
    if (tags.includes("result/relativeDate") && BARE_DURATION.test(t)) {
        return false // "1w retention", "404s" (not "in 2h" / "for 2h")
    }
    const before = line.slice(0, result.index)
    if (PAST_BEFORE.test(before)) return false // "broken since monday"
    if (NUMERIC_ONLY.test(t) && !CONNECTOR_BEFORE.test(before)) {
        return false // "the 9 to 5 shift"
    }
    const after = line.slice(result.index + result.text.length)
    if (POSSESSIVE.test(after)) return false // "Friday's build"
    return !weakSingleWord(t, before, after)
}

function nearConnector({ result }, line) {
    const t = result.text.trim()
    return (
        CONNECTOR_START.test(t) ||
        CONNECTOR_WORD.test(t) ||
        CONNECTOR_BEFORE.test(line.slice(0, result.index))
    )
}

/**
 * @param {{ clock?: { now(): Date }, timezone?: string }} deps
 */
export function createDateParser({ clock = systemClock, timezone } = {}) {
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
    assertTimezone(tz)

    /** Next occurrence of a bare "h[:mm]" (no am/pm) within 12 hours. */
    function nextBareHour(hour, minute, second, now) {
        const w = wallParts(tz, now)
        const today = { year: w.year, month: w.month, day: w.day }
        const h = hour % 12
        for (const [days, hh] of [
            [0, h],
            [0, h + 12],
            [1, h],
        ]) {
            const wall = { ...addDays(today, days), hour: hh, minute, second }
            const date = wallToUtc(tz, wall)
            if (date.getTime() > now.getTime()) return date
        }
        /* istanbul ignore next -- tomorrow at h is always > now */
        return null
    }

    /**
     * Resolve a chrono result to a UTC Date per our defaults, or null when
     * the phrase can only mean a past time. Past results are never clamped:
     * - only the weekday was given ("monday", "friday 3pm") -> +7 days;
     * - a bare time of day ("at 5", "3pm") -> tomorrow;
     * - anything with an explicit day ("today 9am", "Nov 1 2020",
     *   "2h ago") -> null.
     */
    function resolve(result, tags, now) {
        const s = result.start
        const nowMs = now.getTime()
        const relative = tags.includes("result/relativeDate")
        const casualTime = tags.some((t) => CASUAL_TIME_TAG.test(t))
        const explicitDay = s.isCertain("day")
        const weekdayOnly = s.isCertain("weekday") && !explicitDay
        const bareTime =
            s.isCertain("hour") &&
            !explicitDay &&
            !s.isCertain("weekday") &&
            !relative

        if (
            tags.includes("result/relativeDateAndTime") ||
            s.isCertain("timezoneOffset")
        ) {
            let date = result.date()
            if (date.getTime() < nowMs && bareTime) {
                date = new Date(date.getTime() + DAY_MS)
            }
            return date.getTime() < nowMs ? null : date
        }

        const keepTime = s.isCertain("hour") || relative || casualTime
        let wall = {
            year: s.get("year"),
            month: s.get("month"),
            day: s.get("day"),
            hour: keepTime ? s.get("hour") : DEFAULT_HOUR,
            minute: keepTime ? s.get("minute") : 0,
            second: keepTime ? s.get("second") || 0 : 0,
        }

        if (/\bnext\s+week\b/i.test(result.text)) {
            // "next week" -> the coming Monday, 09:00 unless a time was given
            const w = wallParts(tz, now)
            const delta = (8 - w.weekday) % 7 || 7
            const timed = s.isCertain("hour")
            wall = {
                ...addDays({ year: w.year, month: w.month, day: w.day }, delta),
                hour: timed ? wall.hour : DEFAULT_HOUR,
                minute: timed ? wall.minute : 0,
                second: timed ? wall.second : 0,
            }
        } else if (
            bareTime &&
            !s.isCertain("meridiem") &&
            !casualTime &&
            wall.hour >= 1 &&
            wall.hour <= 12
        ) {
            // "at 5" at 10:00 -> 17:00 today, not 05:00 tomorrow
            return nextBareHour(wall.hour, wall.minute, wall.second, now)
        }

        let date = wallToUtc(tz, wall)
        if (date.getTime() < nowMs) {
            if (weekdayOnly) date = wallToUtc(tz, addDays(wall, 7))
            else if (bareTime) date = wallToUtc(tz, addDays(wall, 1))
            else return null
        }
        return date.getTime() < nowMs ? null : date
    }

    /** All usable, resolvable (future) date phrases in `text`. */
    function candidates(text) {
        const now = clock.now()
        const offset = tzOffsetMinutes(tz, now)
        const results = chrono.parse(
            text,
            { instant: now, timezone: offset },
            { forwardDate: true }
        )
        const out = []
        for (const result of results) {
            const tags = [...result.tags()]
            if (!isUsable(result, tags)) continue
            const date = resolve(result, tags, now)
            if (date) out.push({ result, tags, date })
        }
        return out
    }

    /** Capture mode: the most plausible due-date phrase in `line`. */
    function pickCapture(line) {
        const all = candidates(line).filter((c) => acceptForCapture(c, line))
        const preferred = all.filter((c) => nearConnector(c, line))
        return (preferred.length ? preferred : all).at(-1) || null
    }

    function parseWhen(text) {
        if (typeof text !== "string" || !text.trim()) return null
        const [found] = candidates(text.trim())
        return found ? found.date.toISOString() : null
    }

    function parseCapture(text) {
        const raw = typeof text === "string" ? text : ""
        const line = (raw.split(/\r?\n/).find((l) => l.trim()) || "").trim()
        const found = line ? pickCapture(line) : null
        // Only an explicit "remind me ..." / "reminder: ..." is a reminder;
        // "Reminders page crashes on Sunday" is an ordinary todo.
        const isReminder = REMINDER_PREFIX.test(line)

        let title = line
        if (found) {
            const { index, text: matched } = found.result
            const before = line.slice(0, index).replace(TRAILING_CONNECTOR, "")
            const after = line.slice(index + matched.length)
            title = `${before} ${after}`
        }
        if (isReminder) title = title.replace(REMINDER_STRIP, "")
        title = title
            .replace(/\s+/g, " ")
            .replace(/ ([,.;:!?])/g, "$1")
            .replace(EDGE_PUNCT, "")
        title = capitalize(title).slice(0, MAX_TITLE)
        if (!title) title = isReminder ? "Reminder" : line.slice(0, MAX_TITLE)

        return {
            isReminder,
            title,
            due_at: found ? found.date.toISOString() : null,
            matchedText: found ? found.result.text : null,
        }
    }

    return { parseCapture, parseWhen, timezone: tz }
}
