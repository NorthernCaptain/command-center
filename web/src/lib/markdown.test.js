/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { isLocalImageSrc, renderMarkdown, sectionNames } from "./markdown.js"

const ARTIFACT = `# T-12 — Fix lambda timeout

> **Source:** https://slack.example/x · **Area:** backend

## Summary
The upload lambda has a cold start >10s when the bucket is large.

## Acceptance
- [ ] p95 under 2s
- [x] repro documented

## Decisions
<!-- cc_log_decision appends here -->

\`\`\`
<!-- keep me -->
\`\`\`

## Links
See [the PR](https://github.com/x/y/pull/1) and <b>raw</b>.
`

function dom(html) {
    const div = document.createElement("div")
    div.innerHTML = html
    return div
}

describe("renderMarkdown", () => {
    const root = dom(renderMarkdown(ARTIFACT))

    it("tags h2 and following blocks with data-section", () => {
        const h2 = root.querySelector("h2")
        expect(h2.getAttribute("data-section")).toBe("Summary")
        const p = [...root.querySelectorAll("p")].find((x) =>
            x.textContent.startsWith("The upload")
        )
        expect(p.getAttribute("data-section")).toBe("Summary")
        expect(root.querySelector("ul").getAttribute("data-section")).toBe(
            "Acceptance"
        )
    })

    it("does not tag the title or the header quote", () => {
        expect(root.querySelector("h1").hasAttribute("data-section")).toBe(
            false
        )
        expect(
            root.querySelector("blockquote").hasAttribute("data-section")
        ).toBe(false)
    })

    it("opens links in a new tab safely", () => {
        const a = root.querySelector('a[href="https://github.com/x/y/pull/1"]')
        expect(a.getAttribute("target")).toBe("_blank")
        expect(a.getAttribute("rel")).toBe("noopener noreferrer")
        // linkify also gets the attributes
        const auto = root.querySelector('a[href="https://slack.example/x"]')
        expect(auto.getAttribute("target")).toBe("_blank")
    })

    it("escapes raw HTML", () => {
        expect(root.querySelector("b")).toBeNull()
        expect(root.textContent).toContain("<b>raw</b>")
    })

    it("drops HTML comments outside fences but keeps them inside", () => {
        expect(root.textContent).not.toContain("cc_log_decision")
        expect(root.querySelector("pre").textContent).toContain(
            "<!-- keep me -->"
        )
    })

    it("renders task list items", () => {
        const items = root.querySelectorAll("li.task-item")
        expect(items).toHaveLength(2)
        expect(items[0].textContent).toBe("☐ p95 under 2s")
        expect(items[1].classList.contains("done")).toBe(true)
        expect(items[1].textContent).toBe("☑ repro documented")
    })

    it("tags code fences and hr", () => {
        const r = dom(
            renderMarkdown("## A\n\n    indented\n\n---\n\n```js\nx\n```\n")
        )
        expect(r.querySelector("pre").getAttribute("data-section")).toBe("A")
        expect(r.querySelector("hr").getAttribute("data-section")).toBe("A")
        expect(
            r.querySelector("code.language-js").closest("[data-section]")
        ).not.toBeNull()
    })

    it("resets the section on a new h1", () => {
        const r = dom(renderMarkdown("## A\n\ntext\n\n# Title\n\nafter"))
        const after = [...r.querySelectorAll("p")].find(
            (p) => p.textContent === "after"
        )
        expect(after.hasAttribute("data-section")).toBe(false)
    })

    it("handles empty input", () => {
        expect(renderMarkdown("")).toBe("")
        expect(renderMarkdown(null)).toBe("")
    })
})

