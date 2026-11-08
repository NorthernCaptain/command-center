/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { createFakeClock } from "../util/clock.js"
import { ValidationError } from "../util/errors.js"
import { openDb } from "../store/db.js"
import { createOutboxRepo } from "./outboxRepo.js"

let db
let clock
let repo
beforeEach(() => {
    db = openDb(":memory:")
    clock = createFakeClock()
    repo = createOutboxRepo(db, { clock })
})
afterEach(() => db.close())

test("enqueue returns the new pending row", () => {
    const r = repo.enqueue({ task_id: 4, text: "hello", reason: "send" })
    expect(r).toEqual({
        id: expect.any(Number),
        task_id: 4,
        text: "hello",
        reason: "send",
        dedupe_key: null,
        status: "pending",
        error: null,
        created_at: "2026-11-07T12:00:00.000Z",
        sent_at: null,
    })
    expect(repo.get(r.id)).toEqual(r)
    expect(repo.get(999)).toBeNull()
})

test("enqueue validates input", () => {
    expect(() => repo.enqueue({ text: "x", reason: "r" })).toThrow(
        ValidationError
    )
    expect(() => repo.enqueue({ task_id: 1, text: "  ", reason: "r" })).toThrow(
        ValidationError
    )
    expect(() => repo.enqueue({ task_id: 1, text: 5, reason: "r" })).toThrow(
        ValidationError
    )
    expect(() => repo.enqueue({ task_id: 1, text: "x" })).toThrow(
        ValidationError
    )
    expect(() => repo.enqueue()).toThrow(ValidationError)
})

test("dedupe: same (task, key) returns the existing row in any status", () => {
    const a = repo.enqueue({
        task_id: 1,
        text: "round 1",
        reason: "pr_feedback",
        dedupe_key: "round-812-1",
    })
    const again = repo.enqueue({
        task_id: 1,
        text: "round 1 (dup)",
        reason: "pr_feedback",
        dedupe_key: "round-812-1",
    })
    expect(again).toEqual(a)
    // other task, same key -> new row; numeric key coerced
    const b = repo.enqueue({
        task_id: 2,
        text: "x",
        reason: "r",
        dedupe_key: "round-812-1",
    })
    expect(b.id).not.toBe(a.id)
    const n = repo.enqueue({
        task_id: 2,
        text: "y",
        reason: "r",
        dedupe_key: 5,
    })
    expect(n.dedupe_key).toBe("5")
    // already sent -> still the same row, not re-queued
    repo.markSent(a.id)
    const sent = repo.enqueue({
        task_id: 1,
        text: "round 1",
        reason: "pr_feedback",
        dedupe_key: "round-812-1",
    })
    expect(sent).toMatchObject({ id: a.id, status: "sent" })
    // no key -> always new rows
    const c1 = repo.enqueue({ task_id: 1, text: "a", reason: "r" })
    const c2 = repo.enqueue({
        task_id: 1,
        text: "a",
        reason: "r",
        dedupe_key: null,
    })
    expect(c1.id).not.toBe(c2.id)
})

test("pending is FIFO per task or across tasks", () => {
    const a = repo.enqueue({ task_id: 1, text: "a", reason: "r" })
    const b = repo.enqueue({ task_id: 2, text: "b", reason: "r" })
    const c = repo.enqueue({ task_id: 1, text: "c", reason: "r" })
    expect(repo.pending(1).map((r) => r.id)).toEqual([a.id, c.id])
    expect(repo.pending("2").map((r) => r.id)).toEqual([b.id])
    expect(repo.pending().map((r) => r.id)).toEqual([a.id, b.id, c.id])
    expect(repo.pending(null)).toHaveLength(3)
})

test("markSent / markFailed / cancel only act on pending rows", () => {
    const a = repo.enqueue({ task_id: 1, text: "a", reason: "r" })
    const b = repo.enqueue({ task_id: 1, text: "b", reason: "r" })
    const c = repo.enqueue({ task_id: 1, text: "c", reason: "r" })
    clock.set("2026-11-07T12:30:00.000Z")
    expect(repo.markSent(a.id)).toMatchObject({
        status: "sent",
        sent_at: "2026-11-07T12:30:00.000Z",
    })
    expect(repo.markFailed(a.id, "late")).toMatchObject({
        status: "sent",
        error: null,
    })
    expect(repo.markFailed(b.id, new Error("agent_blocked"))).toMatchObject({
        status: "failed",
        error: "agent_blocked",
        sent_at: null,
    })
    expect(repo.markSent(b.id).status).toBe("failed")
    expect(repo.cancel(b.id)).toBe(false)
    expect(repo.cancel(c.id)).toBe(true)
    expect(repo.get(c.id).status).toBe("cancelled")
    expect(repo.pending(1)).toEqual([])
    expect(repo.markSent(999)).toBeNull()
})

