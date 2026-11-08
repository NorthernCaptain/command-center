/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { createFakeClock } from "../util/clock.js"
import {
    createStaleSweep,
    DEFAULT_STALE_DAYS,
    EV_STALE,
    isStaleCandidate,
    queryAll,
    staleDays,
    staleReason,
} from "./stale.js"

const NOW = "2026-11-20T12:00:00.000Z"
const OLD = "2026-11-01T12:00:00.000Z" // 19 days before NOW
const FRESH = "2026-11-19T12:00:00.000Z"
const FLAGS = { enriching: false, now: false, now_reason: null, error: null }

function makeTask(id, over = {}) {
    return {
        id,
        title: `Task ${id}`,
        status: "ready",
        snooze_until: null,
        updated_at: OLD,
        flags: { ...FLAGS },
        ...over,
    }
}

/** Store fake: query (paged by 2), getTask, updateTask (bumps updated_at),
 *  appendEvent, listEvents (newest first), withTaskLock. */
function fakeStore(tasks, clock, { lock = true } = {}) {
    const map = new Map(tasks.map((t) => [t.id, structuredClone(t)]))
    const events = new Map()
    const store = {
        map,
        events,
        query: jest.fn(async ({ status, limit, offset }) => {
            const all = [...map.values()].filter((t) =>
                status.includes(t.status)
            )
            return {
                tasks: all.slice(offset, offset + Math.min(limit, 2)),
                total: all.length,
            }
        }),
        getTask: jest.fn(async (id) => ({
            task: structuredClone(map.get(id)),
            revision: "r",
        })),
        updateTask: jest.fn(async (id, patch) => {
            const t = { ...map.get(id), ...patch }
            t.updated_at = clock.now().toISOString()
            map.set(id, t)
            return { task: structuredClone(t) }
        }),
        appendEvent: jest.fn(async (id, ev) => {
            const list = events.get(id) || []
            list.push(ev)
            events.set(id, list)
        }),
        listEvents: jest.fn(async (id) =>
            [...(events.get(id) || [])].reverse()
        ),
    }
    if (lock) store.withTaskLock = jest.fn((id, fn) => fn())
    return store
}

describe("helpers", () => {
    test("staleReason pluralises", () => {
        expect(staleReason(1)).toBe("Stale: no change in 1 day")
        expect(staleReason(7)).toBe("Stale: no change in 7 days")
    })

    test("staleDays reads the setting with a safe fallback", async () => {
        expect(await staleDays(null)).toBe(DEFAULT_STALE_DAYS)
        expect(await staleDays({ get: async () => 3 })).toBe(3)
        expect(await staleDays({ get: async () => 0 })).toBe(7)
        expect(await staleDays({ get: async () => "5" })).toBe(7)
        const repo = { get: jest.fn((k, d) => d) }
        expect(await staleDays(repo)).toBe(7)
        expect(repo.get).toHaveBeenCalledWith("stale.days", 7)
    })

    test("isStaleCandidate", () => {
        const now = Date.parse(NOW)
        expect(isStaleCandidate(makeTask(1), now, 7)).toBe(true)
        expect(isStaleCandidate(makeTask(1, { status: "inbox" }), now, 7)).toBe(
            false
        )
        expect(
            isStaleCandidate(
                makeTask(1, { status: "waiting", snooze_until: NOW }),
                now,
                7
            )
        ).toBe(false)
        expect(
            isStaleCandidate(makeTask(1, { status: "waiting" }), now, 7)
        ).toBe(true)
        expect(
            isStaleCandidate(
                makeTask(1, { flags: { ...FLAGS, now: true } }),
                now,
                7
            )
        ).toBe(false)
        expect(isStaleCandidate(makeTask(1, { flags: null }), now, 7)).toBe(
            true
        )
        expect(
            isStaleCandidate(makeTask(1, { updated_at: FRESH }), now, 7)
        ).toBe(false)
        expect(
            isStaleCandidate(makeTask(1, { updated_at: "bad" }), now, 7)
        ).toBe(false)
    })

    test("queryAll pages until total or an empty page", async () => {
        const store = {
            query: jest
                .fn()
                .mockResolvedValueOnce({ tasks: [1, 2], total: 5 })
                .mockResolvedValueOnce({ tasks: [], total: 5 }),
        }
        expect(await queryAll(store, { status: "x" })).toEqual([1, 2])
        expect(store.query).toHaveBeenLastCalledWith({
            status: "x",
            limit: 1000,
            offset: 2,
        })
    })
})

