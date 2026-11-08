/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    CONTEXT_CHARS,
    anchorFromOffsets,
    applyHighlights,
    buildTextIndex,
    clearHighlights,
    contextScore,
    createAnchor,
    highlightRange,
    locate,
    locateAll,
    offsetOf,
    sectionAt,
} from "./anchoring.js"
import { renderMarkdown } from "./markdown.js"

const TEXT =
    "Summary\nThe upload lambda has a cold start >10s when the bucket is large.\n" +
    "Context\nThe cold start also happens in staging. Memory is 512MB.\n"

function sectionsOf(text) {
    const s1 = text.indexOf("Summary")
    const s2 = text.indexOf("Context")
    return [
        { name: "Summary", start: s1, end: s2 },
        { name: "Context", start: s2, end: text.length },
    ]
}

function anchorFor(text, phrase, occurrence = 0) {
    let idx = -1
    for (let i = 0; i <= occurrence; i++) idx = text.indexOf(phrase, idx + 1)
    return anchorFromOffsets(text, idx, idx + phrase.length, sectionsOf(text))
}

describe("anchorFromOffsets", () => {
    it("captures exact, 32-char prefix/suffix and section", () => {
        const a = anchorFor(TEXT, "cold start >10s")
        expect(a.exact).toBe("cold start >10s")
        expect(a.section).toBe("Summary")
        expect(a.prefix).toBe(
            TEXT.slice(
                TEXT.indexOf("cold start >10s") - CONTEXT_CHARS,
                TEXT.indexOf("cold start >10s")
            )
        )
        expect(a.prefix).toHaveLength(32)
        expect(a.suffix).toHaveLength(32)
        expect(a.suffix.startsWith(" when the bucket")).toBe(true)
    })
    it("trims whitespace and handles reversed offsets", () => {
        const s = TEXT.indexOf(" cold")
        const a = anchorFromOffsets(TEXT, s + 6, s, [])
        expect(a.exact).toBe("cold")
        expect(a.section).toBeNull()
    })
    it("returns null for whitespace-only selections", () => {
        expect(anchorFromOffsets("a   b", 1, 4)).toBeNull()
    })
    it("clips prefix at the document start", () => {
        const a = anchorFromOffsets(TEXT, 0, 7, sectionsOf(TEXT))
        expect(a.prefix).toBe("")
        expect(a.exact).toBe("Summary")
    })
})

describe("sectionAt / contextScore", () => {
    it("finds the section for an offset", () => {
        expect(sectionAt(sectionsOf(TEXT), 0)).toBe("Summary")
        expect(sectionAt(sectionsOf(TEXT), TEXT.length - 2)).toBe("Context")
        expect(sectionAt(sectionsOf(TEXT), 9999)).toBeNull()
        expect(sectionAt(null, 0)).toBeNull()
    })
    it("scores matching context", () => {
        const a = { exact: "x", prefix: "ab", suffix: "cd" }
        expect(contextScore("abxcd", 2, 3, a)).toBe(4)
        expect(contextScore("zzxzz", 2, 3, a)).toBe(0)
        expect(contextScore("abxcd", 2, 3, { exact: "x" })).toBe(0)
    })
})

