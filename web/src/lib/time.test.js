/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    clockTime,
    formatDue,
    localInputToIso,
    parseWhenLocal,
    relativeTime,
    shortDate,
    snoozePresets,
} from "./time.js"

// Local-time fixtures (tests don't depend on the machine's timezone).
const NOW = new Date(2026, 10, 7, 12, 0, 0) // Sat Nov 7 2026 12:00 local

describe("relativeTime", () => {
    it("handles empty / invalid input", () => {
        expect(relativeTime(null, NOW)).toBe("")
        expect(relativeTime("garbage", NOW)).toBe("")
        expect(relativeTime(undefined, NOW)).toBe("")
    })
    it("formats past and future", () => {
        expect(relativeTime(new Date(NOW.getTime() - 10 * 1000), NOW)).toBe(
            "just now"
        )
        expect(relativeTime(new Date(NOW.getTime() + 10 * 1000), NOW)).toBe(
            "in a moment"
        )
        expect(relativeTime(new Date(NOW.getTime() - 5 * 60 * 1000), NOW)).toBe(
            "5m ago"
        )
        expect(
            relativeTime(new Date(NOW.getTime() + 2 * 3600 * 1000), NOW)
        ).toBe("in 2h")
        expect(
            relativeTime(new Date(NOW.getTime() - 3 * 86400 * 1000), NOW)
        ).toBe("3d ago")
    })
    it("falls back to a date after a week", () => {
        expect(relativeTime(new Date(2026, 9, 1), NOW)).toBe("Oct 1")
        expect(relativeTime(new Date(2025, 9, 1), NOW)).toBe("Oct 1, 2025")
    })
    it("accepts ISO strings", () => {
        const iso = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()
        expect(relativeTime(iso, NOW)).toBe("1h ago")
    })
})

describe("clockTime / shortDate", () => {
    it("formats", () => {
        expect(clockTime(new Date(2026, 0, 2, 9, 5))).toBe("09:05")
        expect(clockTime(null)).toBe("")
        expect(shortDate(null)).toBe("")
        expect(shortDate(new Date(2026, 11, 25), NOW)).toBe("Dec 25")
    })
})

describe("formatDue", () => {
    it("uses calendar words", () => {
        expect(formatDue(new Date(2026, 10, 7, 15, 30), NOW)).toBe(
            "today 15:30"
        )
        expect(formatDue(new Date(2026, 10, 8, 9, 0), NOW)).toBe(
            "tomorrow 09:00"
        )
        expect(formatDue(new Date(2026, 10, 6, 18, 0), NOW)).toBe(
            "yesterday 18:00"
        )
        expect(formatDue(new Date(2026, 10, 10, 9, 0), NOW)).toBe("Tue 09:00")
        expect(formatDue(new Date(2026, 10, 20, 9, 0), NOW)).toBe(
            "Nov 20 09:00"
        )
        expect(formatDue(null, NOW)).toBe("")
    })
})

describe("snoozePresets", () => {
    it("computes concrete times", () => {
        const [twoH, tomorrow, nextWeek] = snoozePresets(NOW)
        expect(new Date(twoH.at).getTime() - NOW.getTime()).toBe(
            2 * 3600 * 1000
        )
        expect(new Date(tomorrow.at)).toEqual(new Date(2026, 10, 8, 9, 0))
        // NOW is Saturday -> next Monday is Nov 9
        expect(new Date(nextWeek.at)).toEqual(new Date(2026, 10, 9, 9, 0))
        expect(twoH.when).toBe("in 2h")
    })
    it("next week from a Monday is the following Monday", () => {
        const monday = new Date(2026, 10, 9, 8, 0)
        expect(new Date(snoozePresets(monday)[2].at)).toEqual(
            new Date(2026, 10, 16, 9, 0)
        )
    })
})

describe("parseWhenLocal", () => {
    it("parses relative durations", () => {
        expect(parseWhenLocal("2h", NOW)).toBe(
            new Date(NOW.getTime() + 2 * 3600e3).toISOString()
        )
        expect(parseWhenLocal("in 30m", NOW)).toBe(
            new Date(NOW.getTime() + 30 * 60e3).toISOString()
        )
        expect(parseWhenLocal("3 days", NOW)).toBe(
            new Date(NOW.getTime() + 3 * 86400e3).toISOString()
        )
        expect(parseWhenLocal("1w", NOW)).toBe(
            new Date(NOW.getTime() + 7 * 86400e3).toISOString()
        )
    })
    it("parses tomorrow / next week", () => {
        expect(parseWhenLocal("tomorrow", NOW)).toBe(
            new Date(2026, 10, 8, 9, 0).toISOString()
        )
        expect(parseWhenLocal("tomorrow 3pm", NOW)).toBe(
            new Date(2026, 10, 8, 15, 0).toISOString()
        )
        expect(parseWhenLocal("tomorrow at 10:30am", NOW)).toBe(
            new Date(2026, 10, 8, 10, 30).toISOString()
        )
        expect(parseWhenLocal("tomorrow 14:15", NOW)).toBe(
            new Date(2026, 10, 8, 14, 15).toISOString()
        )
        expect(parseWhenLocal("tomorrow 12am", NOW)).toBe(
            new Date(2026, 10, 8, 0, 0).toISOString()
        )
        expect(parseWhenLocal("next week", NOW)).toBe(
            new Date(2026, 10, 9, 9, 0).toISOString()
        )
    })
    it("returns null for things it can't read", () => {
        expect(parseWhenLocal("", NOW)).toBeNull()
        expect(parseWhenLocal(null, NOW)).toBeNull()
        expect(parseWhenLocal("friday 2pm", NOW)).toBeNull()
        expect(parseWhenLocal("tomorrow 25", NOW)).toBeNull()
    })
})

describe("localInputToIso", () => {
    it("converts datetime-local values", () => {
        expect(localInputToIso("2026-11-08T09:00")).toBe(
            new Date(2026, 10, 8, 9, 0).toISOString()
        )
        expect(localInputToIso("")).toBeNull()
        expect(localInputToIso("nope")).toBeNull()
    })
})
