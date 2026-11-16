/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import Reviews, {
    DEFAULT_TAB,
    formatHours,
    limitedText,
    prActions,
    prStatus,
    tabFromSearch,
} from "./Reviews.jsx"
import { mockFetch, reply } from "../../test/helpers.js"
import { emit, freshStream, renderWithApp } from "../../test/render.jsx"

const pr = (over = {}) => ({
    repo: "mobile",
    number: 417,
    url: "https://github.com/acme/mobile/pull/417",
    title: "Fix the login flow",
    author: "dev1",
    is_draft: false,
    base: "main",
    state: "OPEN",
    created_at: "2026-11-10T10:00:00Z",
    updated_at: "2026-11-12T10:00:00Z",
    merged_at: null,
    closed_at: null,
    additions: 10,
    deletions: 2,
    changed_files: 3,
    ci_state: "SUCCESS",
    mergeable: "MERGEABLE",
    review_decision: null,
    decision: null,
    decided_at: null,
    decided_sha: null,
    head_sha: "sha417",
    first_review_at: null,
    attempts: 0,
    needs_review: "new",
    eligible: true,
    ineligible_reason: null,
    tracked_auto: true,
    group: "new",
    run: null,
    ...over,
})

const run = (over = {}) => ({
    id: 12,
    kind: "review",
    status: "running",
    agent_name: "pr-mobile-417",
    queued_at: "2026-11-12T10:00:00Z",
    started_at: "2026-11-12T10:01:00Z",
    finished_at: null,
    agent_open: true,
    verdict: null,
    issues: null,
    summary: null,
    error: null,
    ...over,
})

const STATS = {
    window_days: 30,
    approved: 12,
    changes_requested: 7,
    attempts: { 1: 6, 2: 4, 3: 1, "4+": 1 },
    weekly: [
        { week: "2026-11-02", approved: 3, changes_requested: 1 },
        { week: "2026-11-09", approved: 2, changes_requested: 2 },
    ],
    median_first_review_hours: 5.2,
    avg_attempts_to_approve: 1.6,
    waiting: 3,
    reviewing: 1,
    queued: 2,
    authors: [{ author: "dev1", approved: 4, changes_requested: 2 }],
}

const page = (prs, over = {}) => ({
    prs,
    counts: { new: prs.length, queued: 3, rejected: 1, approved: 2, all: 9 },
    stats: STATS,
    settings: { poll_minutes: 20, parallel: 4, agent_kind: "claude" },
    me: "me",
    ...over,
})

let stream
beforeEach(() => {
    stream = freshStream()
    window.history.replaceState(null, "", "/reviews")
})

function setup(routes = {}) {
    return mockFetch({
        "GET /api/reviews": page([pr()]),
        "GET /api/reviews/repos": { repos: [] },
        ...routes,
    })
}

