/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */
import {
    canTransition,
    assertTransition,
    TransitionError,
    laneOf,
    isShared,
    viewerTask,
    LANES,
    snoozePatch,
    withSnoozeFlags,
    openDeliverables,
    canCreatePr,
} from "./lifecycle.js"

const base = {
    id: 7,
    title: "t",
    kind: "todo",
    area: "infra",
    status: "inbox",
    visibility: "auto",
    asana: { gid: null, url: null },
    flags: { now: false },
    repos: [{ name: "infrastructure", role: "main" }],
    branch: "t7-x",
    links: [
        { type: "pr", url: "https://gh/pr/1", label: "PR" },
        { type: "folder", url: "/tmp/x", label: "f" },
        { type: "slack", url: "https://slack", label: "s" },
    ],
    source: { type: "slack", url: "u", text: "secret" },
    created_at: "a",
    updated_at: "b",
    done_at: null,
}

describe("transitions", () => {
    test("same status is always allowed", () => {
        expect(canTransition("done", "done")).toBe(true)
    })
    test("known allowed and forbidden moves", () => {
        expect(canTransition("inbox", "ready")).toBe(true)
        expect(canTransition("ready_for_pr", "pr_open")).toBe(true)
        expect(canTransition("inbox", "pr_open")).toBe(false)
        expect(canTransition("done", "inbox")).toBe(false)
        expect(canTransition("cancelled", "ready")).toBe(true)
        expect(canTransition("waiting", "active")).toBe(true)
        // review with a claimed PR: back and forth with the PR statuses
        expect(canTransition("review", "pr_feedback")).toBe(true)
        expect(canTransition("pr_open", "review")).toBe(true)
        expect(canTransition("pr_feedback", "review")).toBe(true)
        expect(canTransition("nope", "ready")).toBe(false)
    })
    test("assertTransition throws typed error", () => {
        expect(() => assertTransition("inbox", "ready")).not.toThrow()
        try {
            assertTransition("done", "pr_feedback")
            throw new Error("unreachable")
        } catch (e) {
            expect(e).toBeInstanceOf(TransitionError)
            expect(e.code).toBe("illegal_transition")
            expect(e.from).toBe("done")
            expect(e.to).toBe("pr_feedback")
        }
    })
})

describe("laneOf", () => {
    test.each([
        ["active", "active"],
        ["ready_for_pr", "prs"],
        ["pr_open", "prs"],
        ["pr_feedback", "prs"],
        ["review", "prs"],
        ["ready", "ready"],
        ["inbox", "inbox"],
        ["waiting", "waiting"],
        ["done", "done"],
        ["cancelled", "done"],
    ])("%s -> %s", (status, lane) => {
        expect(laneOf({ ...base, status })).toBe(lane)
        expect(LANES).toContain(lane)
    })
    test("now flag wins for open tasks only", () => {
        expect(laneOf({ ...base, flags: { now: true } })).toBe("now")
        expect(laneOf({ ...base, status: "done", flags: { now: true } })).toBe(
            "done"
        )
        expect(laneOf({ ...base, flags: undefined })).toBe("inbox")
    })
})

describe("visibility", () => {
    test("auto follows asana gid", () => {
        expect(isShared(base)).toBe(false)
        expect(isShared({ ...base, asana: { gid: "1" } })).toBe(true)
        expect(isShared({ ...base, asana: undefined })).toBe(false)
    })
    test("explicit overrides", () => {
        expect(isShared({ ...base, visibility: "shared" })).toBe(true)
        expect(
            isShared({ ...base, visibility: "private", asana: { gid: "1" } })
        ).toBe(false)
    })
    test("viewerTask whitelists fields", () => {
        const v = viewerTask({ ...base, asana: { gid: "1", url: "https://a" } })
        expect(v.source).toBeUndefined()
        expect(v.flags).toBeUndefined()
        expect(v.asana).toEqual({ url: "https://a" })
        expect(v.links.map((l) => l.type)).toEqual(["pr"])
        expect(
            viewerTask({ ...base, asana: undefined, links: undefined })
        ).toMatchObject({ asana: { url: null }, links: [] })
    })
})

describe("snooze helpers", () => {
    test("snoozePatch waits and clears the Now flag", () => {
        const p = snoozePatch("2026-11-10T09:00:00.000Z")
        expect(p).toEqual({
            status: "waiting",
            snooze_until: "2026-11-10T09:00:00.000Z",
            flags: { now: false, now_reason: null },
        })
        expect(
            laneOf({ ...base, ...p, flags: { ...base.flags, ...p.flags } })
        ).not.toBe("now")
    })
    test("withSnoozeFlags keeps other patch fields and flags", () => {
        const input = { title: "x", flags: { error: "e" } }
        expect(withSnoozeFlags(input)).toEqual({
            title: "x",
            flags: { error: "e", now: false, now_reason: null },
        })
        expect(input.flags).toEqual({ error: "e" })
    })
})

describe("openDeliverables", () => {
    test("only unmerged, non no_change deliverables block done", () => {
        const a = { repo: "a", branch: "b", merged_at: null, disposition: "pr" }
        const m = { ...a, merged_at: "x" }
        const n = { ...a, disposition: "no_change" }
        expect(openDeliverables({ deliverables: [a, m, n] })).toEqual([a])
        expect(openDeliverables({})).toEqual([])
        expect(openDeliverables(null)).toEqual([])
    })
})

describe("canCreatePr", () => {
    const d = (disposition) => ({ repo: "r", disposition })
    test("ready_for_pr, or a PR state with a deliverable still pending", () => {
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
            canCreatePr({ status: "pr_open", deliverables: [d("pr")] })
        ).toBe(false)
        expect(canCreatePr({ status: "pr_open" })).toBe(false)
        expect(
            canCreatePr({ status: "done", deliverables: [d("pending")] })
        ).toBe(false)
        expect(canCreatePr(undefined)).toBe(false)
    })
})
