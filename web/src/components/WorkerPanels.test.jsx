/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react"
import {
    AgentPanel,
    DeliverablesPanel,
    DeliverablesSummary,
    FeedbackPanel,
    ReviewsPanel,
    groupRounds,
    prNumber,
    roundSummary,
} from "./WorkerPanels.jsx"
import { sampleTask } from "../../test/helpers.js"

const PR = "https://github.com/acme/aws-lambda/pull/812"

describe("helpers", () => {
    it("prNumber", () => {
        expect(prNumber(PR)).toBe("#812")
        expect(prNumber("https://x")).toBeNull()
        expect(prNumber(null)).toBeNull()
    })

    it("groupRounds sorts rounds newest first and items by time", () => {
        const out = groupRounds([
            { id: "a", round: 1, at: "2" },
            { id: "b", round: 2, at: "1" },
            { id: "c", round: 1, at: "1" },
            { id: "d" },
        ])
        expect(out.map((r) => r.round)).toEqual([2, 1])
        expect(out[1].items.map((i) => i.id)).toEqual(["d", "c", "a"])
        expect(groupRounds(null)).toEqual([])
    })

    it("roundSummary counts statuses", () => {
        expect(
            roundSummary([
                { status: "fixed" },
                { status: "fixed" },
                { status: "answered" },
            ])
        ).toBe("3 items · 2 fixed, 1 answered")
        expect(roundSummary([{ status: "weird" }])).toBe("1 item")
    })
})

describe("AgentPanel", () => {
    it("shows the agent, queued prompts and the last error", () => {
        render(
            <AgentPanel
                agent={{
                    state: "working",
                    kind: "claude",
                    name: "t12-fix",
                    session_id: "sess-1",
                    pane_id: "p3",
                }}
                outbox={[
                    {
                        id: 1,
                        text: "Address feedback round 2\nmore lines",
                        reason: "pr_feedback",
                        created_at: "2026-11-07T09:00:00Z",
                    },
                    {
                        id: 2,
                        text: "x".repeat(200),
                        reason: "follow-up",
                        status: "failed",
                        error: "agent_not_found",
                    },
                ]}
                task={sampleTask({
                    flags: { error: "Claude unavailable: usage limit" },
                })}
            />
        )
        expect(screen.getByLabelText("Agent t12-fix: working")).toBeVisible()
        expect(screen.getByText("Claude")).toBeInTheDocument()
        expect(screen.getByText("sess-1")).toBeInTheDocument()
        expect(screen.getByText("p3")).toBeInTheDocument()
        expect(
            screen.getByText("Last error: Claude unavailable: usage limit")
        ).toBeInTheDocument()
        expect(screen.getByText("Address feedback round 2")).toBeInTheDocument()
        expect(screen.getByText(/^x+…$/)).toBeInTheDocument()
        expect(screen.getByText("agent_not_found")).toBeInTheDocument()
        expect(screen.getByText("failed")).toBeInTheDocument()
    })

    it("offers Retry for failed prompts and Cancel for pending ones", () => {
        const onAction = jest.fn()
        render(
            <AgentPanel
                agent={{ state: "idle", kind: "claude", name: "t1-x" }}
                outbox={[
                    {
                        id: 7,
                        text: "check CI",
                        reason: "follow-up",
                        status: "pending",
                    },
                    {
                        id: 8,
                        text: "fix review",
                        reason: "pr_feedback",
                        status: "failed",
                        error: "pane gone",
                    },
                ]}
                task={sampleTask()}
                onAction={onAction}
            />
        )
        fireEvent.click(screen.getByRole("button", { name: "Retry prompt 8" }))
        expect(onAction).toHaveBeenCalledWith("retry", { id: 8 })
        fireEvent.click(screen.getByRole("button", { name: "Cancel prompt 7" }))
        expect(onAction).toHaveBeenCalledWith("cancel", { id: 7 })
        expect(
            screen.queryByRole("button", { name: "Retry prompt 7" })
        ).not.toBeInTheDocument()
    })

    it("shows no prompt buttons without an action handler", () => {
        render(
            <AgentPanel
                agent={null}
                outbox={[{ id: 1, text: "x", reason: "a", status: "failed" }]}
                task={sampleTask()}
            />
        )
        expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull()
    })

    it("shows the empty states", () => {
        render(
            <AgentPanel
                agent={{ state: "gone", kind: "other" }}
                outbox={null}
                task={sampleTask()}
            />
        )
        expect(screen.getByText("other")).toBeInTheDocument()
        expect(screen.getAllByText("—")).toHaveLength(2)
        expect(
            screen.getByText("Nothing queued for the agent.")
        ).toBeInTheDocument()
    })

    it("says when there is no live agent", () => {
        const { rerender } = render(
            <AgentPanel
                agent={null}
                task={sampleTask({ worker_kind: "codex" })}
            />
        )
        expect(
            screen.getByText("No live agent. Last worker: Codex.")
        ).toBeInTheDocument()
        rerender(<AgentPanel agent={null} task={sampleTask()} />)
        expect(screen.getByText("No live agent.")).toBeInTheDocument()
        rerender(
            <AgentPanel agent={null} task={sampleTask({ worker_kind: "x" })} />
        )
        expect(
            screen.getByText("No live agent. Last worker: x.")
        ).toBeInTheDocument()
        rerender(<AgentPanel agent={null} />)
        expect(screen.getByText("No live agent.")).toBeInTheDocument()
    })
})

