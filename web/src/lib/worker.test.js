/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { ApiError } from "./api.js"
import {
    changeRecordBlocker,
    clearsWhenSeen,
    TABS,
    actionToast,
    blockingDeliverables,
    deliverableState,
    watchFor,
    visibleTabs,
    pollError,
    workerError,
    canCreatePr,
} from "./worker.js"

const ALL = { workers: true, github: true }
const ids = (tabs) => tabs.map((t) => t.id)

describe("visibleTabs", () => {
    it("shows only the core tabs for a plain task", () => {
        // Deliverables always shows with GitHub (it says what blocks Done)
        expect(ids(visibleTabs({ task: {} }, ALL))).toEqual([
            "links",
            "deliverables",
            "comments",
            "activity",
            "schedules",
        ])
        expect(ids(visibleTabs({}))).toHaveLength(4)
    })

    it("shows worker tabs when the task has data for them", () => {
        const data = {
            task: { slug: "k7q2", deliverables: [{ repo: "a" }] },
            comments: [{ id: "c", intent: "chat", author: "me" }],
            feedback: [{ id: "f" }],
            reviews: [{ folder: "x" }],
            files: [],
        }
        expect(ids(visibleTabs(data, ALL))).toEqual(TABS.map((t) => t.id))
        expect(ids(visibleTabs({ task: {}, outbox: [{}] }, ALL))).toContain(
            "agent"
        )
        expect(
            ids(visibleTabs({ task: {}, pr_candidates: [{}] }, ALL))
        ).toContain("deliverables")
        expect(ids(visibleTabs({ task: {}, prs: [{}] }, ALL))).toContain(
            "deliverables"
        )
    })

    it("hides them when the server lacks the feature", () => {
        const data = {
            task: { worker_kind: "codex", deliverables: [{ repo: "a" }] },
            agent: { state: "idle" },
            feedback: [{ id: "f" }],
            reviews: [{ folder: "x" }],
        }
        expect(ids(visibleTabs(data, {}))).toHaveLength(4)
        expect(ids(visibleTabs(data, { workers: true }))).toEqual([
            "links",
            "comments",
            "agent",
            "activity",
            "schedules",
        ])
        expect(ids(visibleTabs(data, { github: true }))).toEqual([
            "links",
            "deliverables",
            "comments",
            "reviews",
            "feedback",
            "activity",
            "schedules",
        ])
    })
})

describe("actionToast", () => {
    it("close-agent with clean says the close follows the clean-up", () => {
        expect(
            actionToast("close-agent", {
                close_after: "clean:12",
                delivery: { status: "sent" },
            })
        ).toMatchObject({
            kind: "success",
            text: expect.stringContaining("closes when it is done"),
        })
        expect(
            actionToast("close-agent", {
                close_after: null,
                delivery: { status: "failed", error: "x" },
            }).kind
        ).toBe("error")
        expect(actionToast("close-agent", { closed: true }).text).toBe(
            "Closed the agent's herdr workspace"
        )
    })

    it("is a success for sent or missing deliveries", () => {
        expect(actionToast("create-pr", { ok: true })).toEqual({
            kind: "success",
            text: "Asked the agent to open the PR",
        })
        expect(
            actionToast("send", { ok: true, delivery: { status: "sent" } })
        ).toEqual({ kind: "success", text: "Sent to the agent" })
        expect(actionToast("mystery", null)).toEqual({
            kind: "success",
            text: "Done",
        })
    })

    it("is info for queued and blocked", () => {
        expect(actionToast("send", { delivery: { status: "queued" } })).toEqual(
            { kind: "info", text: "Queued until the agent is idle" }
        )
        expect(
            actionToast("send", { delivery: { status: "blocked" } })
        ).toEqual({
            kind: "info",
            text: "Agent is blocked — not sent; check it in herdr",
        })
    })

    it("is an error with the delivery error for failed and uncertain", () => {
        expect(
            actionToast("send", {
                delivery: { status: "failed", error: "agent_not_found" },
            })
        ).toEqual({
            kind: "error",
            text: "Not delivered to the agent: agent_not_found",
        })
        expect(
            actionToast("send", { delivery: { status: "failed" } }).text
        ).toBe("Not delivered to the agent")
        const u = actionToast("address-feedback", {
            delivery: { status: "uncertain", error: "timeout" },
        })
        expect(u.kind).toBe("error")
        expect(u.text).toMatch(/uncertain.*: timeout$/)
        expect(
            actionToast("send", { delivery: { status: "uncertain" } }).text
        ).toMatch(/uncertain \(check it in herdr\)$/)
    })
})

describe("pollError", () => {
    it("is null for a clean summary or none", () => {
        expect(pollError(null)).toBeNull()
        expect(pollError({ claimed: 0, errors: [] })).toBeNull()
        expect(pollError({ skipped: "status done" })).toBeNull()
    })
    it("reports the task error or the per-PR errors", () => {
        expect(pollError({ error: "gh: not logged in" })).toBe(
            "PR check failed: gh: not logged in"
        )
        expect(pollError({ errors: ["u1: timeout", "u2: 502"] })).toBe(
            "PR check failed: u1: timeout; u2: 502"
        )
    })
})

