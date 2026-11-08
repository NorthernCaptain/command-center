/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { createDateParser, tzOffsetMinutes, wallToUtc } from "./dateParser.js"
import { createFakeClock } from "../util/clock.js"
import { ValidationError } from "../util/errors.js"

const LA = "America/Los_Angeles"
const BERLIN = "Europe/Berlin"
// Saturday 2026-11-07: 12:00 in LA (PST, -8), 21:00 in Berlin (CET, +1)
const SAT_NOON_LA = "2026-11-07T20:00:00.000Z"

function parser(timezone, at = SAT_NOON_LA) {
    const clock = createFakeClock(at)
    return { clock, p: createDateParser({ clock, timezone }) }
}

describe("tz helpers", () => {
    test("tzOffsetMinutes handles standard and daylight time", () => {
        expect(tzOffsetMinutes(LA, new Date("2026-11-07T20:00:00Z"))).toBe(-480)
        expect(tzOffsetMinutes(LA, new Date("2026-07-01T20:00:00Z"))).toBe(-420)
        expect(tzOffsetMinutes(BERLIN, new Date("2026-07-01T20:00:00Z"))).toBe(
            120
        )
        expect(tzOffsetMinutes("UTC", new Date("2026-07-01T20:00:00Z"))).toBe(0)
    })

    test("wallToUtc: a wall time in the spring-forward gap moves forward", () => {
        // 2026-03-08 02:00 PST -> 03:00 PDT; 02:30 does not exist
        const gap = { year: 2026, month: 3, day: 8, hour: 2, minute: 30 }
        expect(wallToUtc(LA, gap).toISOString()).toBe(
            "2026-03-08T10:30:00.000Z" // 03:30 PDT, not 01:30 PST
        )
        expect(wallToUtc(LA, { ...gap, hour: 1 }).toISOString()).toBe(
            "2026-03-08T09:30:00.000Z" // 01:30 PST
        )
        expect(wallToUtc(LA, { ...gap, hour: 3 }).toISOString()).toBe(
            "2026-03-08T10:30:00.000Z" // 03:30 PDT
        )
        // Berlin 2026-03-29 02:00 CET -> 03:00 CEST
        expect(
            wallToUtc(BERLIN, {
                year: 2026,
                month: 3,
                day: 29,
                hour: 2,
                minute: 30,
            }).toISOString()
        ).toBe("2026-03-29T01:30:00.000Z") // 03:30 CEST
    })

    test("wallToUtc: an ambiguous fall-back time takes the first occurrence", () => {
        // 2026-11-01 01:30 happens twice in LA; first is PDT (-7)
        expect(
            wallToUtc(LA, {
                year: 2026,
                month: 11,
                day: 1,
                hour: 1,
                minute: 30,
            }).toISOString()
        ).toBe("2026-11-01T08:30:00.000Z")
    })

    test("wallToUtc resolves local wall time across DST", () => {
        const w = { year: 2026, month: 11, day: 1, hour: 10 }
        // US DST ends 2026-11-01 02:00 -> 10:00 is PST
        expect(wallToUtc(LA, w).toISOString()).toBe("2026-11-01T18:00:00.000Z")
        expect(
            wallToUtc(LA, { year: 2026, month: 10, day: 31, hour: 10 })
        ).toEqual(new Date("2026-10-31T17:00:00.000Z"))
    })
})

describe("createDateParser", () => {
    test("rejects an invalid timezone", () => {
        expect(() => createDateParser({ timezone: "Nowhere/Land" })).toThrow(
            ValidationError
        )
    })

    test("defaults to the system clock and timezone", () => {
        const p = createDateParser()
        expect(typeof p.timezone).toBe("string")
        const iso = p.parseWhen("in 2 hours")
        const diff = new Date(iso).getTime() - Date.now()
        expect(diff).toBeGreaterThan(2 * 3600e3 - 60e3)
        expect(diff).toBeLessThan(2 * 3600e3 + 60e3)
    })
})