describe("DeliverablesPanel", () => {
    const deliverables = [
        {
            repo: "aws-lambda",
            branch: "t12-fix",
            disposition: "pr",
            pr: PR,
            merged_at: "2026-11-07T08:00:00Z",
        },
        {
            repo: "web-app",
            branch: "t12-fix",
            disposition: "pending",
            pr: null,
        },
        { repo: "ios", branch: "t12-fix", disposition: "no_change" },
    ]
    const prs = [
        {
            repo: "aws-lambda",
            number: 812,
            url: "other-form",
            state: "open",
            ci_state: "failure",
            last_checked_at: "2026-11-07T09:00:00Z",
        },
    ]

    it("lists deliverables with PR state and marks no change", async () => {
        const onNoChange = jest.fn(async () => {})
        render(
            <DeliverablesPanel
                deliverables={deliverables}
                prs={prs}
                candidates={[]}
                onNoChange={onNoChange}
                onClaim={jest.fn()}
            />
        )
        expect(
            screen.getByRole("link", {
                name: "Pull request #812 on GitHub",
            })
        ).toHaveAttribute("href", PR)
        expect(screen.getByText(/^merged/)).toBeInTheDocument()
        expect(screen.getByText("CI failure")).toBeInTheDocument()
        expect(screen.getByText("open")).toBeInTheDocument()
        expect(screen.getByText("no PR yet")).toBeInTheDocument()
        expect(screen.getByText("no change")).toBeInTheDocument()
        expect(
            screen.queryByRole("button", {
                name: "Mark aws-lambda as no change",
            })
        ).toBeNull()
        fireEvent.click(
            screen.getByRole("button", { name: "Mark web-app as no change" })
        )
        await waitFor(() => expect(onNoChange).toHaveBeenCalledWith("web-app"))
        expect(
            screen.getByText("None found on the task branches.")
        ).toBeInTheDocument()
    })

    it("claims candidates and PRs by URL", async () => {
        const onClaim = jest
            .fn()
            .mockResolvedValueOnce()
            .mockRejectedValueOnce(new Error("no"))
            .mockResolvedValueOnce()
        render(
            <DeliverablesPanel
                deliverables={[]}
                candidates={[
                    {
                        repo: "aws-lambda",
                        url: PR,
                        reason: "body lacks Command-Center-Task",
                    },
                    { repo: "x", url: "https://x/pull/2" },
                ]}
                onNoChange={jest.fn()}
                onClaim={onClaim}
            />
        )
        expect(screen.getByText("No work repos yet.")).toBeInTheDocument()
        expect(
            screen.getByText("body lacks Command-Center-Task")
        ).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: `Claim ${PR}` }))
        await waitFor(() => expect(onClaim).toHaveBeenCalledWith(PR))

        const input = screen.getByLabelText("Pull request URL to claim")
        const submit = screen.getByRole("button", { name: "Claim PR" })
        expect(submit).toBeDisabled()
        fireEvent.submit(submit.closest("form")) // empty: ignored
        expect(onClaim).toHaveBeenCalledTimes(1)
        fireEvent.change(input, { target: { value: " https://x/pull/9 " } })
        await waitFor(() => expect(submit).not.toBeDisabled())
        fireEvent.click(submit)
        await waitFor(() =>
            expect(onClaim).toHaveBeenLastCalledWith("https://x/pull/9")
        )
        // rejected: the URL stays for another try
        await waitFor(() => expect(submit).not.toBeDisabled())
        expect(input).toHaveValue("https://x/pull/9")
        fireEvent.click(submit)
        await waitFor(() => expect(input).toHaveValue(""))
    })

    it("renders with nothing at all", () => {
        render(<DeliverablesPanel />)
        expect(screen.getByText("No work repos yet.")).toBeInTheDocument()
    })
})