describe("HTML comments", () => {
    it("removes inline and multi-line comments", () => {
        const r = dom(renderMarkdown("a <!-- x\ny --> b"))
        expect(r.textContent.trim()).toBe("a  b")
        expect(r.innerHTML).not.toContain("<!--")
    })

    it("keeps `<!--` inside inline code and the sections after it", () => {
        const src =
            "## One\nUse `<!--` to open a comment.\n\n## Two\nStill here.\n\n## Decisions\n<!-- template hint -->\n"
        const r = dom(renderMarkdown(src))
        expect(r.querySelector("code").textContent).toBe("<!--")
        expect(r.textContent).toContain("Still here.")
        expect(r.textContent).not.toContain("template hint")
        expect(sectionNames(src)).toEqual(["One", "Two", "Decisions"])
    })

    it("keeps `<!--` inside a fence and the content after it", () => {
        const src =
            "## A\n```html\n<!-- open\n```\n\nAfter the fence.\n\n<!-- hint -->\n"
        const r = dom(renderMarkdown(src))
        expect(r.querySelector("pre").textContent).toContain("<!-- open")
        expect(r.textContent).toContain("After the fence.")
        expect(r.textContent).not.toContain("hint")
    })

    it("keeps comments inside tilde fences", () => {
        const r = dom(renderMarkdown("~~~\n<!-- in -->\n~~~\n<!-- out -->\n"))
        expect(r.querySelector("pre").textContent).toContain("<!-- in -->")
        expect(r.textContent).not.toContain("out")
    })

    it("shows text after a comment on the same line", () => {
        const r = dom(renderMarkdown("## S\n\n<!-- hint --> visible *text*\n"))
        expect(r.textContent).not.toContain("hint")
        const p = r.querySelector("p")
        expect(p.textContent.trim()).toBe("visible text")
        expect(p.querySelector("em")).not.toBeNull()
        expect(p.getAttribute("data-section")).toBe("S")
    })

    it("shows an unclosed comment as text without hiding the rest", () => {
        const r = dom(renderMarkdown("<!-- open\n\n## Next\nbody"))
        expect(r.textContent).toContain("<!-- open")
        expect(r.textContent).toContain("body")
    })
})

describe("raw HTML", () => {
    it("escapes HTML blocks and inline tags", () => {
        const r = dom(
            renderMarkdown(
                '<div onclick="x()">hi</div>\n\n<script>alert(1)</script>\n\ntext <img src=x onerror=alert(1)> end'
            )
        )
        expect(r.querySelector("div")).toBeNull()
        expect(r.querySelector("script")).toBeNull()
        expect(r.querySelector("img")).toBeNull()
        expect(r.textContent).toContain('<div onclick="x()">hi</div>')
        expect(r.textContent).toContain("<script>alert(1)</script>")
        expect(r.textContent).toContain("<img src=x onerror=alert(1)>")
    })
})

describe("images", () => {
    it("renders remote images as links, never as <img>", () => {
        const r = dom(
            renderMarkdown(
                "![secret](https://evil.example/x.png?d=1) ![](//evil.example/y.png)"
            )
        )
        expect(r.querySelector("img")).toBeNull()
        const links = r.querySelectorAll("a.img-link")
        expect(links).toHaveLength(2)
        expect(links[0].getAttribute("href")).toBe(
            "https://evil.example/x.png?d=1"
        )
        expect(links[0].textContent).toBe(
            "secret (https://evil.example/x.png?d=1)"
        )
        expect(links[0].getAttribute("rel")).toBe("noopener noreferrer")
        expect(links[1].textContent).toBe("//evil.example/y.png")
    })

    it("loads same-origin and data: images", () => {
        const r = dom(
            renderMarkdown(
                "![a](/files/a.png) ![b](data:image/png;base64,AAAA) ![c](http://localhost/c.png)"
            )
        )
        const imgs = r.querySelectorAll("img")
        expect(imgs).toHaveLength(3)
        expect(imgs[0].getAttribute("alt")).toBe("a")
    })

    it("classifies image sources", () => {
        expect(isLocalImageSrc("")).toBe(false)
        expect(isLocalImageSrc(null)).toBe(false)
        expect(isLocalImageSrc("rel/x.png")).toBe(true)
        expect(isLocalImageSrc("https://other.example/x.png")).toBe(false)
        expect(isLocalImageSrc("/\\evil.example/x.png")).toBe(false)
        expect(isLocalImageSrc("http://[bad")).toBe(false)
    })

    it("falls back to a scheme check without a usable location", () => {
        const spy = jest
            .spyOn(window, "location", "get")
            .mockReturnValue({ origin: "null", href: "about:blank" })
        try {
            expect(isLocalImageSrc("x.png")).toBe(true)
            expect(isLocalImageSrc("https://a.example/x.png")).toBe(false)
            expect(isLocalImageSrc("//a.example/x.png")).toBe(false)
        } finally {
            spy.mockRestore()
        }
    })
})