describe("helpers", () => {
    it("tabFromSearch reads a known tab, else the default", () => {
        expect(tabFromSearch("?tab=rejected")).toBe("rejected")
        expect(tabFromSearch("?tab=nope")).toBe(DEFAULT_TAB)
        expect(tabFromSearch("")).toBe("new")
        expect(tabFromSearch(undefined)).toBe("new")
    })

    it("prStatus: run, state, draft, review need, decision", () => {
        const key = (over) => prStatus(pr(over)).key
        expect(key({ run: run({ status: "queued" }) })).toBe("queued")
        expect(key({ run: run() })).toBe("reviewing")
        expect(key({ run: run({ status: "reported" }) })).toBe("reviewing")
        expect(key({ run: run({ status: "done" }), state: "MERGED" })).toBe(
            "merged"
        )
        expect(key({ state: "CLOSED" })).toBe("closed")
        expect(key({ is_draft: true })).toBe("draft")
        expect(key({ needs_review: "re_review" })).toBe("re_review")
        expect(key({})).toBe("new")
        expect(key({ needs_review: null, decision: "approved" })).toBe(
            "approved"
        )
        expect(key({ needs_review: null, decision: "changes_requested" })).toBe(
            "changes_requested"
        )
        expect(prStatus(pr({ needs_review: null }))).toEqual({
            key: "none",
            label: "—",
        })
    })

    it("prActions follows the run and the PR state", () => {
        expect(prActions(pr())).toMatchObject({
            review: true,
            reviewLabel: "Review",
            cancel: false,
            focus: false,
        })
        expect(
            prActions(pr({ decision: "changes_requested" })).reviewLabel
        ).toBe("Re-review")
        expect(prActions(pr({ run: run({ status: "queued" }) }))).toMatchObject(
            { review: false, cancel: true, cancelLabel: "Cancel", focus: false }
        )
        expect(prActions(pr({ run: run() }))).toMatchObject({
            review: false,
            cancel: true,
            cancelLabel: "Close agent",
            focus: true,
        })
        // a failed run whose agent is still open
        expect(
            prActions(
                pr({
                    run: run({
                        status: "failed",
                        error: "x",
                        finished_at: "2026-11-12T11:00:00Z",
                    }),
                })
            )
        ).toMatchObject({ review: true, cancel: true, focus: true })
        expect(
            prActions(
                pr({
                    run: run({
                        status: "failed",
                        agent_open: false,
                        finished_at: "2026-11-12T11:00:00Z",
                    }),
                })
            )
        ).toMatchObject({ review: true, cancel: false, focus: false })
        expect(prActions(pr({ state: "MERGED" })).review).toBe(false)
    })

    it("prActions: Approve on open New / Changes requested rows only", () => {
        expect(prActions(pr()).approve).toBe(true)
        expect(prActions(pr({ group: "rejected" })).approve).toBe(true)
        expect(prActions(pr({ group: "approved" })).approve).toBe(false)
        expect(prActions(pr({ group: "queued" })).approve).toBe(false)
        expect(prActions(pr({ run: run() })).approve).toBe(false)
        expect(prActions(pr({ state: "CLOSED" })).approve).toBe(false)
    })

    it("formatHours", () => {
        expect(formatHours(null)).toBe("—")
        expect(formatHours(undefined)).toBe("—")
        expect(formatHours(NaN)).toBe("—")
        expect(formatHours(5.24)).toBe("5.2 h")
        expect(formatHours(30.4)).toBe("30 h")
        expect(formatHours(50)).toBe("2.1 d")
    })
})

