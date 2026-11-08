/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    isGapDay,
    mondayOf,
    monthIndex,
    parseSectionName,
    pickSection,
    startOfDay,
} from "./sprintSection.js"

const ymd = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
    ).padStart(2, "0")}`

function range(name, year = 2026) {
    const r = parseSectionName(name, year)
    return r ? [ymd(r.start), ymd(r.end)] : null
}

describe("parseSectionName", () => {
    test.each([
        ["Nov 2 - Nov 8", "2026-11-02", "2026-11-08"],
        ["Oct 26 - Nov 1", "2026-10-26", "2026-11-01"],
        ["Sep 28 - Oct 4", "2026-09-28", "2026-10-04"],
        ["Aug 31 - Sep 5", "2026-08-31", "2026-09-05"],
        ["August 3 - August 7", "2026-08-03", "2026-08-07"],
        ["July 27 - July 31", "2026-07-27", "2026-07-31"],
        ["June 22 - June 29", "2026-06-22", "2026-06-29"],
        ["April 20 - 26", "2026-04-20", "2026-04-26"],
        ["April 13 - 20", "2026-04-13", "2026-04-20"],
        ["March 30 - April 3rd", "2026-03-30", "2026-04-03"],
        ["Feb 14 - Feb 21", "2026-02-14", "2026-02-21"],
        ["Jan 5 - Jan 11", "2026-01-05", "2026-01-11"],
        ["Dec 28 - Jan 3", "2026-12-28", "2027-01-03"],
        ["Sept 1st – Sept 7th", "2026-09-01", "2026-09-07"],
        ["  Mar. 2 - Mar. 8  ", "2026-03-02", "2026-03-08"],
        ["April 28 - 3", "2026-04-28", "2026-05-03"],
        ["Dec 29 - 4", "2026-12-29", "2027-01-04"],
    ])("%s", (name, start, end) => {
        expect(range(name)).toEqual([start, end])
    })

    test.each([
        "Backlog",
        "Backlog General Vision",
        "Security Updates",
        "tasks from onsite",
        "",
        null,
        "Foo 2 - Bar 8",
        "Nov 2 - Bar 8",
        "No 2 - No 8",
        "Feb 30 - Mar 3",
        "Jan 1 - Mar 30",
        "Nov 8 - Nov 2",
    ])("non-sprint name %p -> null", (name) => {
        expect(parseSectionName(name, 2026)).toBeNull()
    })

    test("returns local midnight dates", () => {
        const r = parseSectionName("Nov 2 - Nov 8", 2026)
        expect(r.start.getHours()).toBe(0)
        expect(r.end.getHours()).toBe(0)
        expect(r.start.getTime()).toBe(new Date(2026, 10, 2).getTime())
    })
})

describe("helpers", () => {
    test("monthIndex", () => {
        expect(monthIndex("nov")).toBe(10)
        expect(monthIndex("September")).toBe(8)
        expect(monthIndex("Ju")).toBe(-1)
        expect(monthIndex(undefined)).toBe(-1)
    })
    test("startOfDay", () => {
        const d = startOfDay(new Date(2026, 4, 5, 13, 45))
        expect(ymd(d)).toBe("2026-05-05")
        expect(d.getHours()).toBe(0)
    })
})

const SECTIONS = [
    "Backlog",
    "Backlog General Vision",
    "Security Updates",
    "tasks from onsite",
    "Nov 2 - Nov 8",
    "Oct 26 - Nov 1",
    "Sep 28 - Oct 4",
    "Aug 31 - Sep 5",
    "August 3 - August 7",
    "July 27 - July 31",
    "June 22 - June 29",
    "April 20 - 26",
    "April 13 - 20",
    "March 30 - April 3rd",
    "Feb 14 - Feb 21",
    "Jan 5 - Jan 11",
].map((name, i) => ({ gid: String(1000 + i), name }))

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h)

describe("pickSection", () => {
    test("section containing today (inclusive start and end)", () => {
        expect(pickSection(SECTIONS, at(2026, 11, 7)).name).toBe(
            "Nov 2 - Nov 8"
        )
        expect(pickSection(SECTIONS, at(2026, 11, 2, 0)).name).toBe(
            "Nov 2 - Nov 8"
        )
        expect(pickSection(SECTIONS, at(2026, 11, 8, 23)).name).toBe(
            "Nov 2 - Nov 8"
        )
        expect(pickSection(SECTIONS, at(2026, 11, 1)).name).toBe(
            "Oct 26 - Nov 1"
        )
        expect(pickSection(SECTIONS, at(2026, 4, 1)).name).toBe(
            "March 30 - April 3rd"
        )
    })

    test("overlapping sections: latest start wins", () => {
        expect(pickSection(SECTIONS, at(2026, 4, 20)).name).toBe(
            "April 20 - 26"
        )
    })

    test("weekend after a Friday-ending sprint falls back to the recent one", () => {
        // August 3 - August 7 is Mon-Fri; Saturday Aug 8 is not contained.
        const picked = pickSection(SECTIONS, at(2026, 8, 8))
        expect(picked).toMatchObject({
            gid: "1008",
            name: "August 3 - August 7",
        })
        expect(ymd(picked.start)).toBe("2026-08-03")
    })

    test("Monday never falls back to last week's section", () => {
        // Nov 2 2026 is a Monday; this week's section is not in the list yet.
        const lastWeek = [{ gid: "1", name: "Nov 2 - Nov 6" }]
        expect(pickSection(lastWeek, at(2026, 11, 7))?.gid).toBe("1") // Sat
        expect(pickSection(lastWeek, at(2026, 11, 8))?.gid).toBe("1") // Sun
        expect(pickSection(lastWeek, at(2026, 11, 9))).toBeNull() // Mon
        expect(pickSection(lastWeek, at(2026, 11, 10))).toBeNull()
    })

    test("gap days: weekend only, at most 3 days after the end", () => {
        // ends Thursday Aug 6: Fri is a weekday (null), Sat/Sun pick it
        const thu = [{ gid: "t", name: "Aug 3 - Aug 6" }]
        expect(pickSection(thu, at(2026, 8, 7))).toBeNull()
        expect(pickSection(thu, at(2026, 8, 8))?.gid).toBe("t")
        expect(pickSection(thu, at(2026, 8, 9))?.gid).toBe("t")
        // ends Tuesday: Saturday is 4 days later -> null
        const tue = [{ gid: "u", name: "Aug 3 - Aug 4" }]
        expect(pickSection(tue, at(2026, 8, 8))).toBeNull()
    })

    test("isGapDay / mondayOf", () => {
        expect(ymd(mondayOf(at(2026, 11, 8)))).toBe("2026-11-02")
        expect(ymd(mondayOf(at(2026, 11, 9)))).toBe("2026-11-09")
        const fri = new Date(2026, 10, 6)
        expect(isGapDay(fri, at(2026, 11, 6))).toBe(false) // same day
        expect(isGapDay(fri, at(2026, 11, 7))).toBe(true)
        expect(isGapDay(fri, at(2026, 11, 9))).toBe(false)
        // a Saturday-ending sprint: Sunday is a gap day too
        expect(isGapDay(new Date(2026, 10, 7), at(2026, 11, 8))).toBe(true)
    })

    test("no matching section -> null", () => {
        expect(pickSection(SECTIONS, at(2026, 12, 15))).toBeNull()
        expect(pickSection([], at(2026, 1, 1))).toBeNull()
        expect(pickSection(undefined, at(2026, 1, 1))).toBeNull()
        expect(
            pickSection([{ gid: "1", name: "Backlog" }, null], at(2026, 1, 1))
        ).toBeNull()
    })

    test("year rollover: December section in the previous year", () => {
        const s = [
            { gid: "a", name: "Dec 21 - Dec 27" },
            { gid: "b", name: "Dec 28 - Jan 3" },
            { gid: "c", name: "Jan 4 - Jan 10" },
        ]
        expect(pickSection(s, at(2027, 1, 2)).gid).toBe("b")
        expect(pickSection(s, at(2026, 12, 30)).gid).toBe("b")
        expect(pickSection(s, at(2027, 1, 5)).gid).toBe("c")
        expect(pickSection(s, at(2026, 12, 22)).gid).toBe("a")
    })

    test("Friday-ending December sprint, checked in early January", () => {
        const s = [{ gid: "x", name: "Dec 28 - Jan 1" }]
        expect(pickSection(s, at(2027, 1, 3)).gid).toBe("x")
    })

    test("defaults today to now", () => {
        const now = new Date()
        const name = `${now.toLocaleString("en-US", { month: "short" })} ${now.getDate()} - ${now.toLocaleString("en-US", { month: "short" })} ${now.getDate()}`
        expect(pickSection([{ gid: "z", name }])?.gid).toBe("z")
    })
})
