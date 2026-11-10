/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { act, renderHook, waitFor } from "@testing-library/react"
import {
    agentStateOf,
    eventTaskId,
    setAgentState,
    removeFromLanes,
    upsertById,
    upsertJob,
    upsertComment,
    useBoard,
    useDebounced,
    useEvents,
    useStreamStatus,
    useTask,
    applyTaskEvent,
} from "./hooks.js"
import { createEventStream, setEventStream } from "./events.js"
import { FakeEventSource } from "../../test/helpers.js"

function stream() {
    const s = createEventStream({ EventSource: null })
    setEventStream(s)
    return s
}

const emit = (s, type, task_id, data) =>
    act(() => s.dispatch({ type, task_id, data, at: null }))

describe("upsertComment", () => {
    const threads = [
        {
            id: "c1",
            body: "a",
            status: "open",
            replies: [{ id: "r1", body: "x" }],
        },
    ]

    it("adds new top-level threads with defaults", () => {
        const out = upsertComment(threads, { id: "c2", body: "b" })
        expect(out[1]).toEqual({
            id: "c2",
            body: "b",
            status: "open",
            replies: [],
        })
    })
    it("updates existing threads, keeping replies", () => {
        const out = upsertComment(threads, { id: "c1", status: "resolved" })
        expect(out[0].status).toBe("resolved")
        expect(out[0].replies).toHaveLength(1)
        const out2 = upsertComment([{ id: "c1" }], { id: "c1", status: "x" })
        expect(out2[0].replies).toEqual([])
    })
    it("adds and updates replies", () => {
        const added = upsertComment(threads, {
            id: "r2",
            parent_id: "c1",
            body: "y",
        })
        expect(added[0].replies.map((r) => r.id)).toEqual(["r1", "r2"])
        const updated = upsertComment(threads, {
            id: "r1",
            parent_id: "c1",
            body: "z",
        })
        expect(updated[0].replies[0].body).toBe("z")
        const other = upsertComment(threads, {
            id: "r3",
            parent_id: "nope",
            body: "q",
        })
        expect(other).toEqual(threads)
        expect(
            upsertComment([{ id: "c1" }], { id: "r", parent_id: "c1" })[0]
                .replies
        ).toHaveLength(1)
    })
    it("ignores invalid input", () => {
        expect(upsertComment(null, null)).toEqual([])
        expect(upsertComment(threads, {})).toBe(threads)
    })
})

describe("upsertById", () => {
    it("inserts and merges", () => {
        expect(upsertById(null, { id: 1 })).toEqual([{ id: 1 }])
        expect(upsertById([{ id: 1, a: 1 }], { id: 1, b: 2 })).toEqual([
            { id: 1, a: 1, b: 2 },
        ])
        expect(upsertById([{ id: 1 }], null)).toEqual([{ id: 1 }])
    })
})

describe("upsertJob", () => {
    it("inserts and merges like upsertById", () => {
        expect(upsertJob(null, { id: "j1", status: "queued" })).toEqual([
            { id: "j1", status: "queued" },
        ])
        expect(
            upsertJob([{ id: "j1", status: "queued" }], {
                id: "j1",
                status: "failed",
                error: "x",
            })
        ).toEqual([{ id: "j1", status: "failed", error: "x" }])
        const list = [{ id: "j1" }]
        expect(upsertJob(list, null)).toBe(list)
    })

    it("does not move a finished job back to an active status", () => {
        const list = [{ id: "j1", status: "failed", error: "x" }]
        expect(upsertJob(list, { id: "j1", status: "queued" })).toBe(list)
        expect(upsertJob(list, { id: "j1", status: "done" })).toEqual([
            { id: "j1", status: "done", error: "x" },
        ])
    })
})

describe("useEvents / useStreamStatus / useDebounced", () => {
    it("subscribes and unsubscribes", () => {
        const s = stream()
        const fn = jest.fn()
        const { unmount } = renderHook(() => useEvents(["a", "b"], fn))
        emit(s, "a", 1, {})
        emit(s, "b", 1, {})
        unmount()
        emit(s, "a", 1, {})
        expect(fn).toHaveBeenCalledTimes(2)
    })

    it("tracks stream status", () => {
        FakeEventSource.reset()
        const s = createEventStream({ EventSource: FakeEventSource })
        setEventStream(s)
        const { result } = renderHook(() => useStreamStatus())
        expect(result.current).toBe("closed")
        act(() => s.start())
        expect(result.current).toBe("connecting")
        act(() => FakeEventSource.last().onopen())
        expect(result.current).toBe("open")
        act(() => s.close())
    })

    it("debounces", () => {
        jest.useFakeTimers()
        const fn = jest.fn()
        const { result, unmount } = renderHook(() => useDebounced(fn, 100))
        result.current(1)
        result.current(2)
        jest.advanceTimersByTime(100)
        expect(fn).toHaveBeenCalledTimes(1)
        expect(fn).toHaveBeenCalledWith(2)
        unmount()
        jest.useRealTimers()
    })
})

