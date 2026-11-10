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
import TaskHeader, { taskPrs, workerActions } from "./TaskHeader.jsx"
import { sampleTask } from "../../test/helpers.js"
import { ALL_FEATURES } from "../../test/render.jsx"

const live = { state: "idle", name: "t12-fix", kind: "claude" }

// Lists never answer here (RepoPicker / StartAgent have their own tests).
const quietApi = {
    listRepos: () => new Promise(() => {}),
    getSettings: () => new Promise(() => {}),
}

function on(task, agent, features = ALL_FEATURES) {
    const can = workerActions(task, agent, features)
    return Object.keys(can).filter((k) => can[k])
}

describe("workerActions", () => {
    it("offers Start for inbox/ready and active without a live agent", () => {
        expect(on(sampleTask({ status: "inbox" }))).toEqual(["start"])
        expect(on(sampleTask({ status: "ready" }))).toEqual(["start"])
        expect(on(sampleTask({ status: "active" }), { state: "gone" })).toEqual(
            ["start"]
        )
        expect(on(sampleTask({ status: "active" }), live)).toEqual([
            "focus",
            "closeAgent",
        ])
    })

    it("offers the PR flow actions by status", () => {
        expect(on(sampleTask({ status: "ready_for_pr" }))).toEqual([
            "createPr",
            "checkPrs",
        ])
        expect(on(sampleTask({ status: "pr_feedback" }), live)).toEqual([
            "addressFeedback",
            "focus",
            "checkPrs",
            "closeAgent",
        ])
        expect(on(sampleTask({ status: "pr_open" }))).toEqual(["checkPrs"])
        expect(on(sampleTask({ status: "review" }))).toEqual(["accept"])
        // an open claimed PR outside the PR statuses: still checkable
        const pr = { disposition: "pr", pr: "https://github.com/o/r/pull/1" }
        expect(
            workerActions(sampleTask({ deliverables: [pr] }), null, {
                github: true,
            }).checkPrs
        ).toBe(true)
        expect(
            workerActions(
                sampleTask({
                    deliverables: [
                        { ...pr, merged_at: "2026-11-08T00:00:00Z" },
                    ],
                }),
                null,
                { github: true }
            ).checkPrs
        ).toBe(false)
        expect(
            workerActions(
                sampleTask({ status: "done", deliverables: [pr] }),
                null,
                { github: true }
            ).checkPrs
        ).toBe(false)
    })

    it("offers Relaunch on Codex and Clean folders", () => {
        expect(
            on(
                sampleTask({
                    status: "waiting",
                    flags: { error: "Claude unavailable: usage limit" },
                })
            )
        ).toEqual(["relaunchCodex"])
        // a closed task never relaunches an agent
        for (const status of ["done", "cancelled"])
            expect(
                on(
                    sampleTask({
                        status,
                        flags: { error: "Claude unavailable: usage limit" },
                    })
                )
            ).toEqual([])
        expect(on(sampleTask({ status: "done", slug: "k7q2" }))).toEqual([
            "clean",
        ])
        expect(
            on(sampleTask({ status: "done", deliverables: [{ repo: "a" }] }))
        ).toEqual(["clean"])
        expect(on(sampleTask({ status: "done" }))).toEqual([])
        expect(on(sampleTask({ status: "waiting", flags: null }))).toEqual([])
    })

    it("hides everything but Accept without the server features", () => {
        expect(on(sampleTask({ status: "ready" }), null, {})).toEqual([])
        expect(on(sampleTask({ status: "pr_feedback" }), live, {})).toEqual([])
        expect(
            on(sampleTask({ status: "pr_open" }), null, { workers: true })
        ).toEqual([])
        expect(
            on(sampleTask({ status: "pr_feedback" }), live, { github: true })
        ).toEqual(["checkPrs"])
        expect(on(sampleTask({ status: "review" }))).toEqual(["accept"])
        expect(workerActions(sampleTask({ status: "ready" })).start).toBe(false)
    })
})

function renderHeader(task, props = {}) {
    const handlers = {
        onPatch: jest.fn(async () => {}),
        onAction: jest.fn(async () => {}),
        onStart: jest.fn(async () => {}),
        onPollPrs: jest.fn(async () => {}),
        onSnooze: jest.fn(),
        onAsana: jest.fn(),
        onEnrich: jest.fn(),
        onCloseOut: jest.fn(),
        onHistory: jest.fn(),
    }
    render(
        <TaskHeader
            task={task}
            isOwner
            features={ALL_FEATURES}
            api={quietApi}
            {...handlers}
            {...props}
        />
    )
    return handlers
}

