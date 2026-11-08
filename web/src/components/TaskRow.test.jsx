/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { fireEvent, screen } from "@testing-library/react"
import TaskRow, { rowActions } from "./TaskRow.jsx"
import { sampleTask } from "../../test/helpers.js"
import { ALL_FEATURES, renderWithApp } from "../../test/render.jsx"

const PR = "https://github.com/acme/aws-batch/pull/1197"
const REPO = [{ name: "aws-batch", role: "main" }]
const dlv = (over = {}) => ({
    repo: "aws-batch",
    branch: "t12-fix",
    role: "work",
    disposition: "pending",
    ...over,
})

function renderRow(task, { agent, features = ALL_FEATURES, role } = {}) {
    const handlers = {
        onDone: jest.fn(),
        onSnooze: jest.fn(),
        onStart: jest.fn(),
        onFocus: jest.fn(),
    }
    renderWithApp(
        <ul>
            <TaskRow
                task={task}
                lane="active"
                isOwner={role !== "viewer"}
                agent={agent}
                {...handlers}
            />
        </ul>,
        { features, role: role || "owner" }
    )
    return handlers
}

describe("rowActions", () => {
    const W = { workers: true }
    it("Done only when no deliverable blocks it", () => {
        expect(rowActions(sampleTask(), null, W).done).toBe(true)
        expect(
            rowActions(sampleTask({ deliverables: [dlv()] }), null, W).done
        ).toBe(false)
        expect(
            rowActions(
                sampleTask({
                    deliverables: [dlv({ disposition: "no_change" })],
                }),
                null,
                W
            ).done
        ).toBe(true)
        expect(rowActions(sampleTask({ status: "done" }), null, W).done).toBe(
            false
        )
    })

    it("Start with a repo, no live agent, a startable status and workers", () => {
        const t = sampleTask({ status: "ready", repos: REPO })
        expect(rowActions(t, undefined, W).start).toBe(true)
        expect(rowActions(t, "gone", W).start).toBe(true)
        expect(rowActions(t, "idle", W).start).toBe(false)
        expect(rowActions(t, undefined, {}).start).toBe(false)
        expect(rowActions({ ...t, repos: [] }, undefined, W).start).toBe(false)
        expect(rowActions({ ...t, repos: null }, undefined, W).start).toBe(
            false
        )
        expect(rowActions({ ...t, status: "review" }, undefined, W).start).toBe(
            false
        )
        expect(rowActions(t, undefined).start).toBe(false)
    })
})

describe("TaskRow quick actions", () => {
    it("a repo and no agent: Start and Done; Start calls onStart", () => {
        const task = sampleTask({ status: "ready", repos: REPO })
        const h = renderRow(task)
        fireEvent.click(
            screen.getByRole("button", { name: "Start an agent for T-12" })
        )
        expect(h.onStart).toHaveBeenCalledWith(task)
        fireEvent.click(screen.getByRole("button", { name: "Mark T-12 done" }))
        expect(h.onDone).toHaveBeenCalledWith(task)
    })

    it("pending deliverables hide Done; a closed agent offers Start instead", () => {
        renderRow(
            sampleTask({
                status: "active",
                repos: REPO,
                deliverables: [dlv()],
            }),
            { agent: "gone" }
        )
        expect(screen.queryByRole("button", { name: /done$/ })).toBeNull()
        expect(
            screen.getByRole("button", { name: "Start an agent for T-12" })
        ).toBeTruthy()
    })
})

describe("TaskRow pills", () => {
    it("open PRs, Asana, Slack and a herdr button for the live agent", () => {
        const task = sampleTask({
            source: { type: "slack", url: "https://slack.example/x" },
            asana: { gid: "1", url: "https://app.asana.com/0/1/1" },
            deliverables: [
                dlv({ disposition: "pr", pr: PR }),
                dlv({
                    repo: "web",
                    disposition: "pr",
                    pr: "https://github.com/acme/web/pull/3",
                    merged_at: "2026-11-08T00:00:00Z",
                }),
            ],
        })
        const h = renderRow(task, { agent: "idle" })
        expect(
            screen.getByRole("link", { name: "aws-batch#1197 ↗" })
        ).toHaveAttribute("href", PR)
        // merged PRs are not shown
        expect(screen.queryByRole("link", { name: /web#3/ })).toBeNull()
        expect(screen.getByRole("link", { name: "Asana ↗" })).toHaveAttribute(
            "href",
            "https://app.asana.com/0/1/1"
        )
        expect(screen.getByRole("link", { name: "Slack ↗" })).toHaveAttribute(
            "href",
            "https://slack.example/x"
        )
        // pills are outside the row's main link (no nested links)
        const herdr = screen.getByRole("button", {
            name: /herdr/,
        })
        expect(herdr.closest("a")).toBeNull()
        fireEvent.click(herdr)
        expect(h.onFocus).toHaveBeenCalledWith(task)
    })

    it("no pills without data; no herdr button for viewers or without workers", () => {
        renderRow(sampleTask({ source: { type: "manual", url: null } }), {
            agent: "idle",
            role: "viewer",
        })
        expect(document.querySelector(".pill-link")).toBeNull()
        expect(screen.queryByRole("button", { name: /herdr/ })).toBeNull()
        // the plain agent chip still shows the state
        expect(document.querySelector(".row-main .agent-idle")).not.toBeNull()
    })

    it("without GitHub no PR pills", () => {
        renderRow(
            sampleTask({ deliverables: [dlv({ disposition: "pr", pr: PR })] }),
            {
                features: { workers: true },
            }
        )
        expect(
            screen.queryByRole("link", { name: /aws-batch#1197/ })
        ).toBeNull()
    })
})

describe("TaskRow layout", () => {
    it("one meta line holds the chips and the link pills; the title is the row link", () => {
        renderRow(
            sampleTask({
                area: "batch",
                source: { type: "slack", url: "https://slack.example/x" },
                asana: { gid: "1", url: "https://app.asana.com/0/1/1" },
            }),
            { agent: "idle" }
        )
        const meta = document.querySelector(".row-meta")
        expect(meta.querySelector(".area")).not.toBeNull()
        expect(meta.querySelector(".pill-asana")).not.toBeNull()
        expect(meta.querySelector(".pill-slack")).not.toBeNull()
        expect(meta.querySelector(".pill-herdr")).not.toBeNull()
        expect(meta.querySelector("time")).not.toBeNull()
        // every pill in the line uses the shared chip size
        for (const el of meta.querySelectorAll(".pill-link"))
            expect(el).toHaveClass("chip")
        const link = screen.getByRole("link", { name: "Fix lambda timeout" })
        expect(link).toHaveAttribute("href", "/t/12")
        expect(link).toHaveClass("row-link")
        // no link nested in another link
        expect(document.querySelectorAll("a a")).toHaveLength(0)
    })
})