describe("useBoard", () => {
    it("loads lanes and refreshes on task events", async () => {
        const s = stream()
        const api = {
            board: jest
                .fn()
                .mockResolvedValueOnce({ lanes: { now: [{ id: 1 }] } })
                .mockResolvedValueOnce({
                    lanes: { now: [], done: [{ id: 1 }] },
                }),
        }
        const { result } = renderHook(() => useBoard({ api, debounceMs: 0 }))
        await waitFor(() => expect(result.current.loading).toBe(false))
        expect(result.current.lanes.now).toEqual([{ id: 1 }])
        expect(result.current.lanes.inbox).toEqual([])
        emit(s, "task.updated", 1, {})
        await waitFor(() =>
            expect(result.current.lanes.done).toEqual([{ id: 1 }])
        )
        expect(api.board).toHaveBeenCalledTimes(2)
    })

    it("reports errors and tolerates empty responses", async () => {
        stream()
        const err = new Error("down")
        const api = {
            board: jest
                .fn()
                .mockRejectedValueOnce(err)
                .mockResolvedValueOnce(null),
        }
        const { result } = renderHook(() => useBoard({ api }))
        await waitFor(() => expect(result.current.error).toBe(err))
        await act(() => result.current.reload())
        expect(result.current.error).toBeNull()
        expect(result.current.lanes.now).toEqual([])
    })

    it("ignores results after unmount", async () => {
        stream()
        let resolve
        const api = { board: jest.fn(() => new Promise((r) => (resolve = r))) }
        const { unmount } = renderHook(() => useBoard({ api }))
        unmount()
        await act(async () => resolve({ lanes: {} }))
        expect(api.board).toHaveBeenCalledTimes(1)
    })
})

describe("useTask", () => {
    const base = {
        task: { id: 5, title: "t", status: "active" },
        revision: "r1",
        artifact: { content: "# x", revision: "a1" },
        comments: [],
        events: [],
        schedules: [],
        jobs: [],
    }

    it("loads and applies live events for its task", async () => {
        const s = stream()
        const api = { getTask: jest.fn().mockResolvedValue(base) }
        const { result } = renderHook(() => useTask(5, { api, debounceMs: 0 }))
        await waitFor(() => expect(result.current.data).not.toBeNull())
        expect(result.current.data.artifact.content).toBe("# x")

        emit(s, "task.updated", 6, { task: { id: 6 } }) // other task: ignored
        emit(s, "task.updated", 5, { task: { ...base.task, title: "renamed" } })
        expect(result.current.data.task.title).toBe("renamed")

        emit(s, "comment.added", 5, {
            comment: { id: "c1", body: "hi", intent: "note" },
        })
        expect(result.current.data.comments[0].id).toBe("c1")
        emit(s, "comment.updated", 5, {
            comment: { id: "c1", status: "resolved" },
        })
        expect(result.current.data.comments[0].status).toBe("resolved")

        emit(s, "event.added", 5, { event: { type: "updated", at: "x" } })
        emit(s, "event.added", 5, {})
        expect(result.current.data.events).toHaveLength(1)

        emit(s, "job.updated", 5, { job: { id: "j1", status: "running" } })
        expect(result.current.data.jobs[0].status).toBe("running")
        emit(s, "job.delta", 5, { job_id: "j1", text: "Hel" })
        emit(s, "job.delta", 5, { job_id: "j1", text: "lo" })
        emit(s, "job.delta", 5, { text: "no id" })
        expect(result.current.deltas).toEqual({ j1: "Hello" })

        emit(s, "schedule.updated", 5, {
            schedule: { id: 3, status: "pending" },
        })
        expect(result.current.data.schedules[0].id).toBe(3)

        emit(s, "task.updated", 5, {})
        emit(s, "artifact.updated", 5, { revision: "a2" })
        emit(s, "stream.reconnected", null, {})
        await waitFor(() =>
            expect(api.getTask.mock.calls.length).toBeGreaterThan(1)
        )
    })

    it("normalizes viewer responses", async () => {
        stream()
        const api = {
            getTask: jest.fn().mockResolvedValue({
                task: { id: 5 },
                artifact: { content: "x" },
            }),
        }
        const { result } = renderHook(() => useTask(5, { api }))
        await waitFor(() => expect(result.current.data).not.toBeNull())
        expect(result.current.data.comments).toEqual([])
        expect(result.current.data.artifact.revision).toBeNull()
    })

    it("reports load errors", async () => {
        stream()
        const err = Object.assign(new Error("nf"), { status: 404 })
        const api = { getTask: jest.fn().mockRejectedValue(err) }
        const { result } = renderHook(() => useTask(5, { api }))
        await waitFor(() => expect(result.current.error).toBe(err))
        expect(result.current.loading).toBe(false)
    })

    it("drops responses for a stale id", async () => {
        stream()
        let resolveFirst
        const api = {
            getTask: jest
                .fn()
                .mockImplementationOnce(
                    () => new Promise((r) => (resolveFirst = r))
                )
                .mockResolvedValueOnce({ ...base, task: { id: 6 } }),
        }
        const { result, rerender } = renderHook(
            ({ id }) => useTask(id, { api }),
            { initialProps: { id: 5 } }
        )
        rerender({ id: 6 })
        await waitFor(() =>
            expect(result.current.data && result.current.data.task.id).toBe(6)
        )
        await act(async () => resolveFirst(base))
        expect(result.current.data.task.id).toBe(6)
    })

    it("events before load do not crash", async () => {
        const s = stream()
        const api = { getTask: jest.fn(() => new Promise(() => {})) }
        renderHook(() => useTask(5, { api }))
        emit(s, "task.updated", 5, { task: { id: 5 } })
        emit(s, "comment.added", 5, { comment: { id: "c" } })
        emit(s, "event.added", 5, { event: { type: "x" } })
        emit(s, "job.updated", 5, { job: { id: "j" } })
        emit(s, "schedule.updated", 5, { schedule: { id: 1 } })
    })
})