describe("workerError", () => {
    it("adds the suggested branch of a branch conflict", () => {
        const err = new ApiError({
            status: 409,
            code: "branch_conflict",
            message: "Branch taken.",
            details: { suggestion: "t5-fix-2" },
        })
        expect(workerError(err)).toBe(
            "Branch taken. Suggested branch: t5-fix-2"
        )
        expect(workerError(new Error("boom"))).toBe("boom")
    })
})

describe("canCreatePr", () => {
    const d = (disposition) => ({ repo: "r", disposition })
    it("ready_for_pr, or a PR state with a repo still without a PR", () => {
        expect(canCreatePr({ status: "ready_for_pr" })).toBe(true)
        expect(
            canCreatePr({
                status: "pr_open",
                deliverables: [d("pr"), d("pending")],
            })
        ).toBe(true)
        expect(
            canCreatePr({ status: "pr_feedback", deliverables: [d("pending")] })
        ).toBe(true)
        expect(
            canCreatePr({
                status: "pr_open",
                deliverables: [d("pr"), d("no_change")],
            })
        ).toBe(false)
        expect(canCreatePr({ status: "pr_open" })).toBe(false)
        expect(
            canCreatePr({ status: "active", deliverables: [d("pending")] })
        ).toBe(false)
        expect(canCreatePr(null)).toBe(false)
    })
})

describe("deliverable state (what blocks Done)", () => {
    const PR = "https://github.com/o/aws-batch/pull/12"
    const d = (disposition, over = {}) => ({
        repo: "aws-batch",
        disposition,
        ...over,
    })

    it("no change and merged are done; the rest block with a reason", () => {
        expect(deliverableState(d("no_change"))).toEqual({
            done: true,
            label: "no change",
        })
        expect(
            deliverableState(
                d("pr", { pr: PR, merged_at: "2026-11-08T00:00:00Z" })
            )
        ).toEqual({ done: true, label: "merged" })
        expect(deliverableState(d("pr", { pr: PR }))).toMatchObject({
            done: false,
            label: "PR open",
            reason: "PR not merged yet",
        })
        expect(
            deliverableState(d("pr", { pr: PR }), {
                closed_at: "2026-11-08T00:00:00Z",
            })
        ).toMatchObject({ done: false, label: "PR closed" })
        expect(deliverableState(d("pending"))).toMatchObject({
            done: false,
            label: "no PR yet",
            reason: expect.stringMatching(/mark No change/),
        })
    })

    it("watchFor matches by url or repo + number", () => {
        const rows = [
            {
                url: "https://github.com/o/other/pull/1",
                repo: "other",
                number: 1,
            },
            { url: "x", repo: "aws-batch", number: 12 },
        ]
        expect(watchFor(rows, d("pr", { pr: PR }))).toBe(rows[1])
        expect(watchFor(rows, d("pending"))).toBeNull()
        expect(watchFor(null, d("pr", { pr: PR }))).toBeNull()
        expect(watchFor(rows, null)).toBeNull()
        expect(watchFor(rows, d("pr", { pr: "https://nope" }))).toBeNull()
    })

    it("blockingDeliverables lists what keeps the task from Done", () => {
        const task = {
            deliverables: [
                d("no_change", { repo: "a" }),
                d("pending", { repo: "b" }),
                d("pr", { repo: "aws-batch", pr: PR }),
            ],
        }
        expect(blockingDeliverables(task, []).map((x) => x.repo)).toEqual([
            "b",
            "aws-batch",
        ])
        expect(blockingDeliverables(null, [])).toEqual([])
    })
})

describe("clearsWhenSeen", () => {
    it("a reminder or snooze end that nothing replaced", () => {
        expect(clearsWhenSeen(null)).toBe(false)
        expect(
            clearsWhenSeen({ now: false, now_reason: "x", now_seen: "x" })
        ).toBe(false)
        expect(clearsWhenSeen({ now: true, now_reason: "" })).toBe(false)
        expect(
            clearsWhenSeen({ now: true, now_reason: "x", now_seen: "x" })
        ).toBe(true)
        expect(
            clearsWhenSeen({
                now: true,
                now_reason: "Ready for PR",
                now_seen: "x",
            })
        ).toBe(false)
        expect(clearsWhenSeen({ now: true, now_reason: "Snooze ended" })).toBe(
            true
        )
    })
})

describe("changeRecordBlocker", () => {
    it("is null without a record or gaps, else names the labels", () => {
        expect(changeRecordBlocker(null)).toBeNull()
        expect(
            changeRecordBlocker({ section: "S", present: true, missing: [] })
        ).toBeNull()
        expect(
            changeRecordBlocker({
                section: "S",
                present: true,
                missing: ["what", "odd"],
            })
        ).toBe('fill What, odd in "S"')
        expect(
            changeRecordBlocker({
                section: "S",
                present: false,
                missing: ["why"],
            })
        ).toBe('add a "S" section to the artifact and fill Why')
    })
})
