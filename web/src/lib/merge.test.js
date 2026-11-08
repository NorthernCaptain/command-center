/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    MARK_MINE,
    MARK_SPLIT,
    MARK_THEIRS,
    hasConflictMarkers,
    normalizeEol,
    threeWayMerge,
} from "./merge.js"

describe("threeWayMerge", () => {
    it("replays my edits on top of theirs", () => {
        const base = "## Summary\nOld summary.\n\n## Plan\nStep one.\n"
        const mine = "## Summary\nNew summary by me.\n\n## Plan\nStep one.\n"
        const theirs =
            "## Summary\nOld summary.\n\n## Plan\nStep one.\nStep two by agent.\n"
        const res = threeWayMerge(base, mine, theirs)
        expect(res.clean).toBe(true)
        expect(res.text).toBe(
            "## Summary\nNew summary by me.\n\n## Plan\nStep one.\nStep two by agent.\n"
        )
    })

    it("keeps both versions between markers when edits clash", () => {
        const base = "intro\nshared line\noutro"
        const mine = "intro\nmy precious rewrite\noutro"
        const theirs = "intro\nagent rewrite\noutro"
        const res = threeWayMerge(base, mine, theirs)
        expect(res.clean).toBe(false)
        expect(res.conflicts).toBe(1)
        expect(res.failed).toBe(1)
        expect(res.text).toBe(
            [
                "intro",
                MARK_MINE,
                "my precious rewrite",
                MARK_SPLIT,
                "agent rewrite",
                MARK_THEIRS,
                "outro",
            ].join("\n")
        )
        expect(hasConflictMarkers(res.text)).toBe(true)
    })

    it("never loses my text even when theirs is totally different", () => {
        const mine = "abcdefghij XXXXXX\nsecond line of mine"
        const res = threeWayMerge(
            "abcdefghij klmnop",
            mine,
            "totally different content here"
        )
        expect(res.clean).toBe(false)
        expect(res.text).toContain("abcdefghij XXXXXX")
        expect(res.text).toContain("second line of mine")
        expect(res.text).toContain("totally different content here")
    })

    it("applies non-clashing edits from both sides around a conflict", () => {
        const base = "a\nb\nc\nd\ne\nf\ng"
        const mine = "A\nb\nc\nMINE\ne\nf\ng"
        const theirs = "a\nb\nc\nTHEIRS\ne\nf\nG"
        const res = threeWayMerge(base, mine, theirs)
        expect(res.conflicts).toBe(1)
        expect(res.text.split("\n")[0]).toBe("A")
        expect(res.text.split("\n").pop()).toBe("G")
        expect(res.text).toContain(`${MARK_MINE}\nMINE\n${MARK_SPLIT}`)
    })

    it("treats identical changes on both sides as clean", () => {
        const res = threeWayMerge("x\ny", "x\nz", "x\nz")
        expect(res).toEqual({
            text: "x\nz",
            clean: true,
            conflicts: 0,
            failed: 0,
        })
    })

    it("handles pure inserts and deletes", () => {
        const res = threeWayMerge("a\nb\nc\nd", "a\nnew\nb\nc\nd", "a\nb\nc")
        expect(res.clean).toBe(true)
        expect(res.text).toBe("a\nnew\nb\nc")
    })

    it("tolerates empty inputs", () => {
        expect(threeWayMerge(null, null, null)).toEqual({
            text: "",
            clean: true,
            conflicts: 0,
            failed: 0,
        })
    })
})

describe("line endings", () => {
    it("normalizes CRLF / CR to LF", () => {
        expect(normalizeEol("a\r\nb\rc\n")).toBe("a\nb\nc\n")
        expect(normalizeEol(null)).toBe("")
    })

    it("merges a CRLF base/theirs with LF mine without a conflict", () => {
        expect(
            threeWayMerge(
                "a\r\nb\r\nc\r\nd\r\ne\r\n",
                "a\nB\nc\nd\ne\n",
                "a\r\nb\r\nc\r\nd\r\nE\r\n"
            )
        ).toEqual({
            text: "a\nB\nc\nd\nE\n",
            clean: true,
            conflicts: 0,
            failed: 0,
        })
    })
})

describe("hasConflictMarkers", () => {
    it("needs both marker lines", () => {
        expect(hasConflictMarkers(`${MARK_MINE}\nx`)).toBe(false)
        expect(hasConflictMarkers("")).toBe(false)
        expect(hasConflictMarkers(null)).toBe(false)
        expect(hasConflictMarkers(`${MARK_MINE}\nx\n${MARK_THEIRS}`)).toBe(true)
    })
})