test("requeue moves a failed row back to pending", () => {
    const a = repo.enqueue({ task_id: 1, text: "a", reason: "r" })
    repo.markFailed(a.id, "timeout")
    expect(repo.requeue(a.id)).toMatchObject({ status: "pending", error: null })
    expect(repo.pending(1).map((r) => r.id)).toEqual([a.id])
    // pending/sent rows are untouched
    repo.markSent(a.id)
    expect(repo.requeue(a.id).status).toBe("sent")
})

test("failed returns every failed row of a task, beyond list's limit", () => {
    const f = repo.enqueue({ task_id: 1, text: "lost", reason: "r" })
    repo.markFailed(f.id, "pane gone")
    for (let i = 0; i < 50; i++)
        repo.markSent(
            repo.enqueue({ task_id: 1, text: `s${i}`, reason: "r" }).id
        )
    const other = repo.enqueue({ task_id: 2, text: "x", reason: "r" })
    repo.markFailed(other.id, "x")
    expect(repo.list(1).map((r) => r.id)).not.toContain(f.id)
    expect(repo.failed(1).map((r) => [r.id, r.error])).toEqual([
        [f.id, "pane gone"],
    ])
    expect(repo.failed(3)).toEqual([])
    expect(repo.byId(f.id)).toMatchObject({ task_id: 1, status: "failed" })
    expect(repo.byId(99999)).toBeNull()
})

test("list is newest first with a limit", () => {
    const ids = []
    for (let i = 0; i < 5; i++)
        ids.push(repo.enqueue({ task_id: 1, text: `t${i}`, reason: "r" }).id)
    repo.enqueue({ task_id: 2, text: "other", reason: "r" })
    expect(repo.list(1).map((r) => r.id)).toEqual([...ids].reverse())
    expect(repo.list(1, { limit: 2 }).map((r) => r.id)).toEqual([
        ids[4],
        ids[3],
    ])
    expect(repo.list(3)).toEqual([])
})

describe("sending state", () => {
    test("markSending claims a pending row once; sent/failed accept sending", () => {
        const db = openDb(":memory:")
        const repo = createOutboxRepo(db, { clock: createFakeClock() })
        const a = repo.enqueue({ task_id: 1, text: "a", reason: "r" })
        expect(repo.markSending(a.id)).toBe(true)
        expect(repo.markSending(a.id)).toBe(false) // already claimed
        expect(repo.pending(1)).toEqual([])
        expect(repo.markSent(a.id).status).toBe("sent")
        const b = repo.enqueue({ task_id: 1, text: "b", reason: "r" })
        repo.markSending(b.id)
        expect(repo.markFailed(b.id, "x").status).toBe("failed")
    })

    test("recoverInterrupted fails rows left 'sending' as uncertain", () => {
        const db = openDb(":memory:")
        const repo = createOutboxRepo(db, { clock: createFakeClock() })
        const a = repo.enqueue({ task_id: 1, text: "a", reason: "r" })
        const b = repo.enqueue({ task_id: 2, text: "b", reason: "r" })
        repo.markSending(a.id)
        const rows = repo.recoverInterrupted()
        expect(rows.map((r) => [r.id, r.status])).toEqual([[a.id, "failed"]])
        expect(rows[0].error).toMatch(/delivery uncertain: interrupted/)
        expect(repo.get(b.id).status).toBe("pending")
        expect(repo.recoverInterrupted()).toEqual([])
        // explicit retry brings it back
        expect(repo.requeue(a.id).status).toBe("pending")
    })
})

test("release puts a refused 'sending' row back to pending", () => {
    const repo = createOutboxRepo(openDb(":memory:"), {
        clock: createFakeClock(),
    })
    const a = repo.enqueue({ task_id: 1, text: "a", reason: "r" })
    expect(repo.release(a.id)).toBe(false) // pending: nothing to release
    repo.markSending(a.id)
    expect(repo.release(a.id)).toBe(true)
    expect(repo.pending(1).map((r) => r.id)).toEqual([a.id])
})