describe("parseCapture", () => {
    test("reminder story C3 in Los Angeles", () => {
        const { p } = parser(LA)
        expect(
            p.parseCapture("remind me to talk to Ron about 123 tomorrow 10am")
        ).toEqual({
            isReminder: true,
            title: "Talk to Ron about 123",
            due_at: "2026-11-08T18:00:00.000Z",
            matchedText: "tomorrow 10am",
        })
    })

    test("reminder story C3 in Berlin", () => {
        const { p } = parser(BERLIN)
        const r = p.parseCapture(
            "remind me to talk to Ron about 123 tomorrow 10am"
        )
        expect(r.due_at).toBe("2026-11-08T09:00:00.000Z")
        expect(r.title).toBe("Talk to Ron about 123")
    })

    test("'tomorrow' uses the local date of the configured timezone", () => {
        // 03:00Z Sunday = Saturday 19:00 in LA, Sunday 04:00 in Berlin
        const at = "2026-11-08T03:00:00.000Z"
        expect(parser(LA, at).p.parseCapture("remind me tomorrow").due_at).toBe(
            "2026-11-08T17:00:00.000Z"
        )
        expect(
            parser(BERLIN, at).p.parseCapture("remind me tomorrow").due_at
        ).toBe("2026-11-09T08:00:00.000Z")
    })

    test("'tomorrow' without a time defaults to 09:00 local", () => {
        const { p } = parser(LA)
        const r = p.parseCapture("remind me tomorrow to call Ron")
        expect(r.title).toBe("Call Ron")
        expect(r.due_at).toBe("2026-11-08T17:00:00.000Z")
    })

    test("DST: wall time is resolved for the target date (LA)", () => {
        // Sat 2026-10-31 12:00 PDT; Sunday Nov 1 is already PST
        const { p } = parser(LA, "2026-10-31T19:00:00.000Z")
        expect(p.parseCapture("remind me to x tomorrow 10am").due_at).toBe(
            "2026-11-01T18:00:00.000Z"
        )
    })

    test("DST: wall time is resolved for the target date (Berlin)", () => {
        // Sat 2026-10-24 12:00 CEST; Sunday Oct 25 is already CET
        const { p } = parser(BERLIN, "2026-10-24T10:00:00.000Z")
        expect(p.parseCapture("remind me to x tomorrow 10am").due_at).toBe(
            "2026-10-25T09:00:00.000Z"
        )
    })

    test("weekday with time and leading 'on'", () => {
        const { p } = parser(LA)
        const r = p.parseCapture("remind me to call mom on Friday at 3pm")
        expect(r).toMatchObject({
            isReminder: true,
            title: "Call mom",
            due_at: "2026-11-13T23:00:00.000Z",
            matchedText: "on Friday at 3pm",
        })
    })

    test("'next monday' defaults to 09:00", () => {
        const { p } = parser(BERLIN)
        const r = p.parseCapture("Reminder: pay rent next monday")
        expect(r.isReminder).toBe(true)
        expect(r.title).toBe("Pay rent")
        expect(r.due_at).toBe("2026-11-09T08:00:00.000Z")
    })

    test("relative durations keep the exact time", () => {
        const { p } = parser(LA)
        expect(p.parseCapture("remind me in 2h to stretch")).toMatchObject({
            title: "Stretch",
            due_at: "2026-11-07T22:00:00.000Z",
        })
        expect(p.parseCapture("Remind me in a week")).toEqual({
            isReminder: true,
            title: "Reminder",
            due_at: "2026-11-14T20:00:00.000Z",
            matchedText: "in a week",
        })
    })

    test("reminder without a date", () => {
        const { p } = parser(LA)
        expect(p.parseCapture("remind me to call Sam")).toEqual({
            isReminder: true,
            title: "Call Sam",
            due_at: null,
            matchedText: null,
        })
    })

    test("non-reminder with a date keeps due_at", () => {
        const { p } = parser(LA)
        const r = p.parseCapture("fix bug by 5pm")
        expect(r).toEqual({
            isReminder: false,
            title: "Fix bug",
            due_at: "2026-11-08T01:00:00.000Z",
            matchedText: "5pm",
        })
    })

    test("'remind' elsewhere in the line + date is not a reminder", () => {
        const { p } = parser(LA)
        const r = p.parseCapture("ping Ron tomorrow, he asked me to remind him")
        expect(r.isReminder).toBe(false)
        expect(r.due_at).toBe("2026-11-08T17:00:00.000Z")
    })

    test("'remind' without a date is not a reminder", () => {
        const { p } = parser(LA)
        const r = p.parseCapture("write a remind feature")
        expect(r.isReminder).toBe(false)
        expect(r.due_at).toBeNull()
        expect(r.title).toBe("Write a remind feature")
    })

    test("plain text without dates", () => {
        const { p } = parser(LA)
        expect(p.parseCapture("review PR 812 for v1.2.3")).toEqual({
            isReminder: false,
            title: "Review PR 812 for v1.2.3",
            due_at: null,
            matchedText: null,
        })
    })

    test("a bare month name is not a date", () => {
        const { p } = parser(LA)
        const r = p.parseCapture("March release notes")
        expect(r.due_at).toBeNull()
        expect(r.title).toBe("March release notes")
    })

    test("strips punctuation and the date phrase mid-sentence", () => {
        const { p } = parser(LA)
        const r = p.parseCapture("talk to Ron tomorrow about it, please!")
        expect(r.title).toBe("Talk to Ron about it, please")
        expect(r.isReminder).toBe(false)
    })

    test("strips dangling 'by' before the date phrase", () => {
        const { p } = parser(LA)
        expect(p.parseCapture("by Friday finish report").title).toBe(
            "Finish report"
        )
    })

    test("strips 'remind me that/about' and colons", () => {
        const { p } = parser(LA)
        expect(p.parseCapture("remind me about the deploy").title).toBe(
            "The deploy"
        )
        expect(p.parseCapture("Remind me: call Ron").title).toBe("Call Ron")
        expect(p.parseCapture("reminder: ").title).toBe("Reminder")
    })

    test("uses only the first non-empty line", () => {
        const { p } = parser(LA)
        const r = p.parseCapture("\n  remind me to ship it\nNov 20 meeting")
        expect(r).toEqual({
            isReminder: true,
            title: "Ship it",
            due_at: null,
            matchedText: null,
        })
    })

    test("date-only text falls back to the text as title", () => {
        const { p } = parser(LA)
        const r = p.parseCapture("tomorrow")
        expect(r.title).toBe("tomorrow")
        expect(r.due_at).toBe("2026-11-08T17:00:00.000Z")
    })

    test("never returns a time in the past, never clamps to now", () => {
        const { p } = parser(LA)
        // 'today' -> 09:00 local, already past at noon -> not a due date
        expect(p.parseCapture("remind me today")).toEqual({
            isReminder: true,
            title: "Today",
            due_at: null,
            matchedText: null,
        })
        // 'at 9am' after 9am -> tomorrow (no explicit day)
        expect(p.parseCapture("remind me at 9am").due_at).toBe(
            "2026-11-08T17:00:00.000Z"
        )
    })

    test("evening/morning casual times are kept", () => {
        const { p } = parser(LA)
        expect(p.parseCapture("remind me tonight").due_at).toBe(
            "2026-11-08T06:00:00.000Z"
        )
    })

    test("explicit timezone in text wins", () => {
        const { p } = parser(BERLIN)
        expect(p.parseCapture("remind me tomorrow 10am PST").due_at).toBe(
            "2026-11-08T18:00:00.000Z"
        )
    })

    test("handles empty and non-string input", () => {
        const { p } = parser(LA)
        expect(p.parseCapture("")).toEqual({
            isReminder: false,
            title: "",
            due_at: null,
            matchedText: null,
        })
        expect(p.parseCapture(undefined).due_at).toBeNull()
    })

    test("truncates long titles to 300 chars", () => {
        const { p } = parser(LA)
        const r = p.parseCapture(`remind me to ${"x".repeat(400)} tomorrow`)
        expect(r.title).toHaveLength(300)
    })
})

