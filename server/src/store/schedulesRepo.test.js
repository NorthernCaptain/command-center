/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { createFakeClock } from "../util/clock.js"
import { ValidationError } from "../util/errors.js"
import { openDb } from "./db.js"
import { createSchedulesRepo } from "./schedulesRepo.js"

let db
let clock
let repo
beforeEach(() => {
    db = openDb(":memory:")
    clock = createFakeClock()
    repo = createSchedulesRepo(db, { clock })
})
afterEach(() => db.close())

test("add normalizes fire_at to UTC and returns the schedule", () => {
    const s = repo.add({
        task_id: 3,
        fire_at: "2026-11-08T10:00:00+02:00",
        action: "surface",
        payload: { reason: "ping" },
        note: "n",
    })
    expect(s).toMatchObject({
        id: expect.any(Number),
        task_id: 3,
        fire_at: "2026-11-08T08:00:00.000Z",
        action: "surface",
        payload: { reason: "ping" },
        status: "pending",
        note: "n",
        created_at: "2026-11-07T12:00:00.000Z",
        fired_at: null,
        error: null,
    })
    expect(repo.get(s.id)).toEqual(s)
    expect(repo.get(999)).toBeNull()
})

test("add validates input", () => {
    expect(() =>
        repo.add({ task_id: 1, fire_at: "tomorrow", action: "surface" })
    ).toThrow(ValidationError)
    const s = repo.add({
        task_id: null,
        fire_at: clock.now().toISOString(),
        action: "center_job",
    })
    expect(s.payload).toEqual({})
    expect(s.note).toBeNull()
})

test("listPending / listForTask ordering and dueBefore filter", () => {
    const a = repo.add({
        task_id: 1,
        fire_at: "2026-11-09T00:00:00Z",
        action: "surface",
    })
    const b = repo.add({
        task_id: 1,
        fire_at: "2026-11-08T00:00:00Z",
        action: "surface",
    })
    const c = repo.add({
        task_id: 2,
        fire_at: "2026-11-10T00:00:00Z",
        action: "surface",
    })
    expect(repo.listPending().map((s) => s.id)).toEqual([b.id, a.id, c.id])
    expect(repo.listPending("2026-11-09T00:00:00Z").map((s) => s.id)).toEqual([
        b.id,
        a.id,
    ])
    expect(repo.listPending(new Date("2026-11-01")).length).toBe(0)
    expect(repo.listForTask(1).map((s) => s.id)).toEqual([b.id, a.id])
})

test("markFired, markFailed, cancel, cancelForTask", () => {
    const a = repo.add({
        task_id: 1,
        fire_at: "2026-11-08T00:00:00Z",
        action: "surface",
    })
    const b = repo.add({
        task_id: 1,
        fire_at: "2026-11-08T00:00:00Z",
        action: "surface",
    })
    const c = repo.add({
        task_id: 2,
        fire_at: "2026-11-08T00:00:00Z",
        action: "surface",
    })
    const d = repo.add({
        task_id: 2,
        fire_at: "2026-11-08T00:00:00Z",
        action: "surface",
    })

    const fired = repo.markFired(a.id)
    expect(fired.status).toBe("fired")
    expect(fired.fired_at).toBe("2026-11-07T12:00:00.000Z")
    expect(repo.markFailed(a.id, new Error("bad")).status).toBe("failed")
    expect(repo.get(a.id).error).toBe("bad")
    expect(repo.markFired(a.id).status).toBe("failed")

    expect(repo.markFailed(b.id, "plain").error).toBe("plain")
    expect(repo.cancel(c.id)).toBe(true)
    expect(repo.cancel(c.id)).toBe(false)
    expect(repo.listPending().map((s) => s.id)).toEqual([d.id])
    expect(repo.cancelForTask(2)).toBe(1)
    expect(repo.listPending()).toEqual([])
})
