/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    listSectionNames,
    normalizeSectionName,
    parseSections,
    sectionBody,
} from "./sections.js"

const DOC = `# T-1 — x

> header

## Summary
Hello

## Change record (SOC2)        <!-- only for infra -->
- a

\`\`\`md
## Not a heading
\`\`\`

## Result
`

describe("sections", () => {
    test("parses headings, skipping fenced code", () => {
        expect(listSectionNames(DOC)).toEqual([
            "Summary",
            "Change record (SOC2)",
            "Result",
        ])
        expect(sectionBody(DOC, "summary")).toBe("Hello")
        expect(sectionBody(DOC, "## Change record (SOC2)")).toMatch(
            /^- a\n\n```md\n## Not a heading\n```$/
        )
        expect(sectionBody(DOC, "Result")).toBe("")
        expect(sectionBody(DOC, "Missing")).toBeNull()
        expect(parseSections(null)).toEqual([])
        expect(sectionBody(null, "x")).toBeNull()
        expect(normalizeSectionName(undefined)).toBe("")
    })
})

describe("sections agree with the store parser", () => {
    test("closing hashes and comments in headings", () => {
        const doc =
            "## Plan ##\nstep 1\n\n## Notes <!-- free -->\nn\n\n## Done ###   \n"
        expect(listSectionNames(doc)).toEqual(["Plan", "Notes", "Done"])
        expect(sectionBody(doc, "Plan")).toBe("step 1")
        expect(sectionBody(doc, "notes")).toBe("n")
        expect(sectionBody(doc, "Done")).toBe("")
    })
    test("a longer fence is only closed by a matching one", () => {
        const doc = "## A\n````\n```\n## B\n````\n## C\nc\n"
        expect(listSectionNames(doc)).toEqual(["A", "C"])
    })
})