describe("parseWhen", () => {
    const cases = [
        ["2h", "2026-11-07T22:00:00.000Z"],
        ["30m", "2026-11-07T20:30:00.000Z"],
        ["3d", "2026-11-10T20:00:00.000Z"],
        ["1w", "2026-11-14T20:00:00.000Z"],
        ["in 2 hours", "2026-11-07T22:00:00.000Z"],
        ["tomorrow", "2026-11-08T17:00:00.000Z"],
        ["tomorrow 9am", "2026-11-08T17:00:00.000Z"],
        ["next week", "2026-11-09T17:00:00.000Z"],
        ["next week 10am", "2026-11-09T18:00:00.000Z"],
        ["  next monday  ", "2026-11-09T17:00:00.000Z"],
        ["2026-11-10T10:00:00Z", "2026-11-10T10:00:00.000Z"],
    ]
    test.each(cases)("LA: %s -> %s", (text, expected) => {
        expect(parser(LA).p.parseWhen(text)).toBe(expected)
    })

    test("Berlin: next week / tomorrow use Berlin wall time", () => {
        const { p } = parser(BERLIN)
        expect(p.parseWhen("next week")).toBe("2026-11-09T08:00:00.000Z")
        expect(p.parseWhen("tomorrow 9am")).toBe("2026-11-08T08:00:00.000Z")
        expect(p.parseWhen("2h")).toBe("2026-11-07T22:00:00.000Z")
    })

    test("'next week' on a Sunday is the next day (Monday)", () => {
        // Sunday 2026-11-08 12:00 in LA
        const { p } = parser(LA, "2026-11-08T20:00:00.000Z")
        expect(p.parseWhen("next week")).toBe("2026-11-09T17:00:00.000Z")
    })

    test("'next week' on a Monday is a week later", () => {
        const { p } = parser(LA, "2026-11-09T20:00:00.000Z")
        expect(p.parseWhen("next week")).toBe("2026-11-16T17:00:00.000Z")
    })

    test("follows the clock", async () => {
        const { p, clock } = parser(LA)
        await clock.advance(3600e3)
        expect(p.parseWhen("2h")).toBe("2026-11-07T23:00:00.000Z")
    })

    test("returns null for garbage and empty input", () => {
        const { p } = parser(LA)
        expect(p.parseWhen("garbage")).toBeNull()
        expect(p.parseWhen("")).toBeNull()
        expect(p.parseWhen("   ")).toBeNull()
        expect(p.parseWhen(null)).toBeNull()
        expect(p.parseWhen(42)).toBeNull()
    })
})

