/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    findLimitLine,
    findLimitText,
    limitResetAt,
    USAGE_LIMIT_RE,
} from "./usageLimit.js"

test("banners of claude and codex, not prose", () => {
    for (const line of [
        "⎿  You've hit your usage limit · resets 5pm",
        "■ You've hit your usage limit. Upgrade to Pro or try again at 4:31 PM.",
        "5-hour limit reached ∙ resets 3pm",
        "Claude AI usage limit reached|1794700000",
        "Credit balance is too low",
        'API Error: 429 {"type":"rate_limit_error"}',
    ])
        expect(USAGE_LIMIT_RE.test(line)).toBe(true)
    expect(USAGE_LIMIT_RE.test("The gateway's per-IP rate limits")).toBe(false)
})

test("findLimitLine: only the bottom of the pane", () => {
    const old = "You've hit your usage limit · resets 5pm"
    expect(findLimitLine(`a\n${old}\nb`)).toBe(old)
    const long = [old, ...Array.from({ length: 13 }, (_, i) => `line ${i}`)]
    expect(findLimitLine(long.join("\n"))).toBeNull()
    expect(findLimitLine("")).toBeNull()
    expect(findLimitLine(null)).toBeNull()
})

test("limitResetAt: the next such local time, else in an hour", () => {
    const now = new Date(2026, 10, 14, 12, 0, 0).getTime() // local noon
    const at = (h, m = 0, day = 14) =>
        new Date(2026, 10, day, h, m, 0).getTime()
    expect(limitResetAt("resets 5pm", now)).toBe(at(17))
    expect(limitResetAt("try again at 4:31 PM.", now)).toBe(at(16, 31))
    expect(limitResetAt("resets 9am", now)).toBe(at(9, 0, 15))
    expect(limitResetAt("resets 12am", now)).toBe(at(0, 0, 15))
    expect(limitResetAt("resets 12pm", now)).toBe(at(12, 0, 15))
    expect(limitResetAt("resets at 14:30", now)).toBe(at(14, 30))
    expect(limitResetAt("Credit balance is too low", now)).toBe(now + 3600000)
    expect(limitResetAt("resets 99", now, 60000)).toBe(now + 60000)
    expect(limitResetAt(undefined, now)).toBe(now + 3600000)
})

test("limitResetAt: weekday and epoch resets", () => {
    // Saturday 14 Nov 2026, local noon
    const now = new Date(2026, 10, 14, 12, 0, 0).getTime()
    const at = (d, h, m = 0) => new Date(2026, 10, d, h, m, 0).getTime()
    expect(
        limitResetAt("Opus weekly limit reached ∙ resets Mon 9am", now)
    ).toBe(at(16, 9))
    expect(limitResetAt("resets on Saturday at 5pm", now)).toBe(at(14, 17))
    expect(limitResetAt("resets Sat 11am", now)).toBe(at(21, 11))
    const epoch = Math.floor(at(15, 3) / 1000)
    expect(limitResetAt(`Claude AI usage limit reached|${epoch}`, now)).toBe(
        epoch * 1000
    )
    // an epoch in the past: the usual fallback
    expect(limitResetAt("Claude AI usage limit reached|1000000000", now)).toBe(
        now + 3600000
    )
})

test("findLimitText: a reset time wrapped onto the next lines", () => {
    const pane =
        "work\n■ You've hit your usage limit. Try again at\n  4:31 PM.\n› "
    expect(findLimitText(pane)).toBe(
        "■ You've hit your usage limit. Try again at 4:31 PM. ›"
    )
    const now = new Date(2026, 10, 14, 12, 0, 0).getTime()
    expect(new Date(limitResetAt(findLimitText(pane), now)).getHours()).toBe(16)
    expect(findLimitText("all good\n› ")).toBeNull()
    expect(findLimitText("")).toBeNull()
})

test("limitResetAt: a time wrapped inside its token", () => {
    const now = new Date(2026, 10, 14, 12, 0, 0).getTime()
    const at = (pane) => new Date(limitResetAt(findLimitText(pane), now))
    const head = "■ You've hit your usage limit. Try again at"
    for (const pane of [
        `${head} 4:\n31 PM.`,
        `${head} 4:3\n1 PM.`,
        `${head} 4:31 P\nM.`,
        `${head}\n4:31\nPM.`,
        "■ You've hit your usage limit.\nTry again at\n4:31\nPM",
        "■ You've hit your usage limit.\nTry\nagain at\n4:31\nPM",
    ]) {
        expect([at(pane).getHours(), at(pane).getMinutes()]).toEqual([16, 31])
    }
})
