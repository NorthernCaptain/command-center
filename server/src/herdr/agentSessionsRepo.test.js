/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { createFakeClock } from "../util/clock.js"
import { ValidationError } from "../util/errors.js"
import { openDb } from "../store/db.js"
import { createAgentSessionsRepo } from "./agentSessionsRepo.js"

let db
let clock
let repo
beforeEach(() => {
    db = openDb(":memory:")
    clock = createFakeClock()
    repo = createAgentSessionsRepo(db, { clock })
})
afterEach(() => db.close())

const base = {
    task_id: 7,
    name: "t7-fix-upload",
    workspace_id: "wE",
    pane_id: "wE:p1",
    kind: "claude",
    session_id: "uuid-1",
    state: "working",
}

test("create maps contract fields onto the table columns", () => {
    const s = repo.create(base)
    expect(s).toEqual({
        id: expect.any(Number),
        close_after: null,
        task_id: 7,
        name: "t7-fix-upload",
        workspace_id: "wE",
        pane_id: "wE:p1",
        session_id: "uuid-1",
        kind: "claude",
        state: "working",
        started_at: "2026-11-07T12:00:00.000Z",
        last_seen_at: "2026-11-07T12:00:00.000Z",
        ended_at: null,
    })
    const raw = db
        .prepare("SELECT * FROM agent_sessions WHERE id = ?")
        .get(s.id)
    expect(raw).toMatchObject({
        herdr_agent_name: "t7-fix-upload",
        herdr_workspace_id: "wE",
        herdr_pane_id: "wE:p1",
        claude_session_id: "uuid-1",
    })
    expect(repo.get(s.id)).toEqual(s)
    expect(repo.get(999)).toBeNull()
})

test("create defaults optional fields and accepts string task ids", () => {
    const s = repo.create({ task_id: "3", kind: "codex" })
    expect(s).toMatchObject({
        task_id: 3,
        name: null,
        workspace_id: null,
        pane_id: null,
        session_id: null,
        kind: "codex",
        state: "unknown",
    })
})

test("create validates task_id and kind", () => {
    expect(() => repo.create({ kind: "claude" })).toThrow(ValidationError)
    expect(() => repo.create({ task_id: 0, kind: "claude" })).toThrow(
        ValidationError
    )
    expect(() => repo.create({ task_id: 1, kind: "gpt" })).toThrow(
        ValidationError
    )
    expect(() => repo.create()).toThrow(ValidationError)
})

test("one live session per task: create replaces the previous live row", () => {
    const a = repo.create(base)
    const other = repo.create({ ...base, task_id: 8, pane_id: "wF:p1" })
    clock.set("2026-11-07T13:00:00.000Z")
    const b = repo.create({ ...base, pane_id: "wG:p1", kind: "codex" })
    expect(repo.get(a.id)).toMatchObject({
        state: "replaced",
        ended_at: "2026-11-07T13:00:00.000Z",
    })
    expect(repo.current(7)).toEqual(b)
    expect(repo.current(8)).toEqual(other)
    expect(repo.live().map((s) => s.id)).toEqual([other.id, b.id])
    expect(repo.history(7).map((s) => s.id)).toEqual([a.id, b.id])
})

test("current / byPane / live ignore ended rows", () => {
    const a = repo.create(base)
    expect(repo.current(7)).toEqual(a)
    expect(repo.current("7")).toEqual(a)
    expect(repo.byPane("wE:p1")).toEqual(a)
    clock.set("2026-11-07T14:00:00.000Z")
    const ended = repo.end(a.id)
    expect(ended).toMatchObject({
        state: "gone",
        ended_at: "2026-11-07T14:00:00.000Z",
    })
    expect(repo.current(7)).toBeNull()
    expect(repo.byPane("wE:p1")).toBeNull()
    expect(repo.live()).toEqual([])
    expect(repo.history(7)).toEqual([ended])
    expect(repo.history(99)).toEqual([])
})

test("end keeps the first end and accepts a custom state", () => {
    const a = repo.create(base)
    repo.end(a.id, "stopped")
    clock.set("2026-11-08T00:00:00.000Z")
    const again = repo.end(a.id, "gone")
    expect(again).toMatchObject({
        state: "stopped",
        ended_at: "2026-11-07T12:00:00.000Z",
    })
    expect(repo.end(12345)).toBeNull()
})

test("update patches state / session_id / last_seen_at", () => {
    const a = repo.create(base)
    clock.set("2026-11-07T12:05:00.000Z")
    expect(repo.update(a.id, { state: "idle" })).toMatchObject({
        state: "idle",
        session_id: "uuid-1",
        last_seen_at: "2026-11-07T12:05:00.000Z",
    })
    expect(
        repo.update(a.id, {
            session_id: "uuid-2",
            last_seen_at: "2026-11-07T11:00:00.000Z",
            state: undefined,
        })
    ).toMatchObject({
        state: "idle",
        session_id: "uuid-2",
        last_seen_at: "2026-11-07T11:00:00.000Z",
    })
    clock.set("2026-11-07T12:06:00.000Z")
    expect(repo.update(a.id).last_seen_at).toBe("2026-11-07T12:06:00.000Z")
    expect(repo.update(a.id, { close_after: "clean" }).close_after).toBe(
        "clean"
    )
    expect(repo.update(a.id, { close_after: null }).close_after).toBeNull()
    expect(() => repo.update(a.id, { pane_id: "x" })).toThrow(ValidationError)
    expect(repo.update(999, { state: "idle" })).toBeNull()
})
