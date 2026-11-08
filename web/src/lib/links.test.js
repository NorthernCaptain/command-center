/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    allLinks,
    fileUrl,
    hrefFor,
    linksMarkdown,
    sourceLink,
    withLinksSection,
} from "./links.js"
import { renderMarkdown } from "./markdown.js"

const SLACK = "https://x.slack.com/archives/C1/p1?thread_ts=1.2&cid=C1"
const task = (over = {}) => ({
    source: { type: "slack", url: SLACK },
    links: [
        {
            id: "l1",
            type: "asana",
            url: "https://app.asana.com/0/1/2",
            label: "Asana",
        },
        {
            id: "l2",
            type: "folder",
            url: "/Users/me/work/tree/aws-batch--t1-x--4vl1",
            label: "aws-batch",
            role: "work",
        },
    ],
    ...over,
})

describe("sourceLink / allLinks", () => {
    it("puts the capture source first and drops duplicate URLs", () => {
        const all = allLinks(task())
        expect(all.map((l) => l.label)).toEqual([
            "Slack thread",
            "Asana",
            "aws-batch",
        ])
        expect(all[0]).toMatchObject({
            type: "slack",
            url: SLACK,
            source: true,
        })
        const dup = task({
            links: [{ id: "l0", type: "slack", url: SLACK, label: "thread" }],
        })
        expect(allLinks(dup).map((l) => l.label)).toEqual(["Slack thread"])
    })

    it("maps source types; no url, no source link", () => {
        expect(
            sourceLink({ source: { type: "asana", url: "https://a" } })
        ).toMatchObject({
            type: "asana",
            label: "Asana task",
        })
        expect(
            sourceLink({ source: { type: "github", url: "https://g" } })
        ).toMatchObject({
            type: "other",
            label: "GitHub",
        })
        expect(
            sourceLink({ source: { type: "phone", url: "https://p" } })
        ).toMatchObject({
            type: "other",
            label: "Source",
        })
        expect(sourceLink({ source: { type: "manual", url: null } })).toBeNull()
        expect(sourceLink(null)).toBeNull()
        expect(allLinks(null)).toEqual([])
        expect(allLinks({ links: [null, { id: "x" }] })).toEqual([])
    })
})

describe("hrefFor / fileUrl", () => {
    it("web as is, local paths as file://, others not linked", () => {
        expect(hrefFor("https://a/b")).toBe("https://a/b")
        expect(hrefFor("file:///x")).toBe("file:///x")
        expect(hrefFor("/Users/leo/my dir/a#b")).toBe(
            "file:///Users/leo/my%20dir/a%23b"
        )
        expect(hrefFor("relative/path")).toBeNull()
        expect(hrefFor(undefined)).toBeNull()
        expect(fileUrl("/a/b")).toBe("file:///a/b")
    })
})

describe("linksMarkdown / withLinksSection", () => {
    it("web and folder links render as links; folders as file:// with the path", () => {
        const html = renderMarkdown(linksMarkdown(allLinks(task())))
        expect(html).toContain(`href="${SLACK.replace(/&/g, "&amp;")}"`)
        expect(html).toContain(
            'href="file:///Users/me/work/tree/aws-batch--t1-x--4vl1"'
        )
        expect(html).toContain(
            "<code>/Users/me/work/tree/aws-batch--t1-x--4vl1</code>"
        )
        expect(html).toContain("folder · work")
        expect(html).not.toContain(".ts.net")
    })

    it("escapes labels and odd urls; non-path urls are code", () => {
        const md = linksMarkdown([
            { type: "doc", url: "https://a/<x>\n", label: "a [b] *c*" },
            { type: "other", url: "ftp-ish", label: null },
        ])
        expect(md).toContain("[a \\[b\\] \\*c\\*](<https://a/%3Cx%3E>)")
        expect(md).toContain("- ftp-ish: `ftp-ish` · other")
        expect(linksMarkdown(null)).toBe("")
    })

    it("fills the Links section, keeps other sections, appends when missing", () => {
        const doc =
            "# T\n\n## Links\n<!-- rendered from task links -->\n\n## PR feedback\nx\n"
        const out = withLinksSection(doc, allLinks(task()))
        expect(out).toMatch(
            /## Links\n<!-- rendered from task links -->\n\n- \[Slack thread\]/
        )
        expect(out).toMatch(/aws-batch[\s\S]*\n\n## PR feedback\nx\n$/)
        // last section
        const last = withLinksSection("# T\n\n## Links\n", allLinks(task()))
        expect(last.endsWith("· folder · work\n")).toBe(true)
        // no section: appended
        const none = withLinksSection("# T\n\nbody\n", allLinks(task()))
        expect(none).toMatch(/body\n\n## Links\n\n- \[Slack thread\]/)
        // no links: unchanged
        expect(withLinksSection(doc, [])).toBe(doc)
        expect(withLinksSection(null, [])).toBe("")
    })
})

describe("markdown file:// links", () => {
    it("are allowed; script schemes stay blocked", () => {
        expect(renderMarkdown("[f](file:///a/b)")).toContain(
            'href="file:///a/b"'
        )
        expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain(
            "href="
        )
    })
})