describe("eventTaskId / removeFromLanes", () => {
    it("finds the task id at the top level or in data", () => {
        expect(eventTaskId(null)).toBeNull()
        expect(eventTaskId({ task_id: 3, data: {} })).toBe(3)
        expect(eventTaskId({ task_id: null, data: { task_id: 4 } })).toBe(4)
        expect(eventTaskId({ task_id: null, data: { task: { id: 5 } } })).toBe(
            5
        )
        expect(eventTaskId({ task_id: undefined })).toBeNull()
    })

    it("removes a task from every lane", () => {
        expect(removeFromLanes(null, 1)).toBeNull()
        expect(
            removeFromLanes({ now: [{ id: 1 }, { id: 2 }], done: null }, "1")
        ).toEqual({ now: [{ id: 2 }], done: [] })
    })
})

function deferred() {
    let resolve
    const promise = new Promise((r) => (resolve = r))
    return { promise, resolve }
}

describe("out-of-order responses", () => {
    it("useBoard keeps the newest board when an older reload lands late", async () => {
        stream()
        const slow = deferred()
        const fast = deferred()
        const api = {
            board: jest
                .fn()
                .mockReturnValueOnce(slow.promise)
                .mockReturnValueOnce(fast.promise),
        }
        const { result } = renderHook(() => useBoard({ api }))
        act(() => {
            result.current.reload()
        })
        await act(async () => fast.resolve({ lanes: { now: [{ id: 2 }] } }))
        await act(async () => slow.resolve({ lanes: { now: [{ id: 1 }] } }))
        expect(result.current.lanes.now).toEqual([{ id: 2 }])
        expect(result.current.loading).toBe(false)
    })

    it("useBoard ignores a stale error", async () => {
        stream()
        const slow = deferred()
        const api = {
            board: jest
                .fn()
                .mockReturnValueOnce(
                    slow.promise.then(() => {
                        throw new Error("old failure")
                    })
                )
                .mockResolvedValueOnce({ lanes: {} }),
        }
        const { result } = renderHook(() => useBoard({ api }))
        await act(() => result.current.reload())
        await act(async () => slow.resolve())
        expect(result.current.error).toBeNull()
    })

    it("useTask keeps the newest revision when an older reload lands late", async () => {
        stream()
        const slow = deferred()
        const fast = deferred()
        const api = {
            getTask: jest
                .fn()
                .mockReturnValueOnce(slow.promise)
                .mockReturnValueOnce(fast.promise),
        }
        const { result } = renderHook(() => useTask(5, { api }))
        act(() => {
            result.current.reload()
        })
        await act(async () => fast.resolve({ task: { id: 5 }, revision: "r2" }))
        await act(async () => slow.resolve({ task: { id: 5 }, revision: "r1" }))
        expect(result.current.data.revision).toBe("r2")
    })

    it("useTask replays live events over a snapshot that was in flight", async () => {
        const s = stream()
        const running = { id: "j1", type: "assist", status: "running" }
        const done = { ...running, status: "done" }
        const stale = deferred()
        const api = {
            getTask: jest
                .fn()
                .mockResolvedValueOnce({
                    task: { id: 5 },
                    revision: "r1",
                    jobs: [running],
                })
                .mockReturnValueOnce(stale.promise),
        }
        const { result } = renderHook(() => useTask(5, { api }))
        await waitFor(() => expect(result.current.data).not.toBeNull())
        act(() => {
            result.current.reload()
        })
        // these land while the reload is in flight
        emit(s, "job.updated", 5, { job: done })
        emit(s, "comment.updated", 5, {
            comment: { id: "c1", body: "b", status: "resolved" },
        })
        emit(s, "event.added", 5, { event: { type: "x", at: "t1" } })
        await act(async () =>
            stale.resolve({
                task: { id: 5 },
                revision: "r2",
                jobs: [running],
                comments: [
                    { id: "c1", body: "b", status: "open", replies: [] },
                ],
                events: [{ type: "x", at: "t1" }], // already in the snapshot
            })
        )
        const d = result.current.data
        expect(d.revision).toBe("r2")
        expect(d.jobs[0].status).toBe("done")
        expect(d.comments[0].status).toBe("resolved")
        expect(d.events).toEqual([{ type: "x", at: "t1" }])
        expect(api.getTask).toHaveBeenCalledTimes(2)
        // after the reload, events are no longer buffered
        emit(s, "schedule.updated", 5, { schedule: { id: 9, status: "done" } })
        expect(result.current.data.schedules).toEqual([
            { id: 9, status: "done" },
        ])
    })

    it("useTask drops loaded data when a reconnect reload finds the task gone", async () => {
        const s = stream()
        const notFound = Object.assign(new Error("not found"), { status: 404 })
        const api = {
            getTask: jest
                .fn()
                .mockResolvedValueOnce({ task: { id: 5 }, revision: "r1" })
                .mockRejectedValueOnce(notFound),
        }
        const { result } = renderHook(() => useTask(5, { api, debounceMs: 0 }))
        await waitFor(() => expect(result.current.data).not.toBeNull())
        emit(s, "job.delta", 5, { job_id: "j1", text: "partial" })
        expect(result.current.deltas).toEqual({ j1: "partial" })
        // task.hidden was missed while offline; the reconnect reload 404s
        emit(s, "stream.reconnected", null, {})
        await waitFor(() => expect(result.current.error).toBe(notFound))
        expect(result.current.data).toBeNull()
        expect(result.current.deltas).toEqual({})
    })

    it("useTask keeps data on a transient reload error", async () => {
        stream()
        const boom = Object.assign(new Error("server down"), { status: 503 })
        const api = {
            getTask: jest
                .fn()
                .mockResolvedValueOnce({ task: { id: 5 }, revision: "r1" })
                .mockRejectedValueOnce(boom),
        }
        const { result } = renderHook(() => useTask(5, { api }))
        await waitFor(() => expect(result.current.data).not.toBeNull())
        await act(() => result.current.reload())
        expect(result.current.error).toBe(boom)
        expect(result.current.data.revision).toBe("r1")
    })

    it("useTask ignores a stale error", async () => {
        stream()
        const slow = deferred()
        const api = {
            getTask: jest
                .fn()
                .mockReturnValueOnce(
                    slow.promise.then(() => {
                        throw new Error("old failure")
                    })
                )
                .mockResolvedValueOnce({ task: { id: 5 }, revision: "r2" }),
        }
        const { result } = renderHook(() => useTask(5, { api }))
        await act(() => result.current.reload())
        await act(async () => slow.resolve())
        expect(result.current.error).toBeNull()
        expect(result.current.data.revision).toBe("r2")
    })
})