describe("sweep", () => {
    test("flags stale tasks once with an event", async () => {
        const clock = createFakeClock(NOW)
        const store = fakeStore(
            [
                makeTask(1),
                makeTask(2, { status: "active" }),
                makeTask(3, { status: "waiting", snooze_until: NOW }),
                makeTask(4, { updated_at: FRESH }),
                makeTask(5, { status: "done" }),
            ],
            clock
        )
        const sweep = createStaleSweep({
            store,
            settingsRepo: { get: async () => 7 },
            clock,
        })
        const res = await sweep.sweep()
        expect(res.days).toBe(7)
        expect(res.checked).toBe(4)
        expect(res.flagged).toEqual([
            { id: 1, title: "Task 1", status: "ready", days: 7 },
            { id: 2, title: "Task 2", status: "active", days: 7 },
        ])
        expect(store.map.get(1).flags).toEqual({
            ...FLAGS,
            now: true,
            now_reason: "Stale: no change in 7 days",
        })
        expect(store.updateTask.mock.calls[0][2]).toEqual({
            actor: "system",
            baseRevision: "r",
            reason: "stale sweep",
        })
        expect(store.events.get(1)).toEqual([
            { type: EV_STALE, data: { days: 7, updated_at: NOW } },
        ])
        expect(store.withTaskLock).toHaveBeenCalledTimes(2)

        // again: already in Now
        expect((await sweep.sweep()).flagged).toEqual([])

        // Leo clears Now (a change); much later it is stale again
        store.map.get(1).flags.now = false
        store.map.get(1).updated_at = "2026-11-21T12:00:00.000Z"
        clock.set("2026-12-01T12:00:00.000Z")
        // task 4 has aged into staleness by now too
        expect((await sweep.sweep()).flagged.map((t) => t.id)).toEqual([1, 4])
    })

    test("not again until the task changes", async () => {
        const clock = createFakeClock(NOW)
        const store = fakeStore([makeTask(1)], clock, { lock: false })
        // flagged before, and nothing changed since (same updated_at)
        store.events.set(1, [
            { type: "other", data: {} },
            { type: EV_STALE, data: { days: 7, updated_at: OLD } },
        ])
        const sweep = createStaleSweep({ store, clock })
        expect((await sweep.sweep()).flagged).toEqual([])
        expect(store.updateTask).not.toHaveBeenCalled()
        // a change (new updated_at) re-arms it
        store.map.get(1).updated_at = "2026-11-02T12:00:00.000Z"
        expect((await sweep.sweep()).flagged.map((t) => t.id)).toEqual([1])
    })

    test("re-checks under the lock and logs per-task failures", async () => {
        const clock = createFakeClock(NOW)
        const store = fakeStore([makeTask(1), makeTask(2)], clock)
        const log = { info: jest.fn(), warn: jest.fn() }
        // task 1 changed between the query and the lock
        store.getTask.mockImplementationOnce(async () => ({
            task: makeTask(1, { updated_at: NOW }),
            revision: "r",
        }))
        store.updateTask.mockImplementationOnce(async () => {
            throw new Error("conflict")
        })
        store.listEvents.mockResolvedValueOnce(null)
        const sweep = createStaleSweep({ store, clock, log })
        const res = await sweep.sweep()
        expect(res.flagged).toEqual([])
        expect(log.warn).toHaveBeenCalledWith(
            { task_id: 2, err: "conflict" },
            "stale flag failed"
        )
        expect(log.info).not.toHaveBeenCalled()
    })

    test("updateTask without a task in the result keeps the old data", async () => {
        const clock = createFakeClock(NOW)
        const store = fakeStore([makeTask(1)], clock)
        store.updateTask.mockResolvedValueOnce(undefined)
        const res = await createStaleSweep({ store, clock }).sweep()
        expect(res.flagged).toEqual([
            { id: 1, title: "Task 1", status: "ready", days: 7 },
        ])
        expect(store.events.get(1)[0].data.updated_at).toBe(OLD)
    })

    test("defaults: system clock and no settings", async () => {
        const store = fakeStore(
            [makeTask(1, { updated_at: "2020-01-01T00:00:00.000Z" })],
            createFakeClock(NOW)
        )
        const res = await createStaleSweep({ store }).sweep()
        expect(res.days).toBe(7)
        expect(res.flagged.map((t) => t.id)).toEqual([1])
    })
})