describe("TaskHeader worker actions", () => {
    beforeEach(() => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ settings: {} }),
        }))
    })

    it("Create PR, Open in herdr and Check PRs now call their handlers", async () => {
        const h = renderHeader(sampleTask({ status: "ready_for_pr" }), {
            agent: live,
        })
        expect(screen.getByLabelText("Agent t12-fix: idle")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Create PR" }))
        await waitFor(() =>
            expect(h.onAction).toHaveBeenCalledWith("create-pr")
        )
        fireEvent.click(screen.getByRole("button", { name: "Open in herdr" }))
        await waitFor(() => expect(h.onAction).toHaveBeenCalledWith("focus"))
        fireEvent.click(screen.getByRole("button", { name: "Check PRs now" }))
        await waitFor(() => expect(h.onPollPrs).toHaveBeenCalled())
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Check PRs now" })
            ).not.toBeDisabled()
        )
    })

    it("Address feedback, Relaunch on Codex", async () => {
        const h = renderHeader(
            sampleTask({
                status: "pr_feedback",
                flags: { error: "Claude unavailable: usage limit" },
            })
        )
        fireEvent.click(
            screen.getByRole("button", { name: "Address feedback" })
        )
        await waitFor(() =>
            expect(h.onAction).toHaveBeenCalledWith("address-feedback")
        )
        fireEvent.click(
            screen.getByRole("button", { name: "Relaunch on Codex" })
        )
        await waitFor(() =>
            expect(h.onAction).toHaveBeenCalledWith("relaunch-codex")
        )
    })

    it("Accept replaces Done for review tasks", async () => {
        const h = renderHeader(sampleTask({ status: "review" }))
        expect(screen.queryByRole("button", { name: "✓ Done" })).toBeNull()
        fireEvent.click(
            screen.getByRole("button", { name: "Accept and mark done" })
        )
        await waitFor(() =>
            expect(h.onPatch).toHaveBeenCalledWith({ status: "done" })
        )
    })

    it("Clean folders asks in a dialog first", async () => {
        const h = renderHeader(sampleTask({ status: "done", slug: "k7q2" }))
        fireEvent.click(screen.getByRole("button", { name: "Clean folders" }))
        expect(h.onAction).not.toHaveBeenCalled()
        const dlg = screen.getByRole("alertdialog", {
            name: "Clean the task's folders?",
        })
        expect(dlg).toHaveTextContent("…--k7q2")
        expect(dlg).toHaveTextContent("Branches and PRs on GitHub stay.")
        // the dialog lives outside the header (no page scroll on focus)
        expect(dlg.closest("header")).toBeNull()
        fireEvent.click(
            within(dlg).getByRole("button", { name: "Clean folders" })
        )
        await waitFor(() => expect(h.onAction).toHaveBeenCalledWith("clean"))
        await waitFor(() =>
            expect(screen.queryByRole("alertdialog")).toBeNull()
        )
    })

    it("Close out explains Asana when the task has it", () => {
        renderHeader(
            sampleTask({
                asana: { gid: "1", url: "https://app.asana.com/0/1/1" },
            })
        )
        fireEvent.click(screen.getByRole("button", { name: "Close out" }))
        expect(screen.getByRole("alertdialog")).toHaveTextContent(
            "comments on and completes the Asana task"
        )
    })

    it("Start launches the chosen kind", async () => {
        const h = renderHeader(
            sampleTask({
                status: "ready",
                repos: [{ name: "aws-lambda", role: "main" }],
            })
        )
        fireEvent.change(screen.getByLabelText("Agent kind"), {
            target: { value: "codex" },
        })
        fireEvent.click(
            screen.getByRole("button", { name: "Start with Codex" })
        )
        await waitFor(() =>
            expect(h.onStart).toHaveBeenCalledWith("codex", null)
        )
    })

    it("shows no worker controls without features", () => {
        renderHeader(sampleTask({ status: "ready_for_pr" }), {
            features: {},
            agent: live,
        })
        expect(screen.queryByRole("button", { name: "Create PR" })).toBeNull()
        expect(
            screen.queryByRole("button", { name: "Check PRs now" })
        ).toBeNull()
        expect(
            screen.queryByRole("button", { name: "Open in herdr" })
        ).toBeNull()
        expect(screen.queryByLabelText(/^Agent t12-fix/)).toBeNull()
        expect(screen.queryByLabelText("Agent kind")).toBeNull()
    })
})

describe("TaskHeader repos", () => {
    it("shows the assigned repos read-only to viewers", () => {
        render(
            <TaskHeader
                task={sampleTask({
                    repos: [
                        { name: "aws-batch", role: "main" },
                        { name: "web-trace", role: "ref" },
                    ],
                })}
                isOwner={false}
                api={quietApi}
            />
        )
        expect(screen.getByText("repos")).toBeInTheDocument()
        expect(screen.getByText("aws-batch")).toBeInTheDocument()
        expect(screen.getByText("web-trace")).toBeInTheDocument()
        expect(screen.queryByLabelText("Add repo")).toBeNull()
    })

    it("owner edits go through onPatch({ repos })", async () => {
        const api = {
            listRepos: jest.fn(async () => ({
                repos: [{ name: "aws-batch" }],
            })),
            getSettings: () => new Promise(() => {}),
        }
        const h = renderHeader(sampleTask({ repos: [] }), { api })
        const add = screen.getByLabelText("Add repo")
        await waitFor(() => expect(add).not.toBeDisabled())
        fireEvent.change(add, { target: { value: "aws-batch" } })
        await waitFor(() =>
            expect(h.onPatch).toHaveBeenCalledWith({
                repos: [{ name: "aws-batch", role: "main" }],
            })
        )
    })
})