// Monday 2026-11-09 10:00 in LA (PST)
const MON_10_LA = "2026-11-09T18:00:00.000Z"
// Friday 2026-11-13 16:00 in LA (PST)
const FRI_16_LA = "2026-11-14T00:00:00.000Z"

describe("past results are rolled forward or rejected, never clamped", () => {
    test("weekday-only phrase on that weekday after the time -> next week", () => {
        const { p } = parser(LA, MON_10_LA)
        // 'monday' -> 09:00 today is past -> Monday next week 09:00
        expect(p.parseWhen("monday")).toBe("2026-11-16T17:00:00.000Z")
        // later the same day is still today
        expect(p.parseWhen("monday 11am")).toBe("2026-11-09T19:00:00.000Z")
        const r = p.parseCapture("snooze report until monday")
        expect(r.due_at).toBe("2026-11-16T17:00:00.000Z")
    })

    test("'friday at 3pm' on Friday 16:00 -> next Friday 15:00", () => {
        const { p } = parser(LA, FRI_16_LA)
        expect(p.parseWhen("friday at 3pm")).toBe("2026-11-20T23:00:00.000Z")
        expect(p.parseWhen("friday")).toBe("2026-11-20T17:00:00.000Z")
        expect(p.parseWhen("on friday at 5pm")).toBe("2026-11-14T01:00:00.000Z")
        expect(
            p.parseCapture("remind me to call mom on Friday at 3pm").due_at
        ).toBe("2026-11-20T23:00:00.000Z")
    })

    test("explicit 'today' in the past is unparseable", () => {
        const { p } = parser(LA, MON_10_LA)
        expect(p.parseWhen("today 9am")).toBeNull()
        expect(p.parseWhen("today")).toBeNull()
        expect(p.parseWhen("today 11am")).toBe("2026-11-09T19:00:00.000Z")
        expect(p.parseCapture("remind me today 9am").due_at).toBeNull()
    })

    test("absolute past dates and 'ago' are unparseable", () => {
        const { p } = parser(LA, MON_10_LA)
        expect(p.parseWhen("2026-11-01")).toBeNull()
        expect(p.parseWhen("2026-11-01T10:00:00Z")).toBeNull()
        expect(p.parseWhen("2h ago")).toBeNull()
    })

    test("a bare time of day already past rolls to tomorrow", () => {
        const { p } = parser(LA, MON_10_LA)
        expect(p.parseWhen("9am")).toBe("2026-11-10T17:00:00.000Z")
        expect(p.parseWhen("3pm")).toBe("2026-11-09T23:00:00.000Z")
        expect(p.parseWhen("5pm PST")).toBe("2026-11-10T01:00:00.000Z")
        expect(p.parseWhen("9am PST")).toBe("2026-11-10T17:00:00.000Z")
    })

    test("'tomorrow' and 'next week' defaults are always in the future", () => {
        // 23:59 Sunday in LA
        const { p } = parser(LA, "2026-11-09T07:59:00.000Z")
        expect(p.parseWhen("tomorrow")).toBe("2026-11-09T17:00:00.000Z")
        expect(p.parseWhen("next week")).toBe("2026-11-09T17:00:00.000Z")
        // 00:01 Monday in Berlin
        const b = parser(BERLIN, "2026-11-08T23:01:00.000Z").p
        expect(b.parseWhen("tomorrow")).toBe("2026-11-10T08:00:00.000Z")
        expect(b.parseWhen("next week")).toBe("2026-11-16T08:00:00.000Z")
    })

    test("DST gap: 'tomorrow 2:30am' before spring-forward is 03:30 PDT", () => {
        // Sat 2026-03-07 12:00 PST
        const { p } = parser(LA, "2026-03-07T20:00:00.000Z")
        expect(p.parseWhen("tomorrow 2:30am")).toBe("2026-03-08T10:30:00.000Z")
        expect(p.parseWhen("tomorrow 1:30am")).toBe("2026-03-08T09:30:00.000Z")
    })
})

