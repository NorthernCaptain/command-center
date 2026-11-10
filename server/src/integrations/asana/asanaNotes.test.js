/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    asanaStatusKey,
    branchUrl,
    buildConclusion,
    buildDescriptionHtml,
    buildTrackingBlockHtml,
    inlineHtml,
    collectRefs,
    safeDecode,
    escapeHtml,
    formatUpdated,
    MANAGED_MARKER,
    mergeManagedBlock,
    prLabel,
    repoUrl,
    trackingFingerprint,
} from "./asanaNotes.js"

const ALLOWED = new Set([
    "body",
    "strong",
    "em",
    "u",
    "s",
    "code",
    "a",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "h1",
    "h2",
    "hr",
])

/** Minimal validity check: allowed tags, balanced, no comments, no raw & < >. */
function assertAsanaRichText(html) {
    expect(html.startsWith("<body>")).toBe(true)
    expect(html.endsWith("</body>")).toBe(true)
    expect(html).not.toContain("<!--")
    const stack = []
    const tagRe = /<(\/?)([a-z0-9]+)((?:\s+[a-z]+="[^"<>]*")*)\s*(\/?)>/gi
    let last = 0
    let m
    while ((m = tagRe.exec(html))) {
        const text = html.slice(last, m.index)
        expect(text).not.toMatch(/[<>]/)
        expect(text).not.toMatch(/&(?!(amp|lt|gt|quot|#39);)/)
        last = tagRe.lastIndex
        const [, close, name, , selfClose] = m
        expect(ALLOWED.has(name)).toBe(true)
        if (selfClose || name === "hr") continue
        if (close) expect(stack.pop()).toBe(name)
        else stack.push(name)
    }
    expect(html.slice(last)).toBe("")
    expect(stack).toEqual([])
}

const TASK = {
    id: 123,
    title: "Fix upload retry",
    status: "pr_open",
    updated_at: "2026-11-12T14:05:00Z",
    repos: [
        { name: "aws-lambda", role: "main" },
        { name: "infrastructure", role: "work" },
        { name: "mobile", role: "ref" },
        { name: "mobile", role: "ref" },
    ],
    deliverables: [
        {
            repo: "aws-lambda",
            branch: "t123-fix-upload-retry",
            role: "work",
            pr: "https://github.com/acme/aws-lambda/pull/812",
        },
        {
            repo: "infrastructure",
            branch: "feat/t123 <x>",
            role: "work",
            pr: null,
        },
        { repo: "broken", branch: null },
    ],
    links: [
        {
            id: "l1",
            type: "pr",
            url: "https://github.com/acme/aws-lambda/pull/812",
            label: "dup",
        },
        {
            id: "l2",
            type: "pr",
            url: "https://github.com/acme/infrastructure/pull/9",
            label: null,
        },
        { id: "l3", type: "pr", url: "not-a-url" },
        {
            id: "l4",
            type: "branch",
            url: "https://github.com/acme/ptools/tree/feature%2Fx",
            label: null,
        },
        {
            id: "l5",
            type: "branch",
            url: "https://gitlab.example/b",
            label: "other-branch",
        },
        { id: "l6", type: "branch", url: "https://gitlab.example/c" },
        { id: "l7", type: "slack", url: "https://slack.com/x" },
    ],
}

describe("escapeHtml", () => {
    test("escapes &, <, > and quotes", () => {
        expect(escapeHtml(`a & b <c> "d" 'e'`)).toBe(
            "a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;"
        )
        expect(escapeHtml(null)).toBe("")
    })
})

describe("url helpers", () => {
    test("branchUrl keeps slashes, encodes the rest", () => {
        expect(branchUrl("aws-lambda", "feat/a b", "acme")).toBe(
            "https://github.com/acme/aws-lambda/tree/feat/a%20b"
        )
        expect(repoUrl("ptools", "acme")).toBe("https://github.com/acme/ptools")
        // without an org (github.org unset) there is no GitHub URL
        expect(branchUrl("aws-lambda", "b", null)).toBeNull()
        expect(repoUrl("ptools")).toBeNull()
    })
    test("prLabel", () => {
        expect(prLabel("https://github.com/acme/mobile/pull/77")).toBe(
            "mobile#77"
        )
        expect(prLabel("https://example.com")).toBeNull()
    })
    test("formatUpdated", () => {
        expect(formatUpdated("2026-11-12T14:05:00Z", "UTC")).toBe(
            "2026-11-12 14:05"
        )
        expect(
            formatUpdated("2026-11-12T14:05:00Z", "America/Los_Angeles")
        ).toBe("2026-11-12 06:05")
        expect(formatUpdated(null)).toBeNull()
        expect(formatUpdated("garbage")).toBeNull()
    })
})

describe("buildDescriptionHtml", () => {
    test("full prose with source link", () => {
        const html = buildDescriptionHtml({
            prose: {
                summary: "Uploads fail <sometimes> & retry",
                context: "Ron asked in Slack.",
                acceptance: ["Retries 3x", "  ", null, 'Logs "why"'],
                approach: "Add backoff.",
            },
            sourceUrl: "https://acme.slack.com/archives/C1/p1?a=1&b=2",
        })
        assertAsanaRichText(html)
        expect(html).toBe(
            "<body><strong>Summary</strong>\nUploads fail &lt;sometimes&gt; &amp; retry\n\n" +
                "<strong>Context</strong>\nRon asked in Slack.\n" +
                'Source: <a href="https://acme.slack.com/archives/C1/p1?a=1&amp;b=2">' +
                "https://acme.slack.com/archives/C1/p1?a=1&amp;b=2</a>\n\n" +
                "<strong>Acceptance</strong>\n<ul><li>Retries 3x</li><li>Logs &quot;why&quot;</li></ul>\n" +
                "<strong>Approach</strong>\nAdd backoff.</body>"
        )
    })

    test("only source url, non-http source ignored, empty prose", () => {
        const a = buildDescriptionHtml({
            prose: {},
            sourceUrl: "https://x.test",
        })
        expect(a).toBe(
            '<body><strong>Context</strong>\nSource: <a href="https://x.test">https://x.test</a></body>'
        )
        const b = buildDescriptionHtml({
            prose: { summary: "S" },
            sourceUrl: "javascript:alert(1)",
        })
        expect(b).toBe("<body><strong>Summary</strong>\nS</body>")
        expect(buildDescriptionHtml()).toBe("<body></body>")
        assertAsanaRichText(a)
    })
})

describe("collectRefs", () => {
    test("dedupes branches and PRs from deliverables and links", () => {
        const refs = collectRefs(TASK, { org: "acme" })
        expect(refs.repos).toEqual(["aws-lambda", "infrastructure", "mobile"])
        expect(refs.branches).toEqual([
            {
                repo: "aws-lambda",
                branch: "t123-fix-upload-retry",
                url: "https://github.com/acme/aws-lambda/tree/t123-fix-upload-retry",
            },
            {
                repo: "infrastructure",
                branch: "feat/t123 <x>",
                url: "https://github.com/acme/infrastructure/tree/feat/t123%20%3Cx%3E",
            },
            {
                repo: "ptools",
                branch: "feature/x",
                url: "https://github.com/acme/ptools/tree/feature%2Fx",
            },
            {
                repo: null,
                branch: "other-branch",
                url: "https://gitlab.example/b",
            },
            {
                repo: null,
                branch: "https://gitlab.example/c",
                url: "https://gitlab.example/c",
            },
        ])
        expect(refs.prs).toEqual([
            {
                url: "https://github.com/acme/aws-lambda/pull/812",
                label: "aws-lambda#812",
            },
            {
                url: "https://github.com/acme/infrastructure/pull/9",
                label: "infrastructure#9",
            },
        ])
    })

    test("empty task", () => {
        expect(collectRefs({})).toEqual({ repos: [], branches: [], prs: [] })
        expect(collectRefs(null)).toEqual({ repos: [], branches: [], prs: [] })
    })
})

describe("buildTrackingBlockHtml", () => {
    test("full block: two small italic reference lines", () => {
        const block = buildTrackingBlockHtml({
            task: TASK,
            artifactUrl: "https://mac.tail.ts.net:8443/t/123",
            timeZone: "UTC",
            org: "acme",
        })
        expect(block.startsWith(MANAGED_MARKER)).toBe(true)
        const [head, refs, ...rest] = block.split("\n")
        expect(rest).toEqual([])
        expect(head).toBe(
            '<hr/><em>Command Center: T-123 · <a href="https://mac.tail.ts.net:8443/t/123">artifact</a> · pr_open · updated 2026-11-12 14:05</em>'
        )
        expect(refs.startsWith("<em>Repos: ")).toBe(true)
        expect(refs.endsWith("</em>")).toBe(true)
        expect(refs).toContain(
            'aws-lambda @ <a href="https://github.com/acme/aws-lambda/tree/t123-fix-upload-retry">t123-fix-upload-retry</a>'
        )
        expect(refs).toContain("feat/t123 &lt;x&gt;</a>")
        expect(refs).toContain(
            '<a href="https://gitlab.example/b">other-branch</a>'
        )
        expect(refs).toContain(
            '<a href="https://github.com/acme/mobile">mobile</a>'
        )
        expect(refs).not.toContain(
            '<a href="https://github.com/acme/aws-lambda">'
        )
        expect(refs).toContain(
            ' · PRs: <a href="https://github.com/acme/aws-lambda/pull/812">aws-lambda#812</a>, '
        )
        // no headings, bold labels or lists any more
        expect(block).not.toMatch(/<h2>|<strong>|<ul>|<li>/)
        assertAsanaRichText(`<body>${block}</body>`)
    })

    test("minimal block: one line", () => {
        expect(buildTrackingBlockHtml({ task: { status: "ready" } })).toBe(
            `${MANAGED_MARKER} ready</em>`
        )
        expect(
            buildTrackingBlockHtml({ task: {}, artifactUrl: "ftp://x" })
        ).toBe(`${MANAGED_MARKER} unknown</em>`)
        expect(buildTrackingBlockHtml()).toBe(`${MANAGED_MARKER} unknown</em>`)
        // PRs only
        expect(
            buildTrackingBlockHtml({
                task: {
                    id: 4,
                    status: "pr_open",
                    links: [
                        {
                            type: "pr",
                            url: "https://github.com/acme/web/pull/3",
                        },
                    ],
                },
            })
        ).toBe(
            `${MANAGED_MARKER} T-4 · pr_open</em>\n<em>PRs: <a href="https://github.com/acme/web/pull/3">web#3</a></em>`
        )
    })

    test("the old heading block is still found and replaced", () => {
        const old =
            "<body>Desc<hr/><h2>Command Center</h2><strong>Task:</strong> T-1\n<strong>Status:</strong> inbox</body>"
        const next = mergeManagedBlock(
            old,
            buildTrackingBlockHtml({ task: { id: 1, status: "active" } })
        )
        expect(next).toBe(
            `<body>Desc${MANAGED_MARKER} T-1 · active</em></body>`
        )
        // and the new block replaces itself
        expect(
            mergeManagedBlock(
                next,
                buildTrackingBlockHtml({ task: { id: 1, status: "done" } })
            )
        ).toBe(`<body>Desc${MANAGED_MARKER} T-1 · done</em></body>`)
    })
})

describe("mergeManagedBlock", () => {
    const BLOCK = `${MANAGED_MARKER}<strong>Status:</strong> done`

    test("replaces an existing block, keeps the text before verbatim", () => {
        const existing =
            "<body>Teammate <em>edit</em> &amp; stuff\n<hr/><h2>Command Center</h2><strong>Status:</strong> old\n<ul><li>x</li></ul></body>"
        expect(mergeManagedBlock(existing, BLOCK)).toBe(
            `<body>Teammate <em>edit</em> &amp; stuff\n${BLOCK}</body>`
        )
    })

    test("tolerates Asana-normalized marker variants", () => {
        const existing = "<body>A<hr>\n<h2> Command Center </h2>old</body>"
        expect(mergeManagedBlock(existing, BLOCK)).toBe(
            `<body>A${BLOCK}</body>`
        )
    })

    test("appends when the marker is missing", () => {
        expect(mergeManagedBlock("<body>Hello</body>", BLOCK)).toBe(
            `<body>Hello${BLOCK}</body>`
        )
        expect(mergeManagedBlock("<body>Hello<hr/>Other</body>\n", BLOCK)).toBe(
            `<body>Hello<hr/>Other${BLOCK}</body>`
        )
    })

    test("empty, null and body-less input", () => {
        expect(mergeManagedBlock(null, BLOCK)).toBe(`<body>${BLOCK}</body>`)
        expect(mergeManagedBlock("", BLOCK)).toBe(`<body>${BLOCK}</body>`)
        expect(mergeManagedBlock("plain", BLOCK)).toBe(
            `<body>plain${BLOCK}</body>`
        )
        expect(mergeManagedBlock("<body>unclosed", BLOCK)).toBe(
            `<body>unclosed${BLOCK}</body>`
        )
    })

    test("is idempotent", () => {
        const once = mergeManagedBlock("<body>X</body>", BLOCK)
        expect(mergeManagedBlock(once, BLOCK)).toBe(once)
    })

    test("description + block is valid rich text", () => {
        const html = mergeManagedBlock(
            buildDescriptionHtml({
                prose: { summary: "S", acceptance: ["a"] },
            }),
            buildTrackingBlockHtml({
                task: TASK,
                artifactUrl: "https://h/t/1",
                timeZone: "UTC",
            })
        )
        assertAsanaRichText(html)
    })
})

describe("branch URLs with a stray %", () => {
    test("safeDecode never throws", () => {
        expect(safeDecode("fix%2Fx")).toBe("fix/x")
        expect(safeDecode("fix/100%-cpu")).toBe("fix/100%-cpu")
    })

    test("collectRefs and the tracking block survive malformed escapes", () => {
        const t = {
            id: 5,
            status: "active",
            links: [
                {
                    type: "branch",
                    url: "https://github.com/acme/api/tree/fix/100%-cpu",
                    label: null,
                },
            ],
        }
        expect(collectRefs(t).branches).toEqual([
            {
                repo: "api",
                branch: "fix/100%-cpu",
                url: "https://github.com/acme/api/tree/fix/100%-cpu",
            },
        ])
        expect(buildTrackingBlockHtml({ task: t })).toContain(
            "fix/100%-cpu</a>"
        )
    })

    test("marker line is appended (escaped) to the tracking block", () => {
        const html = buildTrackingBlockHtml({
            task: { id: 5, status: "ready" },
            marker: "Command-Center-Task: T-5 <x>",
        })
        expect(
            html.endsWith("\n<em>Command-Center-Task: T-5 &lt;x&gt;</em>")
        ).toBe(true)
    })
})

describe("asanaStatusKey", () => {
    test("maps task statuses to Asana Status keys", () => {
        expect(asanaStatusKey("inbox")).toBe("initial")
        expect(asanaStatusKey("ready")).toBe("initial")
        expect(asanaStatusKey("active")).toBe("in_progress")
        expect(asanaStatusKey("ready_for_pr")).toBe("code_review")
        expect(asanaStatusKey("pr_open")).toBe("code_review")
        expect(asanaStatusKey("pr_feedback")).toBe("code_review")
        expect(asanaStatusKey("done")).toBe("released")
        expect(asanaStatusKey("cancelled")).toBe("cancelled")
        expect(asanaStatusKey("waiting")).toBeNull()
        expect(asanaStatusKey("review")).toBeNull()
        expect(asanaStatusKey(undefined)).toBeNull()
    })
})

describe("no GitHub org configured", () => {
    test("repos are plain text, task branches without URLs are left out", () => {
        const block = buildTrackingBlockHtml({
            task: {
                id: 3,
                status: "active",
                repos: [{ name: "mobile", role: "main" }],
                deliverables: [
                    {
                        repo: "mobile",
                        branch: "t3-x",
                        role: "work",
                        disposition: "pending",
                    },
                ],
            },
        })
        expect(block).toContain("<em>Repos: mobile</em>")
        expect(block).not.toContain("github.com")
    })
})

describe("trackingFingerprint: branch-only changes", () => {
    const base = (branch) => ({
        id: 9,
        status: "active",
        asana: { gid: "1" },
        deliverables: [
            { repo: "mobile", branch, role: "work", disposition: "pending" },
        ],
    })
    test("a deliverable branch change re-syncs, with or without an org", () => {
        for (const org of [null, "acme"]) {
            expect(trackingFingerprint(base("t9-a"), null, org)).not.toBe(
                trackingFingerprint(base("t9-b"), null, org)
            )
        }
        // the org changes the URLs, so the fingerprint too
        expect(trackingFingerprint(base("t9-a"), null, "acme")).not.toBe(
            trackingFingerprint(base("t9-a"), null, null)
        )
    })
})

describe("trackingFingerprint: org changes", () => {
    test("repos without deliverables re-sync when the org changes", () => {
        const t = {
            id: 10,
            status: "inbox",
            asana: { gid: "1" },
            repos: [{ name: "mobile", role: "main" }],
            deliverables: [],
        }
        const none = trackingFingerprint(t, null, null)
        const acme = trackingFingerprint(t, null, "acme")
        expect(acme).not.toBe(none)
        expect(trackingFingerprint(t, null, "other")).not.toBe(acme)
        expect(trackingFingerprint(t, null, "acme")).toBe(acme)
    })
})

describe("inlineHtml", () => {
    test("code, bold, Markdown links and bare URLs; the rest escaped", () => {
        expect(
            inlineHtml(
                "Run `nmcli r wifi <on>` **now**; see [PR #59](https://github.com/acme/fw/pull/59) and https://x.example.com/a?b=1&c=2."
            )
        ).toBe(
            'Run <code>nmcli r wifi &lt;on&gt;</code> <strong>now</strong>; see <a href="https://github.com/acme/fw/pull/59">PR #59</a> and <a href="https://x.example.com/a?b=1&amp;c=2">https://x.example.com/a?b=1&amp;c=2</a>.'
        )
        // a URL inside code stays code
        expect(inlineHtml("`https://a.example.com`")).toBe(
            "<code>https://a.example.com</code>"
        )
        expect(inlineHtml(null)).toBe("")
        expect(inlineHtml('<b onclick="x">')).toBe(
            "&lt;b onclick=&quot;x&quot;&gt;"
        )
    })
})

describe("buildConclusion", () => {
    test("outcome, details and open items as rich and plain text", () => {
        const c = buildConclusion({
            outcome: " Found it. ",
            points: ["Cause: `radio off`", " ", null],
            open_items: ["Run it on X39311"],
        })
        expect(c.html).toBe(
            "<body><strong>Done</strong>\nFound it.\n\n<strong>Details</strong>\n<ul><li>Cause: <code>radio off</code></li></ul>\n\n<strong>Still open</strong>\n<ul><li>Run it on X39311</li></ul></body>"
        )
        expect(c.text).toBe(
            "Done\nFound it.\n\nDetails\n- Cause: `radio off`\n\nStill open\n- Run it on X39311"
        )
    })

    test("points without an outcome; nothing to say -> empty", () => {
        expect(buildConclusion({ points: ["a"] }).text).toBe("Details\n- a")
        expect(buildConclusion({ outcome: "", open_items: ["x"] })).toEqual({
            html: "",
            text: "",
        })
        expect(buildConclusion()).toEqual({ html: "", text: "" })
    })
})
