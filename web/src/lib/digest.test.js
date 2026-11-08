/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    dismissDigest,
    dismissedDate,
    isToday,
    localDate,
    normalizeDigest,
} from "./digest.js"

describe("localDate", () => {
    it("formats local calendar dates", () => {
        expect(localDate(new Date(2026, 0, 5, 23, 10))).toBe("2026-01-05")
        expect(localDate("garbage")).toBeNull()
        expect(localDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
})

describe("normalizeDigest", () => {
    it("returns null without a digest", () => {
        expect(normalizeDigest(null)).toBeNull()
        expect(normalizeDigest({ digest: null })).toBeNull()
        expect(normalizeDigest({ digest: { summary: "no date" } })).toBeNull()
        expect(normalizeDigest("x")).toBeNull()
    })

    it("reads an array of sections", () => {
        const d = normalizeDigest({
            digest: {
                date: "2026-11-07",
                generated_at: "2026-11-07T08:30:00Z",
                summary: "Morning: 2 in Now",
                sections: [
                    {
                        id: "now",
                        title: "Now",
                        items: [
                            { task_id: 3, title: "A", now_reason: "due" },
                            { id: 4, title: "B" },
                            null,
                            { note: "no title or id" },
                        ],
                    },
                    { key: "empty", items: [] },
                    { tasks: [{ text: "free text", url: "https://x" }] },
                ],
            },
        })
        expect(d.date).toBe("2026-11-07")
        expect(d.summary).toBe("Morning: 2 in Now")
        expect(d.sections).toEqual([
            {
                id: "now",
                title: "Now",
                items: [
                    { id: 3, title: "A", note: "due", url: null },
                    { id: 4, title: "B", note: null, url: null },
                ],
            },
            {
                id: "s2",
                title: "s2",
                items: [
                    {
                        id: null,
                        title: "free text",
                        note: null,
                        url: "https://x",
                    },
                ],
            },
        ])
    })

    it("reads object sections or top-level arrays and derives the date", () => {
        const d = normalizeDigest({
            generated_at: new Date(2026, 10, 7, 8, 30).toISOString(),
            text: "hi",
            now: [{ id: 1, title: "x" }],
            prs: [{ id: 2 }],
            stale: "not an array",
        })
        expect(d.date).toBe("2026-11-07")
        expect(d.summary).toBe("hi")
        expect(d.sections.map((s) => s.title)).toEqual([
            "Now",
            "PRs waiting on you",
        ])
        expect(d.sections[1].items[0].title).toBe("T-2")
        const o = normalizeDigest({
            digest: {
                date: "2026-11-07",
                sections: { blocked: [{ id: 9, title: "y", reason: "r" }] },
            },
        })
        expect(o.summary).toBe("")
        expect(o.sections[0]).toEqual({
            id: "blocked",
            title: "Blocked agents",
            items: [{ id: 9, title: "y", note: "r", url: null }],
        })
    })
})

describe("isToday", () => {
    it("compares the digest date with the local date", () => {
        const now = new Date(2026, 10, 7, 9)
        expect(isToday({ date: "2026-11-07" }, now)).toBe(true)
        expect(isToday({ date: "2026-11-06" }, now)).toBe(false)
        expect(isToday(null, now)).toBe(false)
    })
})

describe("dismissal storage", () => {
    it("stores the dismissed date", () => {
        const map = new Map()
        const store = {
            getItem: (k) => (map.has(k) ? map.get(k) : null),
            setItem: (k, v) => map.set(k, v),
        }
        expect(dismissedDate(store)).toBeNull()
        dismissDigest("2026-11-07", store)
        expect(dismissedDate(store)).toBe("2026-11-07")
    })

    it("uses localStorage by default", () => {
        localStorage.clear()
        dismissDigest("2026-11-08")
        expect(dismissedDate()).toBe("2026-11-08")
        localStorage.clear()
    })

    it("tolerates missing or throwing storage", () => {
        const bad = {
            getItem: () => {
                throw new Error("denied")
            },
            setItem: () => {
                throw new Error("denied")
            },
        }
        expect(dismissedDate(bad)).toBeNull()
        expect(() => dismissDigest("x", bad)).not.toThrow()
        expect(dismissedDate(null)).toBeNull()
        expect(() => dismissDigest("x", null)).not.toThrow()
    })

    it("tolerates a localStorage getter that throws", () => {
        const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            get() {
                throw new Error("SecurityError")
            },
        })
        try {
            expect(dismissedDate()).toBeNull()
            expect(() => dismissDigest("x")).not.toThrow()
        } finally {
            Object.defineProperty(globalThis, "localStorage", desc)
        }
    })
})