describe("bare hours without am/pm", () => {
    test("resolve to the next occurrence within 12 hours", () => {
        const { p } = parser(LA, MON_10_LA)
        expect(p.parseWhen("at 5")).toBe("2026-11-10T01:00:00.000Z") // 17:00
        expect(p.parseWhen("at 11")).toBe("2026-11-09T19:00:00.000Z") // 11:00
        expect(p.parseWhen("at 9")).toBe("2026-11-10T05:00:00.000Z") // 21:00
        expect(p.parseWhen("at 5:30")).toBe("2026-11-10T01:30:00.000Z")
        expect(p.parseWhen("at 12")).toBe("2026-11-09T20:00:00.000Z") // noon
        // 24h clock is unambiguous
        expect(p.parseWhen("at 17")).toBe("2026-11-10T01:00:00.000Z")
    })

    test("wraps past midnight", () => {
        // Monday 23:00 in LA
        const { p } = parser(LA, "2026-11-10T07:00:00.000Z")
        expect(p.parseWhen("at 12")).toBe("2026-11-10T08:00:00.000Z") // 00:00
        expect(p.parseWhen("at 5")).toBe("2026-11-10T13:00:00.000Z") // 05:00
    })

    test("uses the configured timezone", () => {
        // Monday 10:00 in Berlin
        const { p } = parser(BERLIN, "2026-11-09T09:00:00.000Z")
        expect(p.parseWhen("at 5")).toBe("2026-11-09T16:00:00.000Z")
    })
})