describe("Reviews page", () => {
    it("shows stats, tabs with counts, settings and the PR rows", async () => {
        const f = setup({
            "GET /api/reviews": page([
                pr({
                    run: run({
                        status: "done",
                        verdict: "changes_requested",
                        issues: 2,
                        summary: "Two problems in the retry loop.",
                        finished_at: "2026-11-12T11:00:00Z",
                    }),
                    decision: "changes_requested",
                    decided_at: "2026-11-12T11:00:00Z",
                    attempts: 1,
                    needs_review: null,
                    ci_state: "FAILURE",
                    mergeable: "CONFLICTING",
                }),
                pr({
                    number: 418,
                    title: "Docs",
                    eligible: false,
                    ineligible_reason: "base is release",
                    ci_state: null,
                    additions: undefined,
                }),
            ]),
        })
        renderWithApp(<Reviews />)
        expect(
            await screen.findByRole("heading", { name: "PR reviews" })
        ).toBeInTheDocument()
        expect(
            await screen.findByText("Fix the login flow")
        ).toBeInTheDocument()
        expect(f.find("GET", "/api/reviews")[0].url).toBe(
            "/api/reviews?tab=new"
        )
        // stats
        expect(screen.getAllByText("12")).toHaveLength(2) // tile + donut
        expect(screen.getByText("5.2 h")).toBeInTheDocument()
        expect(screen.getByText("1.6")).toBeInTheDocument()
        expect(screen.getByText("1 in review · 2 queued")).toBeInTheDocument()
        expect(
            screen.getByLabelText("Approvals by attempt")
        ).toBeInTheDocument()
        expect(screen.getByLabelText("Reviews per week")).toBeInTheDocument()
        expect(screen.getByText("11/2")).toBeInTheDocument()
        expect(screen.getByRole("cell", { name: "dev1" })).toBeInTheDocument()
        // settings line
        expect(
            screen.getByText(/every 20 min · 4 parallel · claude/)
        ).toBeInTheDocument()
        // tabs
        expect(screen.getByRole("tab", { name: /New/ })).toHaveAttribute(
            "aria-selected",
            "true"
        )
        expect(screen.getByRole("tab", { name: /All/ })).toHaveTextContent("9")
        // rows
        const link = screen.getByRole("link", { name: /mobile#417/ })
        expect(link).toHaveAttribute("href", pr().url)
        expect(link).toHaveAttribute("target", "_blank")
        expect(screen.getByText("changes requested")).toBeInTheDocument()
        expect(screen.getByText("CI ✕")).toBeInTheDocument()
        expect(screen.getByText("conflicts")).toBeInTheDocument()
        expect(
            screen.getByText("changes requested · 2 issues")
        ).toBeInTheDocument()
        expect(
            screen.getByText("Two problems in the retry loop.")
        ).toBeInTheDocument()
        // why it is not reviewed automatically, on the chip itself
        expect(screen.getByText("manual · base is release")).toHaveAttribute(
            "title",
            "Not reviewed automatically: review it by hand or press Review"
        )
        expect(screen.getByText("+0")).toBeInTheDocument()
        expect(
            screen.getByRole("button", { name: "Re-review mobile#417" })
        ).toBeInTheDocument()
        expect(
            screen.getByRole("button", { name: "Review mobile#418" })
        ).toBeInTheDocument()
    })

    it("switches tabs (kept in the URL) and refetches", async () => {
        const f = setup()
        renderWithApp(<Reviews />)
        await screen.findByText("Fix the login flow")
        fireEvent.click(screen.getByRole("tab", { name: /Rejected/ }))
        await waitFor(() =>
            expect(f.find("GET", "/api/reviews").at(-1).url).toBe(
                "/api/reviews?tab=rejected"
            )
        )
        expect(window.location.search).toBe("?tab=rejected")
        fireEvent.click(screen.getByRole("tab", { name: /New/ }))
        await waitFor(() =>
            expect(f.find("GET", "/api/reviews").at(-1).url).toBe(
                "/api/reviews?tab=new"
            )
        )
        expect(window.location.search).toBe("")
    })

    it("Queued lists the review pipeline; an empty New points there", async () => {
        const f = setup({
            "GET /api/reviews": ({ url }) =>
                url.includes("tab=queued")
                    ? page([pr({ run: run({ status: "queued" }) })])
                    : page([], {
                          counts: { new: 0, queued: 1, all: 4 },
                      }),
        })
        renderWithApp(<Reviews />)
        expect(
            await screen.findByText(
                "Nothing waits for your review; automatic reviews are in Queued."
            )
        ).toBeInTheDocument()
        const tab = screen.getByRole("tab", { name: /Queued/ })
        expect(tab).toHaveTextContent("1")
        fireEvent.click(tab)
        expect(
            await screen.findByText("Fix the login flow")
        ).toBeInTheDocument()
        expect(f.find("GET", "/api/reviews").at(-1).url).toBe(
            "/api/reviews?tab=queued"
        )
        expect(window.location.search).toBe("?tab=queued")
    })

    it("All shows sections by status with their counts", async () => {
        window.history.replaceState(null, "", "/reviews?tab=all")
        setup({
            "GET /api/reviews": page([
                pr({ number: 1, title: "Queued one", group: "queued" }),
                pr({ number: 2, title: "Mine one", group: "new" }),
                pr({ number: 3, title: "Mine two", group: "new" }),
                pr({ number: 4, title: "Done one", group: "merged" }),
            ]),
        })
        renderWithApp(<Reviews />)
        await screen.findByText("Queued one")
        const seps = document.querySelectorAll(".rv-group")
        expect([...seps].map((e) => e.textContent)).toEqual([
            "In the queue1",
            "Waiting for you2",
            "Merged1",
        ])
    })

    it("shows the fallback, a kind at its usage limit and each run's agent", async () => {
        const until = new Date(2026, 10, 14, 17, 0, 0).toISOString()
        setup({
            "GET /api/reviews": page(
                [pr({ run: run({ agent_kind: "codex", status: "running" }) })],
                {
                    settings: {
                        poll_minutes: 20,
                        parallel: 4,
                        agent_kind: "claude",
                        fallback_kind: "codex",
                        limited: { claude: until },
                        next_kind: "codex",
                    },
                }
            ),
        })
        renderWithApp(<Reviews />)
        await screen.findByText("Fix the login flow")
        expect(
            screen.getByText(/every 20 min · 4 parallel · claude → codex/)
        ).toBeInTheDocument()
        expect(
            screen.getByText(limitedText("claude", until, "codex"))
        ).toBeInTheDocument()
        expect(limitedText("claude", until, "codex")).toMatch(
            /^claude limited until .+ → codex$/
        )
        expect(limitedText("codex", until, null)).toMatch(/→ waiting$/)
        expect(document.querySelector(".rv-run").textContent).toBe("codex")
    })

    it("shows the review models: settings, the next kind and each run", async () => {
        const until = new Date(2026, 10, 14, 17, 0, 0).toISOString()
        setup({
            "GET /api/reviews": page(
                [
                    pr({
                        run: run({
                            agent_kind: "codex",
                            agent_model: "terra-high",
                            status: "running",
                        }),
                    }),
                ],
                {
                    settings: {
                        poll_minutes: 20,
                        parallel: 4,
                        agent_kind: "claude",
                        agent_model: "opus-high",
                        fallback_kind: "codex",
                        fallback_model: "terra-high",
                        limited: { claude: until },
                        next_kind: "codex",
                        next_model: "terra-high",
                    },
                }
            ),
        })
        renderWithApp(<Reviews />)
        await screen.findByText("Fix the login flow")
        expect(
            screen.getByText(
                /4 parallel · claude \(Opus, high\) → codex \(Terra, high\)/
            )
        ).toBeInTheDocument()
        expect(
            screen.getByText(/→ codex \(Terra, high\)$/, {
                selector: ".rv-limited",
            })
        ).toBeInTheDocument()
        expect(document.querySelector(".rv-run").textContent).toBe(
            "codex (Terra, high)"
        )
    })

    it("starts on the tab from the URL", async () => {
        window.history.replaceState(null, "", "/reviews?tab=approved")
        const f = setup()
        renderWithApp(<Reviews />)
        await screen.findByText("Fix the login flow")
        expect(f.find("GET", "/api/reviews")[0].url).toBe(
            "/api/reviews?tab=approved"
        )
    })

    it("searches by number or text (debounced) and clears on Escape", async () => {
        const f = setup({
            "GET /api/reviews": ({ url }) =>
                url.includes("q=")
                    ? page([], { counts: { new: 0, all: 3 } })
                    : page([pr()]),
        })
        renderWithApp(<Reviews />)
        await screen.findByText("Fix the login flow")
        const box = screen.getByLabelText("Search PRs")
        fireEvent.change(box, { target: { value: "#417" } })
        expect(
            await screen.findByText("No PRs match “#417”")
        ).toBeInTheDocument()
        expect(f.find("GET", "/api/reviews").at(-1).url).toBe(
            "/api/reviews?tab=new&q=%23417"
        )
        fireEvent.keyDown(box, { key: "Escape" })
        expect(box).toHaveValue("")
        expect(
            await screen.findByText("Fix the login flow")
        ).toBeInTheDocument()
    })

    it("Escape before the search ran drops that search", async () => {
        const f = setup({
            "GET /api/reviews": ({ url }) =>
                url.includes("q=") ? page([]) : page([pr()]),
        })
        renderWithApp(<Reviews />)
        await screen.findByText("Fix the login flow")
        const box = screen.getByLabelText("Search PRs")
        fireEvent.change(box, { target: { value: "zzz" } })
        fireEvent.keyDown(box, { key: "Escape" })
        await act(() => new Promise((r) => setTimeout(r, 400)))
        expect(box).toHaveValue("")
        expect(
            f.find("GET", "/api/reviews").some((c) => c.url.includes("q="))
        ).toBe(false)
        expect(screen.getByText("Fix the login flow")).toBeInTheDocument()
    })

    it("a failed refresh shows an error; another tab's rows are never shown", async () => {
        let fail = false
        setup({
            "GET /api/reviews": () =>
                fail ? reply(500, { message: "gh is down" }) : page([pr()]),
        })
        renderWithApp(<Reviews />)
        await screen.findByText("Fix the login flow")
        fail = true
        // same tab: the rows stay, with the error and Retry
        act(() => emit(stream, "reviews.updated", null, {}))
        expect(
            await screen.findByText(
                "Refresh failed: gh is down",
                {},
                { timeout: 2000 }
            )
        ).toBeInTheDocument()
        expect(screen.getByText("Fix the login flow")).toBeInTheDocument()
        // another tab: no rows of New under Rejected
        fireEvent.click(screen.getByRole("tab", { name: /Rejected/ }))
        expect(
            await screen.findByText("Can't load the PR reviews")
        ).toBeInTheDocument()
        expect(screen.queryByText("Fix the login flow")).toBeNull()
        fail = false
        fireEvent.click(screen.getByRole("button", { name: "Retry" }))
        expect(
            await screen.findByText("Fix the login flow")
        ).toBeInTheDocument()
    })

    it("an empty dashboard points at the Repos menu", async () => {
        setup({
            "GET /api/reviews": page([], {
                counts: { new: 0, rejected: 0, approved: 0, all: 0 },
                stats: null,
                settings: null,
            }),
        })
        renderWithApp(<Reviews />)
        expect(
            await screen.findByText(
                "Track a repo in the Repos menu to see its PRs."
            )
        ).toBeInTheDocument()
        expect(screen.queryByLabelText("Review stats")).toBeNull()
    })

    it("queues a review, cancels, closes and focuses agents", async () => {
        const f = setup({
            "GET /api/reviews": page([
                pr(),
                pr({ number: 2, run: run({ id: 20, status: "queued" }) }),
                pr({ number: 3, run: run({ id: 30 }) }),
            ]),
            "POST /api/reviews/prs/mobile/417/review": { run: run() },
            "POST /api/reviews/runs/20/cancel": { run: run() },
            "POST /api/reviews/runs/30/cancel": { run: run() },
            "POST /api/reviews/runs/30/focus": { ok: true },
            "POST /api/reviews/scan": { ok: true },
        })
        renderWithApp(<Reviews />)
        await screen.findByText("mobile#417")
        fireEvent.click(
            screen.getByRole("button", { name: "Review mobile#417" })
        )
        expect(
            await screen.findByText("mobile#417: review queued")
        ).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Cancel mobile#2" }))
        expect(
            await screen.findByText("mobile#2: review dropped")
        ).toBeInTheDocument()
        fireEvent.click(
            screen.getByRole("button", { name: "Close agent mobile#3" })
        )
        expect(
            await screen.findByText("mobile#3: agent closed")
        ).toBeInTheDocument()
        fireEvent.click(
            screen.getByRole("button", { name: "Open mobile#3 in herdr" })
        )
        expect(
            await screen.findByText("herdr: switched to #3")
        ).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Scan now" }))
        expect(
            await screen.findByText("Scanning the tracked repos…")
        ).toBeInTheDocument()
        expect(f.find("POST", "/api/reviews/scan")[0].body).toEqual({})
        // each action reloads the list
        await waitFor(() =>
            expect(f.find("GET", "/api/reviews").length).toBeGreaterThan(3)
        )
    })

    it("approves a PR: button off meanwhile, then a toast and a reload", async () => {
        let release
        const f = setup({
            "GET /api/reviews": page([
                pr(),
                pr({ number: 5, group: "approved", decision: "approved" }),
            ]),
            "POST /api/reviews/prs/mobile/417/approve": () =>
                new Promise((resolve) => {
                    release = () => resolve({ ok: true })
                }),
        })
        renderWithApp(<Reviews />)
        await screen.findByText("mobile#417")
        expect(
            screen.queryByRole("button", { name: "Approve mobile#5" })
        ).toBeNull()
        const btn = screen.getByRole("button", { name: "Approve mobile#417" })
        fireEvent.click(btn)
        await waitFor(() => expect(btn).toBeDisabled())
        expect(btn).toHaveTextContent("Approving…")
        // no review of it meanwhile either
        expect(
            screen.getByRole("button", { name: "Review mobile#417" })
        ).toBeDisabled()
        // a second click while it is on its way sends nothing
        fireEvent.click(btn)
        const before = f.find("GET", "/api/reviews").length
        act(() => release())
        expect(
            await screen.findByText("mobile#417: approved")
        ).toBeInTheDocument()
        const sent = f.find("POST", "/api/reviews/prs/mobile/417/approve")
        expect(sent).toHaveLength(1)
        expect(sent[0].body).toEqual({ head_sha: "sha417" })
        await waitFor(() => expect(btn).not.toBeDisabled())
        await waitFor(() =>
            expect(f.find("GET", "/api/reviews").length).toBeGreaterThan(before)
        )
    })

    it("toasts an approve error", async () => {
        setup({
            "POST /api/reviews/prs/mobile/417/approve": reply(409, {
                message: "has a review run",
            }),
        })
        renderWithApp(<Reviews />)
        await screen.findByText("mobile#417")
        fireEvent.click(
            screen.getByRole("button", { name: "Approve mobile#417" })
        )
        expect(await screen.findByText("has a review run")).toBeInTheDocument()
        expect(
            screen.getByRole("button", { name: "Approve mobile#417" })
        ).not.toBeDisabled()
    })

    it("toasts action errors", async () => {
        const fail = reply(409, { error: "busy", message: "nope" })
        setup({
            "GET /api/reviews": page([
                pr(),
                pr({ number: 3, run: run({ id: 30 }) }),
            ]),
            "POST /api/reviews/prs/mobile/417/review": fail,
            "POST /api/reviews/runs/30/cancel": reply(500, {
                message: "cancel failed",
            }),
            "POST /api/reviews/runs/30/focus": reply(500, {
                message: "focus failed",
            }),
            "POST /api/reviews/scan": reply(500, { message: "scan failed" }),
        })
        renderWithApp(<Reviews />)
        await screen.findByText("mobile#417")
        fireEvent.click(
            screen.getByRole("button", { name: "Review mobile#417" })
        )
        expect(await screen.findByText("nope")).toBeInTheDocument()
        fireEvent.click(
            screen.getByRole("button", { name: "Close agent mobile#3" })
        )
        expect(await screen.findByText("cancel failed")).toBeInTheDocument()
        fireEvent.click(
            screen.getByRole("button", { name: "Open mobile#3 in herdr" })
        )
        expect(await screen.findByText("focus failed")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Scan now" }))
        expect(await screen.findByText("scan failed")).toBeInTheDocument()
    })

    it("refetches on reviews.updated and reconnects", async () => {
        const f = setup()
        renderWithApp(<Reviews />)
        await screen.findByText("Fix the login flow")
        const before = f.find("GET", "/api/reviews").length
        act(() => emit(stream, "reviews.updated", null, {}))
        act(() => emit(stream, "stream.reconnected", null, {}))
        await waitFor(() =>
            expect(f.find("GET", "/api/reviews").length).toBe(before + 1)
        )
    })

    it("shows a load error with retry", async () => {
        let n = 0
        setup({
            "GET /api/reviews": () =>
                n++ === 0
                    ? reply(500, { message: "gh is down" })
                    : page([pr()]),
        })
        renderWithApp(<Reviews />)
        expect(await screen.findByText("gh is down")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Retry" }))
        expect(
            await screen.findByText("Fix the login flow")
        ).toBeInTheDocument()
    })

    it("run details: failed, cancelled and summary-only runs", async () => {
        setup({
            "GET /api/reviews": page([
                pr({ run: run({ status: "failed", error: "no report" }) }),
                pr({
                    number: 2,
                    run: run({
                        status: "cancelled",
                        finished_at: "2026-11-12T11:00:00Z",
                    }),
                }),
                pr({
                    number: 3,
                    run: run({
                        status: "done",
                        verdict: "approved",
                        issues: 1,
                        finished_at: "2026-11-12T11:00:00Z",
                    }),
                }),
                pr({
                    number: 4,
                    run: run({
                        status: "done",
                        summary: "Looked fine.",
                        finished_at: "2026-11-12T11:00:00Z",
                    }),
                }),
                pr({
                    number: 5,
                    run: run({
                        status: "failed",
                        finished_at: "2026-11-12T11:00:00Z",
                    }),
                }),
            ]),
        })
        renderWithApp(<Reviews />)
        expect(
            await screen.findByText("review failed: no report")
        ).toBeInTheDocument()
        expect(screen.getByText("review cancelled")).toBeInTheDocument()
        expect(screen.getByText("approved · 1 issue")).toBeInTheDocument()
        expect(screen.getByText("agent summary")).toBeInTheDocument()
        expect(screen.getByText("review failed")).toBeInTheDocument()
    })

    it("viewers see nothing", () => {
        const f = setup()
        renderWithApp(<Reviews />, { role: "viewer" })
        expect(screen.getByText("Nothing here")).toBeInTheDocument()
        expect(screen.queryByText("PR reviews")).toBeNull()
        expect(f.calls).toHaveLength(0)
    })
})