describe("FeedbackPanel", () => {
    const items = [
        {
            id: "gh-rc-1",
            pr: PR,
            round: 1,
            kind: "review_comment",
            author: "ron",
            url: "https://gh/c1",
            path: "src/upload.js",
            line: 42,
            summary: "retry should back off",
            status: "fixed",
            commit: "a1b2c3d4e5",
            reply_url: "https://gh/r1",
            note: "exponential backoff",
            verified: true,
            at: "2026-11-07T08:00:00Z",
        },
        {
            id: "ci-test-abc",
            pr: PR,
            round: 2,
            kind: "ci_failure",
            author: null,
            url: "https://gh/check",
            status: "answered",
            verified: false,
            verify_failures: 1,
            at: "2026-11-07T09:00:00Z",
        },
        {
            id: "gh-ic-3",
            pr: "https://x",
            round: 2,
            kind: "issue_comment",
            author: "bot[bot]",
            url: "https://gh/c3",
            path: "a.js",
            status: "no_action",
            at: "2026-11-07T09:01:00Z",
        },
        {
            id: "gh-rv-4",
            pr: PR,
            round: 2,
            kind: "other_kind",
            url: "https://gh/c4",
            status: "open",
            at: "2026-11-07T09:02:00Z",
        },
    ]

    it("groups items by round with details and reopens no_action", async () => {
        const onReopen = jest
            .fn()
            .mockRejectedValueOnce(new Error("x"))
            .mockResolvedValueOnce()
        render(<FeedbackPanel feedback={items} onReopen={onReopen} />)
        const rounds = screen.getAllByRole("region")
        expect(rounds.map((r) => r.getAttribute("aria-label"))).toEqual([
            "Round 2",
            "Round 1",
        ])
        expect(
            within(rounds[0]).getByText(
                "3 items · 1 open, 1 answered, 1 no action"
            )
        ).toBeInTheDocument()
        const r1 = within(rounds[1])
        expect(r1.getByText("src/upload.js:42")).toBeInTheDocument()
        expect(r1.getByText("@ron")).toBeInTheDocument()
        expect(r1.getByText("✓ verified")).toBeInTheDocument()
        expect(r1.getByText("a1b2c3d")).toBeInTheDocument()
        expect(r1.getByRole("link", { name: "reply ↗" })).toHaveAttribute(
            "href",
            "https://gh/r1"
        )
        expect(r1.getByText("exponential backoff")).toBeInTheDocument()
        const r2 = within(rounds[0])
        expect(r2.getByText("unverified")).toBeInTheDocument()
        expect(r2.getByText("verify failed ×1")).toBeInTheDocument()
        expect(r2.getByRole("link", { name: "check ↗" })).toBeInTheDocument()
        expect(r2.getByText("a.js")).toBeInTheDocument()
        expect(r2.getByText("other_kind")).toBeInTheDocument()
        const reopen = r2.getByRole("button", {
            name: "Reopen feedback gh-ic-3",
        })
        fireEvent.click(reopen)
        await waitFor(() => expect(onReopen).toHaveBeenCalledTimes(1))
        await waitFor(() => expect(reopen).not.toBeDisabled())
        fireEvent.click(reopen)
        await waitFor(() => expect(onReopen).toHaveBeenCalledTimes(2))
        expect(onReopen.mock.calls[0][0].id).toBe("gh-ic-3")
    })

    it("says when all feedback is addressed, or how much is open", () => {
        const done = [
            { ...items[0], actionable: true },
            { ...items[2], actionable: false },
        ]
        const { rerender } = render(
            <FeedbackPanel feedback={done} onReopen={jest.fn()} />
        )
        expect(screen.getByRole("status")).toHaveTextContent(
            "✓ All feedback addressed (1 item)"
        )
        expect(screen.getByRole("status")).toHaveClass("fb-state-addressed")
        rerender(
            <FeedbackPanel
                feedback={[...done, { ...items[3], actionable: true }]}
                onReopen={jest.fn()}
            />
        )
        expect(screen.getByRole("status")).toHaveTextContent(
            "1 of 2 feedback items open"
        )
    })

    it("shows an empty state", () => {
        render(<FeedbackPanel feedback={[]} onReopen={jest.fn()} />)
        expect(screen.getByText("No PR feedback yet.")).toBeInTheDocument()
    })
})