describe("parseCapture picks the right date phrase", () => {
    test("bare short forms inside text are not dates", () => {
        const { p } = parser(LA, MON_10_LA)
        expect(
            p.parseCapture(
                "remind me to check the 1w retention metric tomorrow"
            )
        ).toEqual({
            isReminder: true,
            title: "Check the 1w retention metric",
            due_at: "2026-11-10T17:00:00.000Z",
            matchedText: "tomorrow",
        })
        expect(
            p.parseCapture("remind me to look at 404s tomorrow 3pm")
        ).toEqual({
            isReminder: true,
            title: "Look at 404s",
            due_at: "2026-11-10T23:00:00.000Z",
            matchedText: "tomorrow 3pm",
        })
        expect(p.parseCapture("the 2 days workshop").due_at).toBeNull()
    })

    test("anchored short forms and whole-input short forms are dates", () => {
        const { p } = parser(LA, MON_10_LA)
        expect(p.parseCapture("block for 2h to review")).toMatchObject({
            title: "Block to review",
            due_at: "2026-11-09T20:00:00.000Z",
            matchedText: "for 2h",
        })
        expect(p.parseCapture("ping Ron in 30m").due_at).toBe(
            "2026-11-09T18:30:00.000Z"
        )
        expect(p.parseCapture("2h")).toMatchObject({
            title: "2h",
            due_at: "2026-11-09T20:00:00.000Z",
        })
        expect(p.parseCapture("ship it 2 days later").due_at).toBe(
            "2026-11-11T18:00:00.000Z"
        )
    })

    test("past-tagged phrases are ignored", () => {
        const { p } = parser(LA, MON_10_LA)
        expect(p.parseCapture("Fix bug 2h ago in prod")).toEqual({
            isReminder: false,
            title: "Fix bug 2h ago in prod",
            due_at: null,
            matchedText: null,
        })
        expect(p.parseCapture("Fix bug seen 2h ago, by tomorrow").due_at).toBe(
            "2026-11-10T17:00:00.000Z"
        )
    })

    test("plain numbers in words are not times", () => {
        const { p } = parser(LA, MON_10_LA)
        expect(p.parseCapture("Fix the 9 to 5 shift report")).toEqual({
            isReminder: false,
            title: "Fix the 9 to 5 shift report",
            due_at: null,
            matchedText: null,
        })
        // with a connector it is a time
        expect(p.parseCapture("meet at 9 to 5").matchedText).toBe("at 9 to 5")
    })

    test("'call mom at 5' at 10:00 is 17:00 today", () => {
        const { p } = parser(LA, MON_10_LA)
        expect(p.parseCapture("remind me to call mom at 5")).toEqual({
            isReminder: true,
            title: "Call mom",
            due_at: "2026-11-10T01:00:00.000Z",
            matchedText: "at 5",
        })
    })

    test("prefers a phrase next to a connector, else the last one", () => {
        const { p } = parser(LA, MON_10_LA)
        // "Nov 20" has no connector; "by Friday" does
        const a = p.parseCapture("finish the Nov 20 deck by Friday")
        expect(a.matchedText).toBe("Friday")
        expect(a.title).toBe("Finish the Nov 20 deck")
        expect(a.due_at).toBe("2026-11-13T17:00:00.000Z")
        // two connector phrases -> the last one; only it is stripped
        const b = p.parseCapture(
            "remind me to ship on monday, then sync tomorrow"
        )
        expect(b).toMatchObject({
            title: "Ship on monday, then sync",
            matchedText: "tomorrow",
            due_at: "2026-11-10T17:00:00.000Z",
        })
        // no connectors -> the last phrase
        const c = p.parseCapture("Nov 20 review, Dec 1 launch")
        expect(c.matchedText).toBe("Dec 1")
        expect(c.title).toBe("Nov 20 review, launch")
    })
})