describe("locate", () => {
    const sections = sectionsOf(TEXT)

    it("finds the exact quote with prefix and suffix", () => {
        const a = anchorFor(TEXT, "cold start")
        const r = locate(TEXT, a, { sections })
        expect(r.strategy).toBe("quote")
        expect(TEXT.slice(r.start, r.end)).toBe("cold start")
        expect(r.start).toBe(TEXT.indexOf("cold start"))
    })

    it("picks the right duplicate by section + context", () => {
        const a = anchorFor(TEXT, "cold start", 1) // the one in Context
        const r = locate(TEXT, a, { sections })
        expect(r.start).toBe(
            TEXT.indexOf("cold start", TEXT.indexOf("Context"))
        )
    })

    it("survives edits before the anchor", () => {
        const a = anchorFor(TEXT, "cold start >10s")
        const edited = "Intro paragraph added by an agent.\n" + TEXT
        const r = locate(edited, a, { sections: sectionsOf(edited) })
        expect(edited.slice(r.start, r.end)).toBe("cold start >10s")
        expect(r.strategy).toBe("quote")
    })

    it("survives edits after the anchor", () => {
        const a = anchorFor(TEXT, "cold start >10s")
        const edited = TEXT + "\nDecisions\nRaise memory to 1024MB.\n"
        const r = locate(edited, a, { sections: sectionsOf(edited) })
        expect(edited.slice(r.start, r.end)).toBe("cold start >10s")
    })

    it("falls back to exact alone when the context changed", () => {
        const a = anchorFor(TEXT, "cold start >10s")
        const edited = TEXT.replace(
            "The upload lambda has a",
            "Our uploader suffers a"
        ).replace("when the bucket is large", "for big buckets")
        const r = locate(edited, a, { sections: sectionsOf(edited) })
        expect(r.strategy).toBe("exact")
        expect(edited.slice(r.start, r.end)).toBe("cold start >10s")
    })

    it("searches the whole doc for exact when the section is gone", () => {
        const a = {
            section: "Gone",
            exact: "Memory is 512MB",
            prefix: "zzz",
            suffix: "yyy",
        }
        const r = locate(TEXT, a, { sections })
        expect(r.strategy).toBe("exact")
        expect(TEXT.slice(r.start, r.end)).toBe("Memory is 512MB")
    })

    it("finds the exact text outside its old section", () => {
        const a = {
            section: "Context",
            exact: "upload lambda",
            prefix: "",
            suffix: "",
        }
        const r = locate(TEXT, a, { sections })
        expect(TEXT.slice(r.start, r.end)).toBe("upload lambda")
    })

    it("fuzzy-matches lightly edited text", () => {
        const a = anchorFor(TEXT, "The cold start also happens in staging")
        const edited = TEXT.replace(
            "also happens in staging",
            "also happen in staging"
        )
        const r = locate(edited, a, { sections: sectionsOf(edited) })
        expect(r.strategy).toBe("fuzzy")
        expect(edited.slice(r.start, r.start + 14)).toBe("The cold start")
    })

    it("fuzzy-matches long quotes (> 32 chars) using head and tail", () => {
        const phrase =
            "The upload lambda has a cold start >10s when the bucket is large."
        const a = anchorFor(TEXT, phrase)
        const edited = TEXT.replace("has a cold", "has one cold")
        const r = locate(edited, a, { sections: sectionsOf(edited) })
        expect(r.strategy).toBe("fuzzy")
        expect(edited.slice(r.start, r.end)).toContain("cold start >10s")
        expect(edited.slice(r.end - 6, r.end)).toBe("large.")
    })

    it("orphans anchors whose text is gone", () => {
        const a = anchorFor(TEXT, "cold start >10s")
        const edited =
            "Summary\nCompletely rewritten.\nContext\nNothing similar here at all.\n"
        expect(locate(edited, a, { sections: sectionsOf(edited) })).toBeNull()
    })

    it("does not fuzzy-match very short quotes", () => {
        expect(locate("abcdef", { exact: "xyz" })).toBeNull()
    })

    it("rejects invalid input", () => {
        expect(locate(TEXT, null)).toBeNull()
        expect(locate(TEXT, { exact: "" })).toBeNull()
        expect(locate(null, { exact: "a" })).toBeNull()
        expect(locate("", { exact: "abcdef" })).toBeNull()
    })

    it("works without sections", () => {
        const a = anchorFor(TEXT, "cold start >10s")
        const r = locate(TEXT, { ...a, section: null })
        expect(TEXT.slice(r.start, r.end)).toBe("cold start >10s")
        expect(locate(TEXT, { exact: "bucket" }).strategy).toBe("exact")
    })

    it("locateAll splits located and orphaned", () => {
        const items = [
            { id: "c1", anchor: anchorFor(TEXT, "cold start >10s") },
            {
                id: "c2",
                anchor: { exact: "this text does not exist anywhere" },
            },
        ]
        const { located, orphaned } = locateAll(TEXT, items, { sections })
        expect(located.get("c1").strategy).toBe("quote")
        expect(orphaned).toEqual(["c2"])
        expect(locateAll(TEXT, null).orphaned).toEqual([])
    })
})

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const MD = `# T-1 — Title

## Summary
The upload lambda has a **cold start** >10s when the bucket is large.

## Plan
- raise memory
- add provisioned concurrency
`

function mount(md = MD) {
    const root = document.createElement("article")
    root.innerHTML = renderMarkdown(md)
    document.body.appendChild(root)
    return root
}

afterEach(() => {
    document.body.innerHTML = ""
})

describe("buildTextIndex", () => {
    it("concatenates text nodes and records sections", () => {
        const root = mount()
        const idx = buildTextIndex(root)
        expect(idx.text).toContain("has a cold start >10s when")
        const names = idx.sections.map((s) => s.name)
        expect(names).toEqual(["Summary", "Plan"])
        const sum = idx.sections[0]
        expect(idx.text.slice(sum.start, sum.end)).toContain("cold start")
        expect(idx.text.slice(sum.start, sum.end)).not.toContain("raise memory")
    })
})

