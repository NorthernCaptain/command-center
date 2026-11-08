/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Sprint section names look like "Nov 2 - Nov 8", "April 20 - 26",
// "March 30 - April 3rd". They carry no year. All dates here are local
// calendar dates (midnight local time) with an inclusive end day.

const MONTHS = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
]

const MAX_SPAN_DAYS = 31
const GAP_DAYS = 3

const NAME_RE =
    /^\s*([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*[-–—]\s*(?:([a-z]+)\.?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s*$/i

/** "Nov" / "November" / "Sept" -> 0-based month, or -1. */
export function monthIndex(token) {
    const t = String(token || "").toLowerCase()
    if (t.length < 3) return -1
    return MONTHS.findIndex((m) => m.startsWith(t))
}

function localDate(year, month, day) {
    const d = new Date(year, month, day)
    // Reject overflow such as "Feb 31".
    if (d.getMonth() !== month || d.getDate() !== day) {
        return null
    }
    return d
}

/** Local midnight of the given instant. */
export function startOfDay(date) {
    const d = new Date(date)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function daysBetween(a, b) {
    // Round to absorb DST hour shifts.
    return Math.round((b.getTime() - a.getTime()) / 86400000)
}

/**
 * Parse a sprint section name for a reference year.
 * @param {string} name
 * @param {number} refYear year of the start date
 * @returns {{ start: Date, end: Date } | null}
 */
export function parseSectionName(name, refYear) {
    const m = NAME_RE.exec(String(name || ""))
    if (!m) return null
    const startMonth = monthIndex(m[1])
    if (startMonth < 0) return null
    const startDay = Number(m[2])
    const endDay = Number(m[4])
    let endMonth = startMonth
    if (m[3]) {
        endMonth = monthIndex(m[3])
        if (endMonth < 0) return null
    } else if (endDay < startDay) {
        // "April 28 - 3": the end day is in the following month.
        endMonth = (startMonth + 1) % 12
    }
    const endYear = endMonth < startMonth ? refYear + 1 : refYear
    const start = localDate(refYear, startMonth, startDay)
    const end = localDate(endYear, endMonth, endDay)
    if (!start || !end) return null
    const span = daysBetween(start, end)
    if (span < 0 || span > MAX_SPAN_DAYS) return null
    return { start, end }
}

/** Local midnight of the Monday of the week containing `d` (Mon-start). */
export function mondayOf(d) {
    const t = startOfDay(d)
    const back = (t.getDay() + 6) % 7
    return new Date(t.getFullYear(), t.getMonth(), t.getDate() - back)
}

/**
 * True when `today` is a weekend gap day right after a sprint that ended
 * early (e.g. it ended Friday and today is Sat/Sun): today is Saturday or
 * Sunday, the end is at most 3 days ago, and no new Monday-start week has
 * begun since the end (so a Monday never maps to last week's section).
 */
export function isGapDay(end, today) {
    const t = startOfDay(today)
    const dow = t.getDay()
    if (dow !== 6 && dow !== 0) return false
    const gap = daysBetween(end, t)
    if (gap < 1 || gap > GAP_DAYS) return false
    return mondayOf(end).getTime() === mondayOf(t).getTime()
}

/**
 * Pick the sprint section for `today`:
 *  1. a section whose [start, end] contains today (latest start wins);
 *  2. else, on a gap day after a section that ended early this week (e.g.
 *     the sprint ended Friday, today is Saturday/Sunday), that section;
 *  3. else null (a Monday never falls back to last week's section).
 * Names are tried with the current year and the previous year (December
 * sections near New Year).
 * @param {{gid: string, name: string}[]} sections
 * @param {Date} [today]
 * @returns {{ gid: string, name: string, start: Date, end: Date } | null}
 */
export function pickSection(sections, today = new Date()) {
    const t = startOfDay(today)
    const year = t.getFullYear()
    let containing = null
    let recent = null
    for (const section of sections || []) {
        for (const refYear of [year, year - 1]) {
            const range = parseSectionName(section?.name, refYear)
            if (!range) continue
            const candidate = { gid: section.gid, name: section.name, ...range }
            if (range.start <= t && t <= range.end) {
                if (!containing || range.start > containing.start) {
                    containing = candidate
                }
            } else if (range.end < t && isGapDay(range.end, t)) {
                if (!recent || range.start > recent.start) recent = candidate
            }
        }
    }
    return containing || recent
}
