/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { createFakeClock } from "../util/clock.js"
import { ValidationError } from "../util/errors.js"
import { openDb } from "./db.js"
import { createJobsRepo } from "./jobsRepo.js"

let db
let clock
let repo
beforeEach(() => {
    db = openDb(":memory:")
    clock = createFakeClock()
    repo = createJobsRepo(db, { clock })
})
afterEach(() => db.close())

test("insert with defaults and JSON fields", () => {
    const job = repo.insert({
        type: "enrich",
        lane: "background",
        task_id: 4,
        input: { a: 1 },
    })
    expect(job).toEqual({
        id: expect.stringMatching(/^j_[0-9a-f]{16}$/),
        task_id: 4,
        type: "enrich",
        lane: "background",
        status: "queued",
        provider: null,
        model: null,
        error: null,
        created_at: "2026-11-07T12:00:00.000Z",
        started_at: null,
        ended_at: null,
        input: { a: 1 },
        output: null,
        park: null,
        usage: null,
    })
    expect(repo.get(job.id)).toEqual(job)
    expect(repo.get("nope")).toBeNull()
})

test("insert validates", () => {
    expect(() => repo.insert({ lane: "background" })).toThrow(ValidationError)
    expect(() =>
        repo.insert({ type: "x", lane: "y", status: "weird" })
    ).toThrow(ValidationError)
    expect(() => repo.insert({ type: "x", lane: "y", bogus: 1 })).toThrow(
        /unknown job field/
    )
    expect(repo.insert({ id: "fixed", type: "x", lane: "y" }).id).toBe("fixed")
})

test("update patches fields and never created_at", () => {
    const job = repo.insert({ type: "assist", lane: "interactive" })
    const upd = repo.update(job.id, {
        status: "running",
        provider: "claude-sdk",
        started_at: "2026-11-07T12:00:01.000Z",
        output: { reply: "hi" },
        park: null,
        created_at: "1999-01-01T00:00:00Z",
    })
    expect(upd).toMatchObject({
        status: "running",
        provider: "claude-sdk",
        output: { reply: "hi" },
        park: null,
        created_at: job.created_at,
    })
    expect(repo.update(job.id, {})).toEqual(upd)
    expect(repo.update(job.id, undefined)).toEqual(upd)
    expect(() => repo.update(job.id, { status: "nah" })).toThrow(
        ValidationError
    )
    expect(() => repo.update(job.id, { nope: 1 })).toThrow(ValidationError)
})

test("list newest first with filters; listByStatus oldest first", async () => {
    const a = repo.insert({ type: "t", lane: "l", task_id: 1 })
    await clock.advance(1000)
    const b = repo.insert({ type: "t", lane: "l", task_id: 1, status: "done" })
    await clock.advance(1000)
    const c = repo.insert({
        type: "t",
        lane: "l",
        task_id: 2,
        status: "parked",
    })
    expect(repo.list().map((j) => j.id)).toEqual([c.id, b.id, a.id])
    expect(repo.list({ task_id: 1 }).map((j) => j.id)).toEqual([b.id, a.id])
    expect(repo.list({ status: "done" }).map((j) => j.id)).toEqual([b.id])
    expect(
        repo.list({ status: ["queued", "parked"], limit: 1 }).map((j) => j.id)
    ).toEqual([c.id])
    expect(() => repo.list({ status: "zzz" })).toThrow(ValidationError)
    expect(repo.listByStatus(["parked", "queued"]).map((j) => j.id)).toEqual([
        a.id,
        c.id,
    ])
    expect(repo.listByStatus("done").map((j) => j.id)).toEqual([b.id])
    expect(repo.listByStatus([])).toEqual([])
    expect(repo.listByStatus()).toEqual([])
})
