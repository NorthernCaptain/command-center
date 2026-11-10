/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    buildArtifactTemplate,
    ensureChangeRecord,
    findSection,
    getSectionBody,
    parseSections,
    setSection,
    setTitleLine,
    titleLine,
} from "./artifact.js"

const DOC = [
    "# T-1 — Title",
    "",
    "## Summary",
    "Short.",
    "",
    "```md",
    "## Not a heading",
    "```",
    "",
    "## Progress ##",
    "- one",
    "",
    "## Result",
    "",
].join("\n")

function task(over = {}) {
    return {
        id: 123,
        title: "Fix  upload\nretry",
        area: "backend",
        source: { type: "slack", url: "https://slack/x", text: null },
        ...over,
    }
}

describe("parseSections", () => {
    test("heading names drop closing hashes and HTML comments", () => {
        const doc =
            "## Plan ##\nx\n## Notes <!-- free -->\ny\n## Odd ## <!-- c -->\n"
        expect(parseSections(doc).map((x) => x.name)).toEqual([
            "Plan",
            "Notes",
            "Odd",
        ])
    })

    test("finds ## headings, ignores fenced code and strips closing #", () => {
        const s = parseSections(DOC)
        expect(s.map((x) => x.name)).toEqual(["Summary", "Progress", "Result"])
        expect(s[0].line).toBe(3)
        expect(DOC.slice(s[0].start, s[0].end)).toMatch(/^## Summary\n/)
        expect(s[2].end).toBe(DOC.length)
    })

    test("handles ~~~ fences and nested longer fences", () => {
        const doc = "## A\n~~~~\n```\n## B\n```\n~~~~\n## C\n"
        expect(parseSections(doc).map((s) => s.name)).toEqual(["A", "C"])
    })

    test("findSection is case-insensitive; getSectionBody", () => {
        expect(findSection(DOC, " progress ").name).toBe("Progress")
        expect(getSectionBody(DOC, "progress")).toBe("- one")
        expect(getSectionBody(DOC, "missing")).toBeNull()
        expect(getSectionBody("## Last", "Last")).toBe("")
    })
})

describe("setSection", () => {
    test("replace keeps neighbours and spacing", () => {
        const out = setSection(DOC, "summary", "New body\n\n", "replace")
        expect(getSectionBody(out, "Summary")).toBe("New body")
        expect(out).toContain("## Summary\nNew body\n\n## Progress ##")
        expect(getSectionBody(out, "Progress")).toBe("- one")
    })

    test("replace strips a repeated heading and can empty a section", () => {
        const out = setSection(DOC, "Summary", "\n## summary\nX", "replace")
        expect(getSectionBody(out, "Summary")).toBe("X")
        const empty = setSection(DOC, "Summary", "", "replace")
        expect(empty).toContain("## Summary\n\n## Progress")
    })

    test("append joins list items tightly and paragraphs with a blank line", () => {
        let out = setSection(DOC, "Progress", "- two", "append")
        expect(getSectionBody(out, "Progress")).toBe("- one\n- two")
        out = setSection(out, "Progress", "Paragraph", "append")
        expect(getSectionBody(out, "Progress")).toBe(
            "- one\n- two\n\nParagraph"
        )
        out = setSection(out, "Progress", "", "append")
        expect(getSectionBody(out, "Progress")).toBe(
            "- one\n- two\n\nParagraph"
        )
    })

    test("append into an empty last section", () => {
        const out = setSection(DOC, "Result", "Done.", "append")
        expect(out.endsWith("## Result\nDone.\n")).toBe(true)
    })

    test("missing section is created before ## Result", () => {
        const out = setSection(DOC, "Decisions", "- d1", "append")
        const names = parseSections(out).map((s) => s.name)
        expect(names).toEqual(["Summary", "Progress", "Decisions", "Result"])
        expect(out).toContain("## Decisions\n- d1\n\n## Result")
    })

    test("missing section without Result is appended at the end", () => {
        expect(setSection("# T\n\n## A\nx\n", "B", "y")).toBe(
            "# T\n\n## A\nx\n\n## B\ny\n"
        )
        expect(setSection("", "B", "")).toBe("## B\n")
        expect(setSection("## A", "Result", "r")).toBe("## A\n\n## Result\nr\n")
    })

    test("heading without trailing newline", () => {
        expect(setSection("## A", "A", "body")).toBe("## A\nbody\n")
    })

    test("CRLF input is normalized", () => {
        expect(
            getSectionBody(setSection(DOC, "Summary", "a\r\nb"), "Summary")
        ).toBe("a\nb")
    })
})

describe("title line", () => {
    test("titleLine collapses whitespace", () => {
        expect(titleLine(7, " a \n b ")).toBe("# T-7 — a b")
    })

    test("setTitleLine rewrites only a matching first line", () => {
        expect(setTitleLine("# T-7 — old\nrest", 7, "new")).toBe(
            "# T-7 — new\nrest"
        )
        expect(setTitleLine("# T-7 — old", 7, "new")).toBe("# T-7 — new")
        expect(setTitleLine("# Custom\nrest", 7, "new")).toBe("# Custom\nrest")
    })
})

describe("buildArtifactTemplate", () => {
    test("standard sections without SOC2 for backend", () => {
        const doc = buildArtifactTemplate(task())
        expect(doc.startsWith("# T-123 — Fix upload retry\n\n")).toBe(true)
        expect(doc).toContain(
            "> **Source:** https://slack/x · **Area:** backend"
        )
        expect(parseSections(doc).map((s) => s.name)).toEqual([
            "Summary",
            "Context",
            "Acceptance",
            "Plan",
            "Decisions",
            "Progress",
            "Links",
            "PR feedback",
            "Result",
        ])
        expect(doc.endsWith("\n")).toBe(true)
    })

    test.each(["infra", "access", "security", "soc2"])(
        "SOC2 change record for %s",
        (area) => {
            const names = parseSections(
                buildArtifactTemplate(task({ area }))
            ).map((s) => s.name)
            expect(names.indexOf("Change record (SOC2)")).toBe(
                names.indexOf("Links") + 1
            )
        }
    )

    test("source text is quoted in Context unless it equals the title", () => {
        const doc = buildArtifactTemplate(
            task({
                title: "T",
                source: { type: "manual", url: null, text: "line1\n\nline2" },
            })
        )
        expect(doc).toContain("> **Source:** manual")
        expect(getSectionBody(doc, "Context")).toBe("> line1\n>\n> line2")
        const same = buildArtifactTemplate(
            task({ title: "same", source: { type: "phone", text: "same" } })
        )
        expect(getSectionBody(same, "Context")).toBe("")
        expect(same).toContain("> **Source:** phone")
        expect(buildArtifactTemplate(task({ source: undefined }))).toContain(
            "> **Source:** manual"
        )
    })
})

describe("ensureChangeRecord", () => {
    const names = (doc) => parseSections(doc).map((s) => s.name)

    test("other areas and a missing task leave the artifact alone", () => {
        const doc = buildArtifactTemplate(task())
        expect(ensureChangeRecord(doc, task())).toBe(doc)
        expect(ensureChangeRecord(doc, null)).toBe(doc)
    })

    test("adds the section before PR feedback and updates the area", () => {
        const doc = buildArtifactTemplate(task({ area: "other" }))
        const out = ensureChangeRecord(doc, task({ area: "access" }))
        expect(out).toBe(buildArtifactTemplate(task({ area: "access" })))
        expect(out).toContain("· **Area:** access")
        expect(getSectionBody(out, "Change record (SOC2)")).toMatch(
            /^- What:\n- Why:\n- Risk:\n- Rollback:\n- Tested:/
        )
        // idempotent
        expect(ensureChangeRecord(out, task({ area: "access" }))).toBe(out)
    })

    test("keeps a filled section and only fixes the area line", () => {
        const doc = buildArtifactTemplate(task({ area: "infra" })).replace(
            "- What:",
            "- What: moved the bucket"
        )
        const out = ensureChangeRecord(doc, task({ area: "security" }))
        expect(out).toBe(doc.replace("**Area:** infra", "**Area:** security"))
    })

    test("without PR feedback it goes before Result, else at the end", () => {
        const out = ensureChangeRecord(DOC, task({ area: "soc2" }))
        expect(names(out)).toEqual([
            "Summary",
            "Progress",
            "Change record (SOC2)",
            "Result",
        ])
        const bare = ensureChangeRecord("# Mine\n", task({ area: "soc2" }))
        expect(names(bare)).toEqual(["Change record (SOC2)"])
    })
})