describe("ReviewsPanel", () => {
    it("lists the latest review per folder with a dashboard link", () => {
        render(
            <ReviewsPanel
                reviews={[
                    {
                        folder: "aws-lambda--t12-fix--k7q2",
                        branch: "t12-fix",
                        status: "GOOD_TO_GO",
                        timestamp: "2026-11-07T09:00:00Z",
                        dashboardUrl: "http://127.0.0.1:7777/",
                    },
                    null,
                    {
                        repo: "web",
                        status: "ISSUES",
                        dashboard_url: "http://d/",
                    },
                    { file: "f.json" },
                ]}
            />
        )
        const items = screen.getAllByRole("listitem")
        expect(items).toHaveLength(3)
        expect(items[0]).toHaveClass("rv-good_to_go")
        expect(
            screen.getByRole("link", {
                name: "Open the review dashboard for aws-lambda--t12-fix--k7q2",
            })
        ).toHaveAttribute("href", "http://127.0.0.1:7777/")
        expect(
            screen.getByRole("link", {
                name: "Open the review dashboard for web",
            })
        ).toHaveAttribute("href", "http://d/")
        expect(items[2]).toHaveClass("rv-unknown")
        expect(within(items[2]).getByText("review")).toBeInTheDocument()
    })

    it("shows an empty state", () => {
        render(<ReviewsPanel reviews={null} />)
        expect(screen.getByText("No reviews yet.")).toBeInTheDocument()
    })
})

describe("DeliverablesSummary", () => {
    it("says nothing blocks Done without deliverables or when all are done", () => {
        const { rerender } = render(<DeliverablesSummary deliverables={[]} />)
        expect(screen.getByRole("status")).toHaveTextContent(
            "No deliverables: nothing blocks Done."
        )
        rerender(
            <DeliverablesSummary
                deliverables={[
                    { repo: "a", disposition: "no_change" },
                    {
                        repo: "b",
                        disposition: "pr",
                        pr: "p",
                        merged_at: "2026-11-08T00:00:00Z",
                    },
                ]}
            />
        )
        expect(screen.getByRole("status")).toHaveTextContent(
            "All 2 done (merged or no change): nothing blocks Done."
        )
    })

    it("lists each blocking deliverable with its reason", () => {
        render(
            <DeliverablesSummary
                deliverables={[
                    { repo: "a", disposition: "no_change" },
                    { repo: "b", disposition: "pending" },
                    {
                        repo: "c",
                        disposition: "pr",
                        pr: "https://github.com/o/c/pull/3",
                    },
                ]}
                prs={[
                    { repo: "c", number: 3, closed_at: "2026-11-08T00:00:00Z" },
                ]}
            />
        )
        const box = screen.getByRole("status")
        expect(box).toHaveTextContent("2 of 3 block Done")
        expect(box).toHaveTextContent(/b: no PR yet/)
        expect(box).toHaveTextContent(/c: PR closed without merge/)
        expect(box).not.toHaveTextContent(/a:/)
    })

    it("each row says done or blocks Done", () => {
        render(
            <DeliverablesPanel
                deliverables={[
                    { repo: "a", branch: "t1", disposition: "no_change" },
                    { repo: "b", branch: "t1", disposition: "pending" },
                ]}
                prs={[]}
                candidates={[]}
                onNoChange={jest.fn()}
                onClaim={jest.fn()}
            />
        )
        const rows = document.querySelectorAll(".dlv")
        expect(rows[0]).toHaveClass("is-done")
        expect(rows[0]).toHaveTextContent("done")
        expect(rows[1]).toHaveClass("is-blocking")
        expect(rows[1]).toHaveTextContent("blocks Done")
    })
})