describe("task.hidden", () => {
    it("useBoard drops the task right away", async () => {
        const s = stream()
        const api = {
            board: jest.fn().mockResolvedValue({
                lanes: { now: [{ id: 1 }, { id: 2 }] },
            }),
        }
        const { result } = renderHook(() =>
            useBoard({ api, debounceMs: 10000 })
        )
        await waitFor(() => expect(result.current.loading).toBe(false))
        emit(s, "task.hidden", null, { task_id: 1 })
        expect(result.current.lanes.now).toEqual([{ id: 2 }])
        emit(s, "task.hidden", null, {}) // no id: nothing to remove
        expect(result.current.lanes.now).toEqual([{ id: 2 }])
    })

    it("useTask flags the task hidden and un-hides when shared again", async () => {
        const s = stream()
        const pending = deferred()
        const api = {
            getTask: jest
                .fn()
                .mockResolvedValueOnce({ task: { id: 5 }, revision: "r1" })
                .mockReturnValueOnce(pending.promise)
                .mockResolvedValue({ task: { id: 5 }, revision: "r3" }),
        }
        const { result } = renderHook(() => useTask(5, { api, debounceMs: 0 }))
        await waitFor(() => expect(result.current.data).not.toBeNull())
        emit(s, "task.hidden", 6, { task_id: 6 }) // other task
        expect(result.current.hidden).toBe(false)
        // a reload in flight when the task gets hidden must not resurrect it
        act(() => {
            result.current.reload()
        })
        emit(s, "task.hidden", 5, { task_id: 5 })
        expect(result.current.hidden).toBe(true)
        expect(result.current.data).toBeNull()
        await act(async () => pending.resolve({ task: { id: 5 } }))
        expect(result.current.hidden).toBe(true)
        expect(result.current.data).toBeNull()
        // shared again: stays hidden (no data yet) until the reload lands
        emit(s, "task.created", 5, { task: { id: 5 } })
        expect(result.current.hidden).toBe(true)
        expect(result.current.data).toBeNull()
        await waitFor(() => expect(result.current.hidden).toBe(false))
        expect(result.current.data.revision).toBe("r3")
        emit(s, "task.hidden", null, { task_id: 5 })
        expect(result.current.hidden).toBe(true)
        // task.updated carries the task, but data must not be half-built
        emit(s, "task.updated", 5, { task: { id: 5 } })
        expect(result.current.hidden).toBe(true)
        expect(result.current.data).toBeNull()
        await waitFor(() => expect(result.current.hidden).toBe(false))
        expect(result.current.data).not.toBeNull()
    })

    it("useTask stays hidden when the reload after re-sharing fails", async () => {
        const s = stream()
        const api = {
            getTask: jest
                .fn()
                .mockResolvedValueOnce({ task: { id: 5 }, revision: "r1" })
                .mockRejectedValue(
                    Object.assign(new Error("nf"), { status: 404 })
                ),
        }
        const { result } = renderHook(() => useTask(5, { api, debounceMs: 0 }))
        await waitFor(() => expect(result.current.data).not.toBeNull())
        emit(s, "task.hidden", 5, { task_id: 5 })
        emit(s, "task.updated", 5, { task: { id: 5 } })
        await waitFor(() => expect(result.current.error).not.toBeNull())
        expect(result.current.hidden).toBe(true)
        expect(result.current.data).toBeNull()
    })
})

