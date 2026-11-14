/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    reviewAgentName,
    reviewFolderName,
    reviewNudgePrompt,
    reviewPrompt,
    reviewTitle,
} from "./reviewPrompt.js"

const pr = {
    repo: "mobile",
    number: 417,
    title: "Fix the `login` flow",
    author: "dev1",
    url: "https://github.com/acme/mobile/pull/417",
    decided_at: "2026-11-11T10:00:00Z",
    decided_sha: "aaa1111bbbb",
}

test("agent names fit herdr's rule", () => {
    expect(reviewAgentName("mobile", 417)).toBe("pr-mobile-417")
    expect(reviewAgentName("TraceBot", 9)).toBe("pr-tracebot-9")
    expect(reviewAgentName("trace_firmware.other", 12)).toBe(
        "pr-trace-firmware-other-12"
    )
    const long = reviewAgentName("a-very-long-repository-name-here", 12345)
    expect(long.length).toBeLessThanOrEqual(32)
    expect(long).toMatch(/^pr-[a-z0-9-]*[a-z0-9]-12345$/)
    expect(reviewAgentName("", 1)).toBe("pr-repo-1")
})

test("title: #number first, no shell quoting characters", () => {
    expect(reviewTitle(pr)).toBe("#417 Fix the login flow")
    expect(reviewTitle({ number: 3, title: "" })).toBe("#3")
    expect(reviewTitle({ number: 3, title: "x".repeat(90) })).toHaveLength(63)
})

test("folder name", () => {
    expect(reviewFolderName("mobile", 417, 12)).toBe("mobile-pr-417-r12")
})

test("first review prompt", () => {
    const p = reviewPrompt({
        pr,
        run: { id: 12, kind: "new" },
        org: "acme",
        folder: "/r/mobile-pr-417-r12",
        me: "leok",
    })
    expect(p).toContain(
        'Review PR acme/mobile#417: "Fix the `login` flow" by dev1.'
    )
    expect(p).toContain("Follow AGENTS.md in this folder exactly")
    expect(p).toContain("do the review yourself")
    expect(p).toContain("Never call the review orchestrator")
    expect(p).toContain("keep every file of this review")
    expect(p).toContain("gh repo clone acme/mobile <folder>")
    expect(p).toContain("git clone git@github.com:acme/mobile.git <folder>")
    expect(p).toContain("git fetch origin pull/417/head")
    expect(p).toContain("/r/mobile-pr-417-r12")
    expect(p).toContain("do not register it with .pr-monitor")
    expect(p).toContain("cc_review_report with review_id=12")
    expect(p).toContain("approved | changes_requested | unchanged | skipped")
    expect(p).toContain("unchanged is for a re-review")
    expect(p).not.toContain("RE-REVIEW")
    expect(p).not.toContain("stacked")
    const stacked = reviewPrompt({
        pr: { ...pr, base: "feature-x", default_branch: "main" },
        run: { id: 12, kind: "new" },
        org: "acme",
        folder: "/r/x",
        me: "leok",
    })
    expect(stacked).toContain("It targets feature-x, not the default branch")
    expect(stacked).toContain("explicit request by PR ID")
    expect(stacked).toContain("Review its changes against feature-x.")
})

test("re-review prompt names the earlier decision", () => {
    const p = reviewPrompt({
        pr,
        run: { id: 13, kind: "re_review" },
        org: "acme",
        folder: "/r/x",
        me: "leok",
    })
    expect(p).toContain(
        "This is a RE-REVIEW: leok requested changes before (2026-11-11T10:00:00Z on aaa1111)."
    )
    expect(p).toContain("pay close attention to the comments")
    const bare = reviewPrompt({
        pr: { ...pr, author: null, decided_at: null, decided_sha: null },
        run: { id: 13, kind: "re_review" },
        org: "acme",
        folder: "/r/x",
        me: "leok",
    })
    expect(bare).toContain("by unknown.")
    expect(bare).toContain("leok requested changes before. Read")
    // a re-review Leo asked for on an approved PR
    expect(
        reviewPrompt({
            pr: { ...pr, decision: "approved" },
            run: { id: 14, kind: "re_review" },
            org: "acme",
            folder: "/r/x",
            me: "leok",
        })
    ).toContain("leok approved it before (")
})

test("nudge", () => {
    expect(reviewNudgePrompt({ id: 7 })).toContain("review_id=7")
})