describe("HTML blocks and sections", () => {
    it("a heading inside a multi-line HTML block starts a section", () => {
        const src = "## A\n<pre>\n\n## B\n\n</pre>\n\ntext after"
        const html = renderMarkdown(src)
        expect(html).toContain('<h2 data-section="B">B</h2>')
        expect(html).toContain('<p data-section="B">text after</p>')
        expect(html).toContain("&lt;pre&gt;")
        expect(html).not.toMatch(/<pre/)
        expect(sectionNames(src)).toEqual(["A", "B"])
    })

    it("an unclosed comment does not swallow sections", () => {
        const src = "<!-- unclosed\n\n## S\n\n<img src=x onerror=1>"
        const html = renderMarkdown(src)
        expect(html).toContain('<p data-section="S">&lt;img')
        expect(html).not.toMatch(/<img/)
        expect(sectionNames(src)).toEqual(["S"])
    })

    it("headings inside a hidden comment are not sections", () => {
        const src = "## A\n\n<!--\n## B\n-->\n\nafter"
        expect(renderMarkdown(src)).toContain('<p data-section="A">after')
        expect(sectionNames(src)).toEqual(["A"])
    })

    it("an h1 inside an HTML block ends the section", () => {
        const src = "## A\n<script>\n\n# Top\n\n</script>\n\nafter"
        const html = renderMarkdown(src)
        expect(html).toContain("<p>after</p>")
        expect(html).not.toMatch(/<script/)
    })

    it("drops comments after text, inside HTML blocks and when indented", () => {
        expect(renderMarkdown("<!-- a --> text <!-- b -->")).toBe(
            "<p>text </p>\n"
        )
        const div = renderMarkdown("<div>\n<!-- x -->\n</div>")
        expect(div).not.toContain("!--")
        expect(div).toContain("&lt;div&gt;")
        expect(renderMarkdown("  <!-- indented hint -->\n\npara")).toBe(
            "<p>para</p>\n"
        )
        // an unclosed comment inside an HTML block stays visible as text
        expect(renderMarkdown("<div>\n<!-- x\n</div>")).toContain("&lt;!-- x")
        // code spans keep a literal comment
        expect(renderMarkdown("<div>\n`<!-- c -->`\n</div>")).toContain(
            "<code>&lt;!-- c --&gt;</code>"
        )
    })

    it("never renders raw HTML from HTML blocks", () => {
        for (const src of [
            "<!-- a -->\n<!-- b --><svg onload=alert(1)>",
            "<textarea>\n\n</textarea><img src=x onerror=1>",
            "<pre>\n<!-- x -->\n<img src=x onerror=1>\n</pre>",
            "> <!-- c -->\n> <img src=x onerror=1>",
            "- <div>\n  <!-- c --> <img src=x onerror=1>",
        ]) {
            expect(renderMarkdown(src)).not.toMatch(
                /<(img|svg|script|div|textarea|pre)\b/
            )
        }
    })
})

describe("sectionNames", () => {
    it("lists h2 headings in order", () => {
        expect(sectionNames(ARTIFACT)).toEqual([
            "Summary",
            "Acceptance",
            "Decisions",
            "Links",
        ])
    })
})