describe("applyTaskEvent", () => {
    const prev = {
        task: { id: 1 },
        comments: [],
        events: [],
        jobs: [],
        schedules: [],
    }
    it("ignores missing data, missing payloads and other types", () => {
        expect(applyTaskEvent(null, { type: "job.updated" })).toBeNull()
        for (const type of [
            "task.updated",
            "comment.added",
            "event.added",
            "job.updated",
            "schedule.updated",
            "artifact.updated",
        ])
            expect(applyTaskEvent(prev, { type, data: {} })).toBe(prev)
        expect(applyTaskEvent(prev, { type: "job.updated" })).toBe(prev)
    })
    it("applies task, comment, job and schedule updates", () => {
        const t = applyTaskEvent(prev, {
            type: "task.updated",
            data: { task: { id: 1, title: "x" } },
        })
        expect(t.task.title).toBe("x")
        const e = applyTaskEvent(
            { ...prev, events: undefined },
            { type: "event.added", data: { event: { type: "a" } } }
        )
        expect(e.events).toEqual([{ type: "a" }])
    })
})

describe("worker agent overlay (phase 2)", () => {
    it("agentStateOf reads data.state, data.agent.state or the top level", () => {
        expect(agentStateOf({ data: { state: "idle" } })).toBe("idle")
        expect(agentStateOf({ data: { agent: { state: "done" } } })).toBe(
            "done"
        )
        expect(agentStateOf({ data: {}, state: "blocked" })).toBe("blocked")
        expect(agentStateOf({ data: { agent: {} } })).toBeNull()
        expect(agentStateOf(null)).toBeNull()
    })

    it("setAgentState sets and removes entries without mutating", () => {
        const a = { 1: "working" }
        expect(setAgentState(a, 2, "idle")).toEqual({ 1: "working", 2: "idle" })
        expect(setAgentState(a, 1, null)).toEqual({})
        expect(setAgentState(undefined, 3, "done")).toEqual({ 3: "done" })
        expect(a).toEqual({ 1: "working" })
    })

    it("useBoard keeps board.agents and patches them on agent.updated", async () => {
        const s = stream()
        const api = {
            board: jest.fn().mockResolvedValue({
                lanes: { active: [{ id: 1 }] },
                agents: { 1: "working" },
            }),
        }
        const { result } = renderHook(() => useBoard({ api, debounceMs: 0 }))
        await waitFor(() =>
            expect(result.current.agents).toEqual({ 1: "working" })
        )
        emit(s, "agent.updated", 1, { state: "blocked" })
        expect(result.current.agents).toEqual({ 1: "blocked" })
        emit(s, "agent.updated", 2, { state: "idle" })
        expect(result.current.agents).toEqual({ 1: "blocked", 2: "idle" })
        emit(s, "agent.updated", 2, {})
        expect(result.current.agents).toEqual({ 1: "blocked" })
        emit(s, "agent.updated", null, { state: "idle" }) // no task: ignored
        expect(result.current.agents).toEqual({ 1: "blocked" })
        // overlay only: no board reload
        expect(api.board).toHaveBeenCalledTimes(1)
    })

    it("useBoard defaults agents to an empty map", async () => {
        stream()
        const api = { board: jest.fn().mockResolvedValue({ lanes: {} }) }
        const { result } = renderHook(() => useBoard({ api }))
        await waitFor(() => expect(result.current.loading).toBe(false))
        expect(result.current.agents).toEqual({})
    })

    it("useTask applies agent.updated and refreshes on agent/pr/feedback events", async () => {
        const s = stream()
        const data = {
            task: { id: 5, title: "t", status: "active" },
            revision: "r1",
            artifact: { content: "", revision: "a1" },
            agent: { state: "working", kind: "claude", name: "t5-x" },
            outbox: [],
        }
        const api = { getTask: jest.fn().mockResolvedValue(data) }
        const { result } = renderHook(() => useTask(5, { api, debounceMs: 0 }))
        await waitFor(() => expect(result.current.data).not.toBeNull())
        expect(result.current.data.prs).toEqual([])
        expect(result.current.data.reviews).toEqual([])
        api.getTask.mockResolvedValue({
            ...data,
            agent: { ...data.agent, state: "idle" },
        })
        emit(s, "agent.updated", 5, { state: "idle" })
        expect(result.current.data.agent.state).toBe("idle")
        await waitFor(() => expect(api.getTask).toHaveBeenCalledTimes(2))
        emit(s, "pr.updated", 5, {})
        await waitFor(() => expect(api.getTask).toHaveBeenCalledTimes(3))
        emit(s, "feedback.updated", 5, {})
        await waitFor(() => expect(api.getTask).toHaveBeenCalledTimes(4))
        // the Slack thread notice is computed from its events: reload
        emit(s, "event.added", 5, {
            event: { type: "slack_asana_link_result", at: "t9" },
        })
        await waitFor(() => expect(api.getTask).toHaveBeenCalledTimes(5))
        emit(s, "event.added", 5, { event: { type: "updated", at: "t10" } })
        emit(s, "pr.updated", 6, {}) // other task
        await new Promise((r) => setTimeout(r, 10))
        expect(api.getTask).toHaveBeenCalledTimes(5)
    })

    it("applyTaskEvent ignores agent.updated without an agent or a state", () => {
        const prev = { agent: null }
        expect(
            applyTaskEvent(prev, {
                type: "agent.updated",
                data: { state: "x" },
            })
        ).toBe(prev)
        const withAgent = { agent: { state: "idle" } }
        expect(
            applyTaskEvent(withAgent, { type: "agent.updated", data: {} })
        ).toBe(withAgent)
    })
})
