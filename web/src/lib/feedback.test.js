/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    feedbackMarkdown,
    feedbackState,
    groupRounds,
    roundSummary,
    withFeedbackSection,
} from "./feedback.js"
import { renderMarkdown } from "./markdown.js"

const PR = "https://github.com/acme/mobile/pull/7"
const item = (over = {}) => ({
    id: "a",
    pr: PR,
    round: 1,
    kind: "review_comment",
    author: "bot[bot]",
    url: `${PR}#discussion_r1`,
    path: "src/a.js",
    line: 12,
    summary: "Stale save\n  overwrites <b>newer</b> stage",
    status: "fixed",
    commit: "59cf1cb8aa",
    reply_url: `${PR}#discussion_r2`,
    note: "Merged before the POST.",
    at: "2026-11-09T01:00:00Z",
    ...over,
})

describe("feedbackMarkdown", () => {
    it("per PR, rounds oldest first, items with status, place, links, note", () => {
        const md = feedbackMarkdown([
            item({ id: "c", round: 2, status: "declined", commit: null }),
            item(),
            item({
                id: "ci",
                kind: "ci_failure",
                path: null,
                line: null,
                author: null,
                summary: "",
                status: "open",
                commit: null,
                reply_url: null,
                note: null,
                at: "2026-11-09T00:00:00Z",
            }),
            item({ id: "n1", round: 2, status: "no_action" }),
            item({ id: "n2", round: 2, status: "no_action" }),
            item({ id: "x", pr: "", round: 1, status: "no_action" }),
        ])
        expect(md.indexOf("**Round 1**")).toBeLessThan(
            md.indexOf("**Round 2**")
        )
        expect(md).toContain(`### [mobile#7](<${PR}>)`)
        expect(md).toContain("**Round 1** · 2 items · 1 open, 1 fixed")
        expect(md).toContain(
            "- **fixed** · inline · @bot[bot] · `src/a.js:12`: Stale save overwrites <b>newer</b> stage"
        )
        expect(md).toContain("`59cf1cb`")
        expect(md).toContain("  ↳ Merged before the POST.")
        // CI item: check link, no reply / commit / note
        expect(md).toContain(
            `- **open** · CI\n  [check](<${PR}#discussion_r1>)`
        )
        // no-action items fold into one line
        expect(md).toContain("- 2 replies that needed no action")
        expect(md).not.toMatch(/\*\*no action\*\*/)
        // items without a PR url get their own group
        expect(md).toContain(
            "### PR\n\n**Round 1** · 1 item · 1 no action\n\n- 1 reply that needed no action"
        )
        const html = renderMarkdown(md)
        expect(html).not.toContain("<b>")
        expect(html).toContain(`href="${PR}"`)
    })

    it("long text is cut, backticks in paths are safe, empty -> ''", () => {
        const md = feedbackMarkdown([
            item({ summary: "x".repeat(400), path: "a`b.js", line: null }),
            null,
        ])
        expect(md).toContain(`${"x".repeat(279)}…`)
        expect(md).toContain("`a'b.js`")
        expect(feedbackMarkdown([])).toBe("")
        expect(feedbackMarkdown(undefined)).toBe("")
    })
})

describe("withFeedbackSection", () => {
    const art =
        "# T-2\n\n## PR feedback\n<!-- per PR and round -->\n\n## Result\nok\n"
    it("fills the section in place and keeps the next one", () => {
        const out = withFeedbackSection(art, [item()])
        expect(out).toMatch(
            /## PR feedback\n<!-- per PR and round -->\n\n### \[mobile#7\]/
        )
        expect(out).toMatch(
            /needed no action|↳ Merged before the POST\.\n\n## Result\nok/
        )
        expect(out.indexOf("## Result")).toBeGreaterThan(out.indexOf("Round 1"))
    })
    it("no items: unchanged; no section: appended", () => {
        expect(withFeedbackSection(art, [])).toBe(art)
        expect(withFeedbackSection("# T", [item()])).toMatch(
            /^# T\n\n## PR feedback\n\n### /
        )
    })
})

describe("groupRounds / roundSummary", () => {
    it("newest round first, items by time; counts", () => {
        const r = groupRounds([
            item({ id: "b", round: 1, at: "2" }),
            item({ id: "a", round: 1, at: "1" }),
            item({ id: "c", round: 3 }),
            { id: "d" },
        ])
        expect(r.map((x) => x.round)).toEqual([3, 1])
        expect(r[1].items.map((x) => x.id)).toEqual(["d", "a", "b"])
        expect(roundSummary([{ status: "open" }])).toBe("1 item · 1 open")
    })
})

describe("feedbackState", () => {
    it("addressed once every actionable item is resolved", () => {
        expect(feedbackState([])).toBeNull()
        expect(feedbackState(null)).toBeNull()
        // only replies that needed nothing: no state
        expect(
            feedbackState([item({ actionable: false, status: "no_action" })])
        ).toBeNull()
        expect(
            feedbackState([
                item({ actionable: true, status: "fixed" }),
                item({ id: "b", actionable: true, status: "declined" }),
                item({ id: "n", actionable: false, status: "no_action" }),
            ])
        ).toEqual({
            state: "addressed",
            open: 0,
            total: 2,
            label: "All feedback addressed (2 items)",
        })
        expect(
            feedbackState([item({ actionable: true, status: "open" })])
        ).toEqual({
            state: "open",
            open: 1,
            total: 1,
            label: "1 of 1 feedback item open",
        })
    })

    it("heads the PR feedback section", () => {
        const addressed = feedbackMarkdown([
            item({ actionable: true, status: "answered" }),
        ])
        expect(addressed.split("\n")[0]).toBe(
            "**✓ All feedback addressed (1 item)**"
        )
        const open = feedbackMarkdown([
            item({ actionable: true, status: "open" }),
            item({ id: "b", actionable: true, status: "fixed" }),
        ])
        expect(open.split("\n")[0]).toBe("**1 of 2 feedback items open**")
    })
})
