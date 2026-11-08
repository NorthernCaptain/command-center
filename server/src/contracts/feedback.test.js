/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { currentRound, feedbackDedupeKey, parsePrUrl } from "./feedback.js"

const PR = "https://github.com/acme/aws-lambda/pull/812"

describe("feedback helpers", () => {
    test("parsePrUrl", () => {
        expect(parsePrUrl(PR)).toEqual({ repo: "aws-lambda", number: 812 })
        expect(parsePrUrl(PR + "#discussion_r1")).toEqual({
            repo: "aws-lambda",
            number: 812,
        })
        expect(parsePrUrl("https://github.com/x/y/issues/3")).toBeNull()
        expect(parsePrUrl(null)).toBeNull()
    })

    test("feedbackDedupeKey", () => {
        expect(feedbackDedupeKey(PR, 2)).toBe("round-aws-lambda-812-2")
        expect(() => feedbackDedupeKey("nope", 1)).toThrow(/not a GitHub PR/)
        expect(() => feedbackDedupeKey(PR, 0)).toThrow(/invalid feedback round/)
    })

    test("currentRound is the oldest round with an open actionable item", () => {
        const items = [
            { pr: PR, round: 1, status: "fixed", actionable: true },
            { pr: PR, round: 2, status: "open", actionable: true },
            { pr: PR, round: 3, status: "open", actionable: true },
            { pr: PR, round: 1, status: "open", actionable: false },
            {
                pr: "https://github.com/acme/x/pull/1",
                round: 1,
                status: "open",
                actionable: true,
            },
        ]
        expect(currentRound(items, PR)).toBe(2)
        expect(currentRound([], PR)).toBeNull()
        expect(currentRound(undefined, PR)).toBeNull()
    })
})