describe("TaskHeader PR links", () => {
    const PR = "https://github.com/acme/aws-batch/pull/1197"
    const PR2 = "https://github.com/acme/web-trace/pull/7"

    it("taskPrs: deliverable PRs (merged state) + pr links, one per URL", () => {
        expect(
            taskPrs({
                deliverables: [
                    {
                        repo: "aws-batch",
                        pr: PR,
                        merged_at: "2026-11-08T19:00:00Z",
                    },
                    { repo: "x", pr: null },
                ],
                links: [
                    { type: "pr", url: PR },
                    { type: "pr", url: PR2 },
                    { type: "pr", url: "https://example.com/not-a-pr" },
                    { type: "slack", url: "https://s" },
                    null,
                ],
            })
        ).toEqual([
            { url: PR, label: "aws-batch#1197", merged: true },
            { url: PR2, label: "web-trace#7", merged: false },
        ])
        expect(taskPrs(null)).toEqual([])
        expect(taskPrs({})).toEqual([])
    })

    it("shows PR links next to the branch (merged marked ✓)", () => {
        renderHeader(
            sampleTask({
                branch: "t1-fix",
                deliverables: [
                    {
                        repo: "aws-batch",
                        branch: "t1-fix",
                        pr: PR,
                        disposition: "pr",
                        merged_at: "2026-11-08T19:00:00Z",
                    },
                ],
                links: [{ id: "l1", type: "pr", url: PR2 }],
            })
        )
        const merged = screen.getByRole("link", { name: "aws-batch#1197 ✓" })
        expect(merged).toHaveAttribute("href", PR)
        expect(merged).toHaveClass("is-merged")
        expect(
            screen.getByRole("link", { name: "web-trace#7 ↗" })
        ).toHaveAttribute("href", PR2)
        expect(merged.closest(".fact-branch")).toHaveTextContent("t1-fix")
    })

    it("PRs show without a branch; nothing without either", () => {
        const { unmount } = render(
            <TaskHeader
                task={sampleTask({
                    branch: null,
                    links: [{ type: "pr", url: PR }],
                })}
                isOwner={false}
                api={quietApi}
            />
        )
        expect(
            screen.getByRole("link", { name: "aws-batch#1197 ↗" })
        ).toBeTruthy()
        unmount()
        render(
            <TaskHeader
                task={sampleTask({ branch: null })}
                isOwner={false}
                api={quietApi}
            />
        )
        expect(screen.queryByText("branch")).toBeNull()
    })
})

describe("TaskHeader Close agent", () => {
    it("is disabled while the agent works, with the reason", () => {
        renderHeader(sampleTask({ status: "active" }), {
            agent: { state: "working", name: "t12-fix" },
        })
        const btn = screen.getByRole("button", { name: "Close agent" })
        expect(btn).toBeDisabled()
        expect(btn).toHaveAttribute(
            "title",
            "The agent is working; it can be closed when idle"
        )
    })

    it("asks for confirmation, then runs close-agent", async () => {
        const h = renderHeader(sampleTask({ status: "active" }), {
            agent: { state: "idle", name: "t12-fix" },
        })
        fireEvent.click(screen.getByRole("button", { name: "Close agent" }))
        const dlg = screen.getByRole("alertdialog", {
            name: "Close the agent?",
        })
        expect(dlg).toHaveTextContent("t12-fix")
        // cancel: nothing happens
        fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1])
        expect(screen.queryByRole("alertdialog")).toBeNull()
        expect(h.onAction).not.toHaveBeenCalled()
        // confirm
        fireEvent.click(screen.getByRole("button", { name: "Close agent" }))
        fireEvent.click(screen.getByRole("button", { name: "Close workspace" }))
        await waitFor(() =>
            expect(h.onAction).toHaveBeenCalledWith("close-agent")
        )
        await waitFor(() =>
            expect(screen.queryByRole("alertdialog")).toBeNull()
        )
    })

    it("closes the dialog even when the action fails", async () => {
        const h = renderHeader(sampleTask({ status: "active" }), {
            agent: { state: "done" },
        })
        h.onAction.mockRejectedValueOnce(new Error("busy"))
        fireEvent.click(screen.getByRole("button", { name: "Close agent" }))
        expect(screen.getByRole("alertdialog")).toHaveTextContent("the agent")
        fireEvent.click(screen.getByRole("button", { name: "Close workspace" }))
        await waitFor(() =>
            expect(screen.queryByRole("alertdialog")).toBeNull()
        )
    })

    it("is not shown without a live agent", () => {
        renderHeader(sampleTask({ status: "active" }), {
            agent: { state: "gone" },
        })
        expect(screen.queryByRole("button", { name: "Close agent" })).toBeNull()
    })
})