describe("createAnchor + offsetOf", () => {
    it("anchors a DOM range across inline formatting", () => {
        const root = mount()
        const p = root.querySelector("p")
        const range = document.createRange()
        // "has a " is in the first text node, "cold start" in <strong>
        const first = p.firstChild
        range.setStart(first, first.nodeValue.indexOf("has a"))
        const strong = p.querySelector("strong").firstChild
        range.setEnd(strong, strong.nodeValue.length)
        const a = createAnchor(root, range)
        expect(a.exact).toBe("has a cold start")
        expect(a.section).toBe("Summary")
        expect(a.suffix.startsWith(" >10s when")).toBe(true)
    })

    it("handles element boundary points", () => {
        const root = mount()
        const ul = root.querySelector("ul")
        const range = document.createRange()
        range.setStart(ul, 0)
        range.setEnd(ul, ul.childNodes.length)
        const a = createAnchor(root, range)
        expect(a.exact).toContain("raise memory")
        expect(a.exact).toContain("provisioned concurrency")
        expect(a.section).toBe("Plan")
    })

    it("offsetOf returns null for unknown text nodes and end for trailing boundaries", () => {
        const root = mount()
        const idx = buildTextIndex(root)
        expect(offsetOf(idx, document.createTextNode("x"), 0)).toBeNull()
        expect(offsetOf(idx, root, root.childNodes.length)).toBe(
            idx.text.length
        )
        const p = root.querySelector("p")
        const after = offsetOf(idx, p, p.childNodes.length)
        expect(idx.text.slice(after)).not.toContain("has a")
    })

    it("returns null for collapsed / outside ranges", () => {
        const root = mount()
        const range = document.createRange()
        range.setStart(root.querySelector("p").firstChild, 2)
        expect(createAnchor(root, range)).toBeNull()
        const other = document.createElement("div")
        other.textContent = "elsewhere"
        document.body.appendChild(other)
        const r2 = document.createRange()
        r2.selectNodeContents(other)
        expect(createAnchor(root, r2)).toBeNull()
        expect(createAnchor(null, r2)).toBeNull()
    })
})

describe("highlightRange / applyHighlights / clearHighlights", () => {
    it("wraps a range spanning nodes in marks", () => {
        const root = mount()
        const idx = buildTextIndex(root)
        const start = idx.text.indexOf("has a cold")
        const marks = highlightRange(
            root,
            start,
            start + "has a cold start".length,
            { "data-comment-id": "c1" }
        )
        expect(marks.length).toBe(2)
        const text = [...root.querySelectorAll('mark[data-comment-id="c1"]')]
            .map((m) => m.textContent)
            .join("")
        expect(text).toBe("has a cold start")
        // text content is unchanged
        expect(buildTextIndex(root).text).toBe(idx.text)
    })

    it("does not wrap whitespace between list items", () => {
        const root = mount()
        const idx = buildTextIndex(root)
        const s = idx.text.indexOf("raise memory")
        const e = idx.text.indexOf("concurrency") + "concurrency".length
        highlightRange(root, s, e, { "data-comment-id": "c2" })
        const ul = root.querySelector("ul")
        for (const child of ul.childNodes) {
            if (child.nodeType === 1) expect(child.tagName).toBe("LI")
        }
    })

    it("re-anchors comments, reports orphans and clears", () => {
        const root = mount()
        const idx = buildTextIndex(root)
        const start = idx.text.indexOf("cold start")
        const anchor = anchorFromOffsets(
            idx.text,
            start,
            start + 10,
            idx.sections
        )
        const res = applyHighlights(root, [
            { id: "c1", anchor },
            {
                id: "c9",
                anchor: { exact: "nothing like this exists in the doc" },
            },
        ])
        expect(res.orphaned).toEqual(["c9"])
        expect(
            root.querySelector('mark[data-comment-id="c1"]').textContent
        ).toBe("cold start")
        // applying again does not nest marks
        applyHighlights(root, [{ id: "c1", anchor }])
        expect(root.querySelectorAll("mark").length).toBe(1)
        clearHighlights(root)
        expect(root.querySelectorAll("mark").length).toBe(0)
        expect(buildTextIndex(root).text).toBe(idx.text)
        expect(root.querySelector("strong").childNodes.length).toBe(1)
    })

    it("survives an artifact edit before the anchor", () => {
        const root = mount()
        const idx = buildTextIndex(root)
        const start = idx.text.indexOf("cold start")
        const anchor = anchorFromOffsets(
            idx.text,
            start,
            start + 10,
            idx.sections
        )
        const root2 = mount(
            MD.replace(
                "## Summary\n",
                "## Summary\nA new first line from the agent.\n\n"
            )
        )
        const res = applyHighlights(root2, [{ id: "c1", anchor }])
        expect(res.orphaned).toEqual([])
        expect(root2.querySelector("mark").textContent).toBe("cold start")
    })
})