describe("reminder detection and ambiguous tokens (N1 regressions)", () => {
    // Ordinary todo / bug-report lines: never reminders, no due date and
    // the title is the line itself (only capitalized).
    const ORDINARY = [
        "Reminder push broken since monday",
        "Remove the reminder banner now",
        "reminders list is empty after login",
        "Reminder emails go out twice",
        "fix the mon dashboard",
        "check sat images",
        "release 3/4 done",
        "Support 24/7 uptime monitoring",
        "fix crash in morning sync job",
        "update the Sunday digest",
        "Weekly sync notes from last friday",
        "fix tue/thu schedule",
        "Wed release checklist",
        "Evening digest email is empty",
        "Noon report shows wrong totals",
        "Tonight mode toggle broken",
        "Add a now-playing badge",
        "Fix the now playing widget",
        "Sun glare in outdoor video",
        "Fix Mon-Fri filter on calendar",
        "Check on Friday's build output",
        "now",
    ]

    test.each(ORDINARY)("%s -> not a reminder, title unchanged", (line) => {
        const { p } = parser(LA)
        expect(p.parseCapture(line)).toEqual({
            isReminder: false,
            title: line[0].toUpperCase() + line.slice(1),
            due_at: null,
            matchedText: null,
        })
    })

    test("a 'Reminder...' word with a real date is still not a reminder", () => {
        const { p } = parser(LA)
        for (const line of [
            "Reminders page crashes on Sunday",
            "Crash in reminder settings on Sunday",
        ]) {
            const r = p.parseCapture(line)
            expect(r.isReminder).toBe(false)
            expect(r.matchedText).toBe("on Sunday")
        }
    })

    test("non-date tokens inside a real reminder are kept in the title", () => {
        const { p } = parser(LA)
        expect(
            p.parseCapture("remind me to check the 24/7 support page")
        ).toEqual({
            isReminder: true,
            title: "Check the 24/7 support page",
            due_at: null,
            matchedText: null,
        })
        expect(
            p.parseCapture("remind me to fix the now playing widget")
        ).toEqual({
            isReminder: true,
            title: "Fix the now playing widget",
            due_at: null,
            matchedText: null,
        })
        expect(p.parseCapture("remind me to email Sun about the deck")).toEqual(
            {
                isReminder: true,
                title: "Email Sun about the deck",
                due_at: null,
                matchedText: null,
            }
        )
        expect(p.parseCapture("remind me to ship by 24/7")).toMatchObject({
            title: "Ship by 24/7",
            due_at: null,
        })
    })

    test("true reminders still parse", () => {
        const { p } = parser(LA)
        expect(
            p.parseCapture("remind me to talk to Ron about 123 tomorrow 10am")
        ).toEqual({
            isReminder: true,
            title: "Talk to Ron about 123",
            due_at: "2026-11-08T18:00:00.000Z",
            matchedText: "tomorrow 10am",
        })
        expect(p.parseCapture("remind me on friday to file taxes")).toEqual({
            isReminder: true,
            title: "File taxes",
            due_at: "2026-11-13T17:00:00.000Z",
            matchedText: "on friday",
        })
        expect(p.parseCapture("remind me in 2h to check PR comments")).toEqual({
            isReminder: true,
            title: "Check PR comments",
            due_at: "2026-11-07T22:00:00.000Z",
            matchedText: "in 2h",
        })
        expect(p.parseCapture("reminder: standup notes next monday")).toEqual({
            isReminder: true,
            title: "Standup notes",
            due_at: "2026-11-09T17:00:00.000Z",
            matchedText: "next monday",
        })
    })

    test("anchored, trailing or leading weekday/casual words are dates", () => {
        const { p } = parser(LA)
        const sunday = "2026-11-08T17:00:00.000Z"
        // abbreviation with an anchor
        expect(p.parseCapture("remind me to call mom on sun")).toMatchObject({
            title: "Call mom",
            due_at: sunday,
        })
        expect(p.parseCapture("fix it on Mon.").due_at).toBe(
            "2026-11-09T17:00:00.000Z"
        )
        // full weekday name as the trailing phrase / right after "remind me"
        expect(p.parseCapture("remind me to call mom sunday")).toMatchObject({
            title: "Call mom",
            due_at: sunday,
        })
        expect(p.parseCapture("remind me sunday to call mom")).toMatchObject({
            title: "Call mom",
            due_at: sunday,
        })
        // casual time words with "this" / trailing / after the prefix
        expect(p.parseCapture("remind me this evening to x").due_at).toBe(
            "2026-11-08T04:00:00.000Z"
        )
        expect(p.parseCapture("remind me tonight").due_at).toBe(
            "2026-11-08T06:00:00.000Z"
        )
        // a dangling "at" before the stripped phrase is removed too
        expect(p.parseCapture("remind me to call mom at midnight")).toEqual({
            isReminder: true,
            title: "Call mom",
            due_at: "2026-11-08T08:00:00.000Z",
            matchedText: "midnight",
        })
    })

    test("m/d dates need an anchor and a valid month", () => {
        const { p } = parser(LA)
        expect(p.parseCapture("remind me to ship by 10/15")).toEqual({
            isReminder: true,
            title: "Ship",
            due_at: "2027-10-15T16:00:00.000Z",
            matchedText: "10/15",
        })
        expect(p.parseCapture("remind me to ship 10/15 build").due_at).toBe(
            null
        )
    })
})
