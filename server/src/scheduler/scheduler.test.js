/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { jest } from "@jest/globals"
import {
    createScheduler,
    MAX_STALE_ATTEMPTS,
    NO_WORKER_ERROR,
} from "./scheduler.js"
import * as schedulerIndex from "./index.js"
import { createFakeClock } from "../util/clock.js"
import { createBus } from "../events/bus.js"
import { openDb } from "../store/db.js"
import { createStore } from "../store/store.js"
import { createSchedulesRepo } from "../store/schedulesRepo.js"
import { createLockManager } from "../store/mutex.js"
import {
    NotFoundError,
    StaleRevisionError,
    ValidationError,
} from "../util/errors.js"

const T0 = "2026-11-07T12:00:00.000Z"
const PAST = "2026-11-07T11:00:00.000Z"
const FUTURE = "2026-11-07T13:00:00.000Z"

function createFakeSchedulesRepo(clock) {
    const rows = new Map()
    let seq = 0
    const copy = (r) => (r ? { ...r, payload: { ...r.payload } } : null)
    return {
        rows,
        add: jest.fn(({ task_id, fire_at, action, payload, note }) => {
            const row = {
                id: ++seq,
                task_id,
                fire_at,
                action,
                payload,
                status: "pending",
                note: note ?? null,
                created_at: clock.now().toISOString(),
                fired_at: null,
                error: null,
            }
            rows.set(row.id, row)
            return copy(row)
        }),
        get: jest.fn((id) => copy(rows.get(id))),
        listPending: jest.fn((dueBefore) =>
            [...rows.values()]
                .filter(
                    (r) =>
                        r.status === "pending" &&
                        (!dueBefore || r.fire_at <= dueBefore)
                )
                .map(copy)
        ),
        listForTask: jest.fn((taskId) =>
            [...rows.values()].filter((r) => r.task_id === taskId).map(copy)
        ),
        markFired: jest.fn((id) => {
            const r = rows.get(id)
            r.status = "fired"
            r.fired_at = clock.now().toISOString()
        }),
        markFailed: jest.fn((id, error) => {
            const r = rows.get(id)
            r.status = "failed"
            r.error = error
        }),
        cancel: jest.fn((id) => {
            rows.get(id).status = "cancelled"
        }),
    }
}

function makeTask(id, over = {}) {
    return {
        id,
        title: `Task ${id}`,
        // due reminders only fire for the task's current due date
        due_at: PAST,
        status: "waiting",
        prev_status: "active",
        snooze_until: PAST,
        flags: { enriching: false, now: false, now_reason: null, error: null },
        ...over,
    }
}

function createFakeStore(tasks = []) {
    const map = new Map(tasks.map((t) => [t.id, { task: t, rev: 1 }]))
    return {
        map,
        getTask: jest.fn(async (id) => {
            const e = map.get(id)
            if (!e) throw new NotFoundError(`task ${id}`)
            return { task: structuredClone(e.task), revision: `r${e.rev}` }
        }),
        updateTask: jest.fn(async (id, patch, { baseRevision } = {}) => {
            const e = map.get(id)
            if (baseRevision && baseRevision !== `r${e.rev}`) {
                throw new StaleRevisionError({ task: e.task })
            }
            e.task = { ...e.task, ...patch }
            e.rev++
            return { task: structuredClone(e.task), revision: `r${e.rev}` }
        }),
    }
}

function setup({ tasks = [makeTask(1)], ...over } = {}) {
    const clock = createFakeClock(T0)
    const bus = createBus({ clock })
    const events = []
    bus.subscribe((e) => events.push(e))
    const schedulesRepo = createFakeSchedulesRepo(clock)
    const store = createFakeStore(tasks)
    const notifier = { notify: jest.fn(async () => true) }
    const jobRunner = { enqueue: jest.fn(() => ({ id: "j1" })) }
    const log = { debug() {}, info() {}, warn: jest.fn(), error: jest.fn() }
    const deps = {
        schedulesRepo,
        store,
        bus,
        notifier,
        jobRunner,
        clock,
        log,
        tickMs: 1000,
        ...over,
    }
    const scheduler = createScheduler(deps)
    return { ...deps, events, scheduler }
}

const scheduleEvents = (events) =>
    events.filter((e) => e.type === "schedule.updated")

describe("index", () => {
    test("re-exports the factories", () => {
        expect(schedulerIndex.createScheduler).toBe(createScheduler)
        expect(typeof schedulerIndex.createDateParser).toBe("function")
        expect(typeof schedulerIndex.createNotifier).toBe("function")
    })
})

describe("add / cancel / listForTask", () => {
    test("add validates, stores and emits", async () => {
        const { scheduler, events, schedulesRepo } = setup()
        const s = await scheduler.add({
            task_id: 1,
            fire_at: FUTURE,
            action: "surface",
            note: "ping",
        })
        expect(s).toMatchObject({
            id: 1,
            task_id: 1,
            action: "surface",
            status: "pending",
            note: "ping",
            payload: {},
        })
        expect(schedulesRepo.add).toHaveBeenCalledWith({
            task_id: 1,
            fire_at: FUTURE,
            action: "surface",
            payload: {},
            note: "ping",
        })
        expect(scheduleEvents(events)).toEqual([
            expect.objectContaining({ task_id: 1, data: { schedule: s } }),
        ])
    })

    test("add accepts Date fire_at and null task_id", async () => {
        const { scheduler, events } = setup()
        const s = await scheduler.add({
            fire_at: new Date(FUTURE),
            action: "center_job",
            payload: { job_type: "x" },
        })
        expect(s.fire_at).toBe(FUTURE)
        expect(s.task_id).toBeNull()
        expect(s.note).toBeNull()
        expect(scheduleEvents(events)[0].task_id).toBeNull()
    })

    test("add rejects invalid input", async () => {
        const { scheduler } = setup()
        await expect(
            scheduler.add({ task_id: 1, fire_at: "soon", action: "surface" })
        ).rejects.toThrow(ValidationError)
        await expect(
            scheduler.add({ task_id: 1, fire_at: FUTURE, action: "explode" })
        ).rejects.toThrow(ValidationError)
        await expect(
            scheduler.add({
                task_id: 1,
                fire_at: FUTURE,
                action: "surface",
                note: 5,
            })
        ).rejects.toThrow(ValidationError)
        await expect(scheduler.add()).rejects.toThrow(ValidationError)
    })

    test("cancel marks pending schedules cancelled and emits", async () => {
        const { scheduler, events } = setup()
        const s = await scheduler.add({
            task_id: 1,
            fire_at: FUTURE,
            action: "surface",
        })
        const c = await scheduler.cancel(s.id)
        expect(c.status).toBe("cancelled")
        expect(scheduleEvents(events)).toHaveLength(2)
        // cancelling again is a no-op
        const again = await scheduler.cancel(s.id)
        expect(again.status).toBe("cancelled")
        expect(scheduleEvents(events)).toHaveLength(2)
    })

    test("cancel of an unknown schedule throws NotFoundError", async () => {
        const { scheduler } = setup()
        await expect(scheduler.cancel(99)).rejects.toThrow(NotFoundError)
    })

    test("cancel falls back to a patched copy if get returns nothing", async () => {
        const { scheduler, schedulesRepo } = setup()
        const s = await scheduler.add({
            task_id: 1,
            fire_at: FUTURE,
            action: "surface",
        })
        schedulesRepo.get
            .mockImplementationOnce((id) => ({ ...s, id }))
            .mockImplementationOnce(() => null)
        const c = await scheduler.cancel(s.id)
        expect(c).toMatchObject({ id: s.id, status: "cancelled" })
    })

    test("listForTask proxies the repo", async () => {
        const { scheduler, schedulesRepo } = setup()
        await scheduler.add({ task_id: 1, fire_at: FUTURE, action: "surface" })
        await scheduler.add({ task_id: 2, fire_at: FUTURE, action: "surface" })
        expect(await scheduler.listForTask(1)).toHaveLength(1)
        schedulesRepo.listForTask.mockReturnValueOnce(undefined)
        expect(await scheduler.listForTask(1)).toEqual([])
    })
})

describe("remind", () => {
    test("schedules a surface action", async () => {
        const { scheduler } = setup()
        const s = await scheduler.remind(1, FUTURE)
        expect(s).toMatchObject({
            task_id: 1,
            action: "surface",
            fire_at: FUTURE,
            payload: { due: true },
            note: null,
        })
    })

    test("accepts a Date, note and reason", async () => {
        const { scheduler } = setup()
        const s = await scheduler.remind(1, new Date(FUTURE), {
            note: "n",
            reason: "Check CI",
        })
        expect(s).toMatchObject({
            fire_at: FUTURE,
            note: "n",
            payload: { reason: "Check CI", due: true },
        })
    })

    test("re-uses an identical pending reminder", async () => {
        const { scheduler, schedulesRepo } = setup()
        const a = await scheduler.remind(1, FUTURE)
        const b = await scheduler.remind(1, "2026-11-07T14:00:00+01:00")
        expect(b.id).toBe(a.id)
        expect(schedulesRepo.add).toHaveBeenCalledTimes(1)
        await scheduler.cancel(a.id)
        const c = await scheduler.remind(1, FUTURE)
        expect(c.id).not.toBe(a.id)
    })
})

describe("remind keeps due reminders apart from follow-ups", () => {
    test("a follow-up at the same time is not reused", async () => {
        const { scheduler } = setup()
        const follow = await scheduler.add({
            task_id: 1,
            fire_at: FUTURE,
            action: "surface",
            payload: { reason: "Check PR" },
        })
        const snooze = await scheduler.add({
            task_id: 1,
            fire_at: FUTURE,
            action: "surface",
            payload: { snooze: true, due: true },
        })
        const due = await scheduler.remind(1, FUTURE)
        expect([follow.id, snooze.id]).not.toContain(due.id)
        // cancelling the follow-up leaves the due reminder pending
        await scheduler.cancel(follow.id)
        const moved = await scheduler.reconcileDue(1, FUTURE)
        expect(moved.id).toBe(due.id)
    })
})

describe("firing vs cancelling under the task lock", () => {
    const tick = () => new Promise((r) => setImmediate(r))
    function locked() {
        const ctx = setup()
        const locks = createLockManager()
        ctx.store.withTaskLock = (id, fn) => locks.withLock(id, fn)
        let release
        const held = locks.withLock(1, () => new Promise((r) => (release = r)))
        return { ...ctx, held, release: () => release() }
    }

    test("cancelled (even behind the scheduler's back) while waiting: never fires", async () => {
        const ctx = locked()
        const s = await ctx.scheduler.remind(1, PAST)
        const firing = ctx.scheduler.tick()
        await tick()
        await ctx.schedulesRepo.cancel(s.id) // e.g. a cancel that won the race
        ctx.release()
        await ctx.held
        expect(await firing).toBe(0)
        expect(ctx.store.updateTask).not.toHaveBeenCalled()
        expect(ctx.notifier.notify).not.toHaveBeenCalled()
        expect((await ctx.schedulesRepo.get(s.id)).status).toBe("cancelled")
    })

    test("cancel queued before the firing wins", async () => {
        const ctx = locked()
        const s = await ctx.scheduler.remind(1, PAST)
        const cancelling = ctx.scheduler.cancel(s.id)
        await tick()
        const firing = ctx.scheduler.tick()
        await tick()
        ctx.release()
        await ctx.held
        expect((await cancelling).status).toBe("cancelled")
        expect(await firing).toBe(0)
        expect(ctx.store.updateTask).not.toHaveBeenCalled()
    })

    test("a firing queued before the cancel completes; the cancel sees it fired", async () => {
        const ctx = locked()
        const s = await ctx.scheduler.remind(1, PAST)
        const firing = ctx.scheduler.tick()
        await tick()
        const cancelling = ctx.scheduler.cancel(s.id)
        ctx.release()
        await ctx.held
        expect(await firing).toBe(1)
        expect((await cancelling).status).toBe("fired")
        expect(ctx.store.updateTask).toHaveBeenCalledTimes(1)
    })

    test("clearing the due date while a firing waits for the lock: no surface", async () => {
        const ctx = locked()
        const s = await ctx.scheduler.remind(1, PAST)
        const firing = ctx.scheduler.tick()
        await tick()
        // PATCH due_at=null lands first (it held / took the lock)...
        await ctx.store.updateTask(1, { due_at: null })
        ctx.release()
        await ctx.held
        expect(await firing).toBe(0)
        // ...then reconcileDue runs; nothing is left to cancel or fire
        expect(await ctx.scheduler.reconcileDue(1, null)).toBeNull()
        const { task } = await ctx.store.getTask(1)
        expect(task.flags.now).toBe(false)
        expect(task.status).toBe("waiting")
        expect((await ctx.schedulesRepo.get(s.id)).status).toBe("cancelled")
        expect(ctx.notifier.notify).not.toHaveBeenCalled()
    })

    test("a due reminder for an old due date is skipped and cancelled", async () => {
        const { scheduler, store, schedulesRepo } = setup({
            tasks: [makeTask(1, { due_at: "2026-11-20T09:00:00.000Z" })],
        })
        const s = await scheduler.remind(1, PAST)
        expect(await scheduler.tick()).toBe(0)
        expect(store.updateTask).not.toHaveBeenCalled()
        expect((await schedulesRepo.get(s.id)).status).toBe("cancelled")
    })
})

describe("reconcileDue", () => {
    const LATER = "2026-11-20T09:00:00.000Z"
    const pending = async (scheduler, id = 1) =>
        (await scheduler.listForTask(id)).filter(
            (s) => !s.status || s.status === "pending"
        )

    test("moves the due reminder, keeps follow-ups and snoozes", async () => {
        const { scheduler } = setup()
        const due = await scheduler.remind(1, FUTURE)
        const follow = await scheduler.add({
            task_id: 1,
            fire_at: FUTURE,
            action: "surface",
            payload: { reason: "check PR" },
        })
        const snooze = await scheduler.add({
            task_id: 1,
            fire_at: FUTURE,
            action: "surface",
            payload: { snooze: true },
        })
        const res = await scheduler.reconcileDue(1, LATER)
        expect(res).toMatchObject({ fire_at: LATER, payload: { due: true } })
        const ids = (await pending(scheduler)).map((s) => s.id).sort()
        expect(ids).toEqual([follow.id, snooze.id, res.id].sort())
        expect(ids).not.toContain(due.id)
    })

    test("a follow-up at the old due time is not a due reminder", async () => {
        const { scheduler } = setup()
        await scheduler.remind(1, FUTURE)
        const follow = await scheduler.add({
            task_id: 1,
            fire_at: FUTURE,
            action: "surface",
            payload: { reason: "Check PR" },
            note: "Check PR",
        })
        await scheduler.reconcileDue(1, LATER)
        const left = await pending(scheduler)
        expect(left.map((s) => [s.id === follow.id, s.fire_at])).toEqual([
            [true, FUTURE],
            [false, LATER],
        ])
    })

    test("clearing the due date cancels it; same date keeps it", async () => {
        const { scheduler } = setup()
        const due = await scheduler.remind(1, FUTURE)
        expect((await scheduler.reconcileDue(1, FUTURE)).id).toBe(due.id)
        expect(
            await scheduler.reconcileDue(1, null, { ensure: true })
        ).toBeNull()
        expect(await pending(scheduler)).toEqual([])
    })

    test("creates one only for reminders (ensure) and only in the future", async () => {
        const { scheduler } = setup()
        expect(await scheduler.reconcileDue(1, LATER)).toBeNull()
        expect(
            await scheduler.reconcileDue(1, PAST, { ensure: true })
        ).toBeNull()
        expect(await pending(scheduler)).toEqual([])
        const made = await scheduler.reconcileDue(1, LATER, { ensure: true })
        expect(made).toMatchObject({ fire_at: LATER })
        // duplicates of the same instant: one kept, the other cancelled
        await scheduler.add({
            task_id: 1,
            fire_at: LATER,
            action: "surface",
            payload: { due: true },
        })
        await scheduler.reconcileDue(1, LATER)
        expect(await pending(scheduler)).toHaveLength(1)
    })
})

describe("tick: surface", () => {
    test("surfaces a waiting task: flags.now, prev_status, snooze cleared", async () => {
        const { scheduler, store, notifier, events, schedulesRepo } = setup()
        const s = await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "surface",
            note: "Talk to Ron",
        })
        expect(await scheduler.tick()).toBe(1)
        const task = store.map.get(1).task
        expect(task.status).toBe("active")
        expect(task.snooze_until).toBeNull()
        expect(task.flags).toEqual({
            enriching: false,
            now: true,
            now_reason: "Talk to Ron",
            error: null,
        })
        expect(store.updateTask).toHaveBeenCalledWith(
            1,
            expect.any(Object),
            expect.objectContaining({ actor: "system", baseRevision: "r1" })
        )
        expect(notifier.notify).toHaveBeenCalledWith({
            title: "Talk to Ron",
            body: "T-1 Task 1",
            sound: "request",
        })
        expect(schedulesRepo.rows.get(s.id).status).toBe("fired")
        const last = scheduleEvents(events).at(-1)
        expect(last.data.schedule).toMatchObject({ id: s.id, status: "fired" })
    })

    test("payload.reason wins; default reason is 'Reminder'", async () => {
        const { scheduler, store } = setup({
            tasks: [makeTask(1), makeTask(2)],
        })
        await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "surface",
            payload: { reason: "R!" },
            note: "n",
        })
        await scheduler.add({ task_id: 2, fire_at: PAST, action: "surface" })
        expect(await scheduler.tick()).toBe(2)
        expect(store.map.get(1).task.flags.now_reason).toBe("R!")
        expect(store.map.get(2).task.flags.now_reason).toBe("Reminder")
    })

    test("waiting without usable prev_status goes to ready", async () => {
        const prevs = [null, "waiting", "done", "cancelled", "bogus"]
        const { scheduler, store } = setup({
            tasks: prevs.map((prev_status, i) =>
                makeTask(i + 1, { prev_status })
            ),
        })
        for (let id = 1; id <= prevs.length; id++) {
            await scheduler.remind(id, PAST)
        }
        expect(await scheduler.tick()).toBe(prevs.length)
        // never reopens into a closed status, even though waiting -> done
        // is a legal transition
        for (let id = 1; id <= prevs.length; id++) {
            expect(store.map.get(id).task.status).toBe("ready")
        }
    })

    test.each([
        "inbox",
        "ready",
        "active",
        "ready_for_pr",
        "pr_open",
        "pr_feedback",
        "review",
    ])("restores open prev_status %s", async (prev_status) => {
        const { scheduler, store } = setup({
            tasks: [makeTask(1, { prev_status })],
        })
        await scheduler.remind(1, PAST)
        expect(await scheduler.tick()).toBe(1)
        expect(store.map.get(1).task.status).toBe(prev_status)
    })

    test("non-waiting task keeps its status", async () => {
        const { scheduler, store } = setup({
            tasks: [makeTask(1, { status: "active" })],
        })
        await scheduler.remind(1, PAST)
        await scheduler.tick()
        const call = store.updateTask.mock.calls[0][1]
        expect(call.status).toBeUndefined()
        expect(store.map.get(1).task.flags.now).toBe(true)
    })

    test("closed task: schedule is cancelled, nothing surfaced", async () => {
        const { scheduler, store, notifier, schedulesRepo, events } = setup({
            tasks: [makeTask(1, { status: "done" })],
        })
        const s = await scheduler.remind(1, PAST)
        expect(await scheduler.tick()).toBe(0)
        expect(store.updateTask).not.toHaveBeenCalled()
        expect(notifier.notify).not.toHaveBeenCalled()
        expect(schedulesRepo.rows.get(s.id).status).toBe("cancelled")
        expect(scheduleEvents(events).at(-1).data.schedule.status).toBe(
            "cancelled"
        )
    })

    test("a stale revision leaves the schedule pending for the next tick", async () => {
        const { scheduler, store, schedulesRepo, notifier, events, log } =
            setup()
        store.updateTask.mockImplementationOnce(async () => {
            throw new StaleRevisionError({})
        })
        const s = await scheduler.remind(1, PAST)
        const before = scheduleEvents(events).length
        expect(await scheduler.tick()).toBe(0)
        expect(schedulesRepo.rows.get(s.id).status).toBe("pending")
        expect(schedulesRepo.markFailed).not.toHaveBeenCalled()
        expect(notifier.notify).not.toHaveBeenCalled()
        expect(scheduleEvents(events)).toHaveLength(before)
        expect(log.warn).toHaveBeenCalledWith(
            { schedule_id: s.id, attempt: 1 },
            expect.any(String)
        )
        // next tick re-reads the task and succeeds
        expect(await scheduler.tick()).toBe(1)
        expect(schedulesRepo.rows.get(s.id).status).toBe("fired")
        expect(store.map.get(1).task.flags.now).toBe(true)
        expect(store.updateTask).toHaveBeenCalledTimes(2)
    })

    test(`fails after ${MAX_STALE_ATTEMPTS} consecutive stale revisions`, async () => {
        const { scheduler, store, schedulesRepo } = setup()
        store.updateTask.mockImplementation(async () => {
            throw new StaleRevisionError({})
        })
        const s = await scheduler.remind(1, PAST)
        for (let i = 1; i < MAX_STALE_ATTEMPTS; i++) {
            expect(await scheduler.tick()).toBe(0)
            expect(schedulesRepo.rows.get(s.id).status).toBe("pending")
        }
        expect(await scheduler.tick()).toBe(0)
        expect(schedulesRepo.rows.get(s.id)).toMatchObject({
            status: "failed",
            error: `task 1 kept changing: gave up after ${MAX_STALE_ATTEMPTS} stale revision conflicts`,
        })
        expect(store.updateTask).toHaveBeenCalledTimes(MAX_STALE_ATTEMPTS)
    })

    test("the stale counter resets after a success", async () => {
        const { scheduler, store, schedulesRepo } = setup({
            tasks: [makeTask(1), makeTask(2, { status: "active" })],
        })
        const stale = async () => {
            throw new StaleRevisionError({})
        }
        const a = await scheduler.remind(1, PAST)
        for (let i = 1; i < MAX_STALE_ATTEMPTS; i++) {
            store.updateTask.mockImplementationOnce(stale)
            await scheduler.tick()
        }
        expect(await scheduler.tick()).toBe(1)
        expect(schedulesRepo.rows.get(a.id).status).toBe("fired")
        // a schedule cancelled while retrying is forgotten as well
        const b = await scheduler.remind(2, PAST)
        store.updateTask.mockImplementationOnce(stale)
        await scheduler.tick()
        await scheduler.cancel(b.id)
        expect(await scheduler.tick()).toBe(0)
        expect(schedulesRepo.rows.get(b.id).status).toBe("cancelled")
    })

    test("runs the read-modify-write under store.withTaskLock", async () => {
        const { scheduler, store } = setup()
        const order = []
        store.withTaskLock = jest.fn(async (id, fn) => {
            order.push(`lock ${id}`)
            const res = await fn()
            order.push("unlock")
            return res
        })
        store.getTask.mockImplementationOnce(async (id) => {
            order.push("get")
            const e = store.map.get(id)
            return { task: structuredClone(e.task), revision: `r${e.rev}` }
        })
        const update = store.updateTask.getMockImplementation()
        store.updateTask.mockImplementationOnce(async (...args) => {
            order.push("update")
            return update(...args)
        })
        await scheduler.remind(1, PAST)
        expect(await scheduler.tick()).toBe(1)
        expect(order).toEqual(["lock 1", "get", "update", "unlock"])
    })

    test("missing task marks the schedule failed", async () => {
        const { scheduler, schedulesRepo } = setup()
        const s = await scheduler.remind(42, PAST)
        expect(await scheduler.tick()).toBe(0)
        expect(schedulesRepo.rows.get(s.id)).toMatchObject({
            status: "failed",
            error: "task 42 not found",
        })
    })

    test("surface without task_id fails", async () => {
        const { scheduler, schedulesRepo } = setup()
        const s = await scheduler.add({
            task_id: null,
            fire_at: PAST,
            action: "surface",
        })
        await scheduler.tick()
        expect(schedulesRepo.rows.get(s.id).error).toBe(
            "surface requires task_id"
        )
    })

    test("works without a notifier and with updateTask returning nothing", async () => {
        const { scheduler, store, schedulesRepo } = setup({ notifier: null })
        store.updateTask.mockImplementationOnce(async () => undefined)
        const s = await scheduler.remind(1, PAST)
        expect(await scheduler.tick()).toBe(1)
        expect(schedulesRepo.rows.get(s.id).status).toBe("fired")
    })

    test("reads payload_json when payload is not an object", async () => {
        const { scheduler, store, schedulesRepo } = setup({
            tasks: [makeTask(1), makeTask(2), makeTask(3)],
        })
        const mk = (task_id, payload_json) => {
            const s = schedulesRepo.add({
                task_id,
                fire_at: PAST,
                action: "surface",
                payload: null,
            })
            schedulesRepo.rows.get(s.id).payload_json = payload_json
        }
        mk(1, JSON.stringify({ reason: "from json" }))
        mk(2, "{not json")
        mk(3, "null")
        schedulesRepo.listPending.mockImplementationOnce(() =>
            [...schedulesRepo.rows.values()].map((r) => ({ ...r }))
        )
        expect(await scheduler.tick()).toBe(3)
        expect(store.map.get(1).task.flags.now_reason).toBe("from json")
        expect(store.map.get(2).task.flags.now_reason).toBe("Reminder")
        expect(store.map.get(3).task.flags.now_reason).toBe("Reminder")
    })
})

describe("tick: snooze schedules", () => {
    const snoozeAt = (task_id, fire_at, over = {}) => ({
        task_id,
        fire_at,
        action: "surface",
        payload: { reason: "Snooze ended", snooze: true },
        note: "snooze",
        ...over,
    })

    test("fires while the task is still snoozed until fire_at", async () => {
        const { scheduler, store, notifier, schedulesRepo } = setup({
            // same instant, different ISO spelling
            tasks: [makeTask(1, { snooze_until: "2026-11-07T03:00:00-08:00" })],
        })
        const s = await scheduler.add(snoozeAt(1, PAST))
        expect(await scheduler.tick()).toBe(1)
        expect(schedulesRepo.rows.get(s.id).status).toBe("fired")
        expect(store.map.get(1).task).toMatchObject({
            status: "active",
            snooze_until: null,
            flags: expect.objectContaining({
                now: true,
                now_reason: "Snooze ended",
            }),
        })
        expect(notifier.notify).toHaveBeenCalledTimes(1)
    })

    test.each([
        ["un-snoozed", { status: "active", snooze_until: null }],
        ["re-snoozed", { snooze_until: FUTURE }],
        ["waiting without a snooze", { snooze_until: null }],
        ["moved on but kept the date", { status: "review" }],
    ])("%s task: stale schedule is cancelled", async (_, over) => {
        const { scheduler, store, notifier, schedulesRepo, events } = setup({
            tasks: [makeTask(1, over)],
        })
        const before = structuredClone(store.map.get(1).task)
        const s = await scheduler.add(snoozeAt(1, PAST))
        expect(await scheduler.tick()).toBe(0)
        expect(store.updateTask).not.toHaveBeenCalled()
        expect(store.map.get(1).task).toEqual(before)
        expect(notifier.notify).not.toHaveBeenCalled()
        expect(schedulesRepo.rows.get(s.id).status).toBe("cancelled")
        expect(scheduleEvents(events).at(-1).data.schedule).toMatchObject({
            id: s.id,
            status: "cancelled",
        })
    })

    test("a 'snooze...' note marks a snooze schedule without the flag", async () => {
        const { scheduler, store, schedulesRepo } = setup({
            tasks: [
                makeTask(1, { status: "active", snooze_until: null }),
                makeTask(2, { status: "active", snooze_until: null }),
            ],
        })
        const a = await scheduler.add(
            snoozeAt(1, PAST, {
                payload: { reason: "Snooze ended" },
                note: "snooze (command)",
            })
        )
        const b = await scheduler.add(
            snoozeAt(2, PAST, { payload: {}, note: "Snoozed" })
        )
        expect(await scheduler.tick()).toBe(0)
        expect(schedulesRepo.rows.get(a.id).status).toBe("cancelled")
        expect(schedulesRepo.rows.get(b.id).status).toBe("cancelled")
        expect(store.updateTask).not.toHaveBeenCalled()
    })

    test("plain reminders fire when the task is not (or no longer) snoozed", async () => {
        const { scheduler, store, schedulesRepo } = setup({
            tasks: [
                makeTask(1, { status: "active", snooze_until: null }),
                // snooze already over (its own schedule not fired yet)
                makeTask(2, { snooze_until: PAST }),
                makeTask(3, { snooze_until: null }),
                makeTask(4, { snooze_until: "garbage" }),
            ],
        })
        const a = await scheduler.remind(1, PAST, { note: "Call Ron" })
        const b = await scheduler.remind(2, PAST)
        const c = await scheduler.remind(3, PAST)
        const d = await scheduler.remind(4, PAST)
        expect(await scheduler.tick()).toBe(4)
        for (const s of [a, b, c, d])
            expect(schedulesRepo.rows.get(s.id).status).toBe("fired")
        expect(store.map.get(1).task.flags.now_reason).toBe("Call Ron")
        expect(store.map.get(2).task.status).toBe("active")
        expect(store.map.get(3).task.status).toBe("active")
    })

    test("a plain reminder inside an active snooze is cancelled, task stays snoozed", async () => {
        const { scheduler, store, notifier, schedulesRepo } = setup({
            tasks: [makeTask(1, { snooze_until: FUTURE })],
        })
        const before = structuredClone(store.map.get(1).task)
        const r = await scheduler.remind(1, PAST)
        const snoozeEnd = await scheduler.add(snoozeAt(1, FUTURE))
        expect(await scheduler.tick()).toBe(0)
        expect(schedulesRepo.rows.get(r.id).status).toBe("cancelled")
        expect(store.updateTask).not.toHaveBeenCalled()
        expect(store.map.get(1).task).toEqual(before)
        expect(notifier.notify).not.toHaveBeenCalled()
        // the snooze-end schedule still surfaces the task later
        expect(schedulesRepo.rows.get(snoozeEnd.id).status).toBe("pending")
    })
})

describe("tick: surface with the real store", () => {
    let root
    let db

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sched-"))
        db = openDb(":memory:")
    })

    afterEach(() => {
        db.close()
        fs.rmSync(root, { recursive: true, force: true })
    })

    function real() {
        const clock = createFakeClock(T0)
        const bus = createBus({ clock })
        const store = createStore({
            tasksDir: path.join(root, "tasks"),
            db,
            bus,
            clock,
        })
        const schedulesRepo = createSchedulesRepo(db, { clock })
        const notifier = { notify: jest.fn(async () => true) }
        const scheduler = createScheduler({
            schedulesRepo,
            store,
            bus,
            clock,
            notifier,
        })
        return { clock, store, schedulesRepo, notifier, scheduler }
    }

    test("a concurrent write does not make the surface go stale", async () => {
        const { store, schedulesRepo, scheduler } = real()
        const { task } = await store.createTask(
            { title: "Real", status: "active" },
            "me"
        )
        await store.updateTask(
            task.id,
            { status: "waiting", snooze_until: PAST },
            { actor: "me" }
        )
        const s = await scheduler.add({
            task_id: task.id,
            fire_at: PAST,
            action: "surface",
            payload: { reason: "Snooze ended", snooze: true },
        })
        // Pause the surface right after its read, then let another writer
        // (outside the lock context) race it: it must queue on the task
        // lock instead of making the surface's write stale.
        const getTask = store.getTask
        let entered
        const inside = new Promise((r) => (entered = r))
        let release
        const gate = new Promise((r) => (release = r))
        store.getTask = async (id) => {
            const cur = await getTask(id)
            entered()
            await gate
            return cur
        }
        const ticking = scheduler.tick()
        await inside
        store.getTask = getTask
        const racing = store.updateTask(
            task.id,
            { area: "web" },
            { actor: "me" }
        )
        release()
        expect(await ticking).toBe(1)
        await racing
        expect(schedulesRepo.get(s.id).status).toBe("fired")
        const after = (await store.getTask(task.id)).task
        expect(after).toMatchObject({
            status: "active",
            snooze_until: null,
            area: "web",
        })
        expect(after.flags.now).toBe(true)
    })

    test("un-snoozed task: stale snooze schedule is cancelled", async () => {
        const { store, schedulesRepo, scheduler, notifier } = real()
        const { task } = await store.createTask(
            { title: "Real", status: "active" },
            "me"
        )
        await store.updateTask(
            task.id,
            { status: "waiting", snooze_until: PAST },
            { actor: "me" }
        )
        const s = await scheduler.add({
            task_id: task.id,
            fire_at: PAST,
            action: "surface",
            payload: { reason: "Snooze ended", snooze: true },
        })
        await store.updateTask(
            task.id,
            { status: "active", snooze_until: null },
            { actor: "me" }
        )
        expect(await scheduler.tick()).toBe(0)
        expect(schedulesRepo.get(s.id).status).toBe("cancelled")
        expect((await store.getTask(task.id)).task.flags.now).toBe(false)
        expect(notifier.notify).not.toHaveBeenCalled()
    })
})

describe("tick: other actions", () => {
    test("center_job enqueues on the job runner", async () => {
        const { scheduler, jobRunner, schedulesRepo } = setup()
        const s = await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "center_job",
            payload: { job_type: "followup", input: { pr: 812 } },
        })
        const t = await scheduler.add({
            task_id: null,
            fire_at: PAST,
            action: "center_job",
            payload: { job_type: "command" },
        })
        expect(await scheduler.tick()).toBe(2)
        expect(jobRunner.enqueue).toHaveBeenCalledWith(
            "followup",
            { pr: 812 },
            { task_id: 1 }
        )
        expect(jobRunner.enqueue).toHaveBeenCalledWith(
            "command",
            {},
            { task_id: null }
        )
        expect(schedulesRepo.rows.get(s.id).status).toBe("fired")
        expect(schedulesRepo.rows.get(t.id).status).toBe("fired")
    })

    test("center_job without job_type or job runner fails", async () => {
        const a = setup()
        const s = await a.scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "center_job",
        })
        await a.scheduler.tick()
        expect(a.schedulesRepo.rows.get(s.id).error).toBe(
            "center_job requires payload.job_type"
        )

        const b = setup({ jobRunner: null })
        const t = await b.scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "center_job",
            payload: { job_type: "x" },
        })
        await b.scheduler.tick()
        expect(b.schedulesRepo.rows.get(t.id).error).toBe(
            "job runner not available"
        )
    })

    test.each(["prompt_agent", "launch_agent"])(
        "%s without a worker service is marked failed",
        async (action) => {
            const { scheduler, schedulesRepo, events } = setup()
            const s = await scheduler.add({
                task_id: 1,
                fire_at: PAST,
                action,
                payload: { prompt: "check CI" },
            })
            expect(await scheduler.tick()).toBe(0)
            expect(schedulesRepo.rows.get(s.id)).toMatchObject({
                status: "failed",
                error: NO_WORKER_ERROR,
            })
            expect(scheduleEvents(events).at(-1).data.schedule).toMatchObject({
                status: "failed",
                error: NO_WORKER_ERROR,
            })
        }
    )

    test("prompt_agent delivers through the worker service", async () => {
        const workerService = {
            deliver: jest.fn(async () => ({ status: "queued" })),
            revive: jest.fn(),
        }
        const { scheduler, schedulesRepo, events } = setup({ workerService })
        const s = await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "prompt_agent",
            payload: { prompt: "  check PR comments  " },
        })
        expect(await scheduler.tick()).toBe(1)
        expect(workerService.deliver).toHaveBeenCalledWith(
            1,
            "check PR comments",
            { reason: "follow-up", dedupeKey: `sched-${s.id}` }
        )
        expect(schedulesRepo.rows.get(s.id).status).toBe("fired")
        expect(scheduleEvents(events).at(-1).data.schedule.status).toBe("fired")
    })

    test.each([
        [
            "prompt_agent",
            "deliver",
            { status: "failed", error: "pane gone" },
            "prompt not delivered (failed): pane gone",
        ],
        [
            "prompt_agent",
            "deliver",
            { status: "uncertain" },
            "prompt not delivered (uncertain)",
        ],
        [
            "launch_agent",
            "revive",
            { status: "uncertain", error: "socket" },
            "prompt not delivered (uncertain): socket",
        ],
    ])(
        "%s: a %s result that did not get through fails the schedule",
        async (action, fn, result, message) => {
            const workerService = {
                deliver: jest.fn(async () => result),
                revive: jest.fn(async () => result),
            }
            const { scheduler, schedulesRepo } = setup({ workerService })
            const s = await scheduler.add({
                task_id: 1,
                fire_at: PAST,
                action,
                payload: { prompt: "check PR comments" },
            })
            expect(await scheduler.tick()).toBe(0)
            const row = schedulesRepo.rows.get(s.id)
            expect(row.status).toBe("failed")
            expect(row.error).toBe(message)
            // not retried automatically
            await scheduler.tick()
            expect(workerService[fn]).toHaveBeenCalledTimes(1)
        }
    )

    test("launch_agent: a stalled revive (prompt never started) fails the schedule", async () => {
        // the shape a fresh revive returns when herdr saw no activity
        const workerService = {
            deliver: jest.fn(),
            revive: jest.fn(async () => ({
                session: { id: 3 },
                revived: true,
                resumed: true,
                delivery: "stalled",
                status: "stalled",
            })),
        }
        const { scheduler, schedulesRepo } = setup({ workerService })
        const s = await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "launch_agent",
            payload: { prompt: "continue" },
        })
        expect(await scheduler.tick()).toBe(0)
        const row = schedulesRepo.rows.get(s.id)
        expect(row.status).toBe("failed")
        expect(row.error).toBe("prompt not delivered (stalled)")
    })

    test("prompt_agent: a blocked agent keeps the prompt queued (fired)", async () => {
        const workerService = {
            deliver: jest.fn(async () => ({ status: "blocked" })),
            revive: jest.fn(),
        }
        const { scheduler, schedulesRepo } = setup({ workerService })
        const s = await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "prompt_agent",
            payload: { prompt: "x" },
        })
        expect(await scheduler.tick()).toBe(1)
        expect(schedulesRepo.rows.get(s.id).status).toBe("fired")
    })

    test("prompt_agent needs a prompt and a task", async () => {
        const workerService = { deliver: jest.fn(), revive: jest.fn() }
        const { scheduler, schedulesRepo } = setup({ workerService })
        const a = await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "prompt_agent",
            payload: { prompt: "   " },
        })
        const b = await scheduler.add({
            task_id: null,
            fire_at: PAST,
            action: "prompt_agent",
            payload: { prompt: "x" },
        })
        expect(await scheduler.tick()).toBe(0)
        expect(schedulesRepo.rows.get(a.id).error).toBe(
            "prompt_agent requires payload.prompt"
        )
        expect(schedulesRepo.rows.get(b.id).error).toBe(
            "prompt_agent requires task_id"
        )
        expect(workerService.deliver).not.toHaveBeenCalled()
    })

    test("launch_agent revives with the prompt as the action", async () => {
        const workerService = {
            deliver: jest.fn(),
            revive: jest.fn(async () => ({ session: {} })),
        }
        const { scheduler, schedulesRepo } = setup()
        // bound late, like system.js does
        scheduler.setWorkerService(workerService)
        const a = await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "launch_agent",
            payload: { prompt: "resume the migration" },
        })
        const b = await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "launch_agent",
        })
        expect(await scheduler.tick()).toBe(2)
        expect(workerService.revive).toHaveBeenNthCalledWith(1, 1, {
            action: "resume the migration",
        })
        expect(workerService.revive).toHaveBeenNthCalledWith(2, 1, {})
        expect(schedulesRepo.rows.get(a.id).status).toBe("fired")
        expect(schedulesRepo.rows.get(b.id).status).toBe("fired")
    })

    test.each(["prompt_agent", "launch_agent"])(
        "%s for a task closed before it fires is cancelled, not run",
        async (action) => {
            const workerService = {
                deliver: jest.fn(async () => ({ status: "sent" })),
                revive: jest.fn(async () => ({ status: "sent" })),
            }
            const { scheduler, schedulesRepo, store } = setup({
                tasks: [makeTask(1), makeTask(2)],
                workerService,
            })
            const s1 = await scheduler.add({
                task_id: 1,
                fire_at: PAST,
                action,
                payload: { prompt: "resume" },
            })
            const s2 = await scheduler.add({
                task_id: 2,
                fire_at: PAST,
                action,
                payload: { prompt: "resume" },
            })
            store.map.get(1).task.status = "done"
            store.map.get(2).task.status = "cancelled"
            expect(await scheduler.tick()).toBe(0)
            expect(workerService.deliver).not.toHaveBeenCalled()
            expect(workerService.revive).not.toHaveBeenCalled()
            expect(schedulesRepo.rows.get(s1.id).status).toBe("cancelled")
            expect(schedulesRepo.rows.get(s2.id).status).toBe("cancelled")
        }
    )

    test("launch_agent: a revive skipped because the task closed meanwhile cancels the schedule", async () => {
        const workerService = {
            deliver: jest.fn(),
            revive: jest.fn(async () => ({
                skipped: true,
                status: "skipped",
                reason: "task is done",
            })),
        }
        const { scheduler, schedulesRepo } = setup({ workerService })
        const s = await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "launch_agent",
        })
        expect(await scheduler.tick()).toBe(0)
        expect(workerService.revive).toHaveBeenCalledTimes(1)
        expect(schedulesRepo.rows.get(s.id).status).toBe("cancelled")
    })

    test("worker errors mark the schedule failed", async () => {
        const workerService = {
            deliver: jest.fn(),
            revive: jest.fn(async () => {
                throw new Error("herdr down")
            }),
        }
        const { scheduler, schedulesRepo } = setup({ workerService })
        const s = await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "launch_agent",
        })
        expect(await scheduler.tick()).toBe(0)
        expect(schedulesRepo.rows.get(s.id)).toMatchObject({
            status: "failed",
            error: "herdr down",
        })
        scheduler.setWorkerService(null)
        const t = await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "launch_agent",
        })
        await scheduler.tick()
        expect(schedulesRepo.rows.get(t.id).error).toBe(NO_WORKER_ERROR)
    })

    test("unknown action from the repo fails", async () => {
        const { scheduler, schedulesRepo } = setup()
        const s = schedulesRepo.add({
            task_id: 1,
            fire_at: PAST,
            action: "dance",
            payload: {},
        })
        await scheduler.tick()
        expect(schedulesRepo.rows.get(s.id).error).toBe("unknown action: dance")
    })
})

describe("tick: robustness", () => {
    test("only fires due schedules, in fire_at order", async () => {
        const { scheduler, jobRunner, clock } = setup()
        const mk = (fire_at, job_type) =>
            scheduler.add({
                task_id: 1,
                fire_at,
                action: "center_job",
                payload: { job_type },
            })
        await mk(FUTURE, "later")
        await mk(T0, "now")
        await mk(PAST, "past")
        await mk(PAST, "past2")
        expect(await scheduler.tick()).toBe(3)
        expect(jobRunner.enqueue.mock.calls.map((c) => c[0])).toEqual([
            "past",
            "past2",
            "now",
        ])
        clock.set(FUTURE)
        expect(await scheduler.tick()).toBe(1)
        expect(await scheduler.tick()).toBe(0)
    })

    test("ignores repo rows that are not due or not pending", async () => {
        const { scheduler, schedulesRepo, jobRunner } = setup()
        schedulesRepo.listPending.mockImplementationOnce(() => [
            { id: 7, fire_at: FUTURE, action: "center_job", status: "pending" },
            { id: 8, fire_at: PAST, action: "center_job", status: "fired" },
        ])
        expect(await scheduler.tick()).toBe(0)
        expect(jobRunner.enqueue).not.toHaveBeenCalled()
        schedulesRepo.listPending.mockImplementationOnce(() => undefined)
        expect(await scheduler.tick()).toBe(0)
    })

    test("skips a schedule cancelled after listPending", async () => {
        const { scheduler, schedulesRepo, jobRunner } = setup()
        const s = await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "center_job",
            payload: { job_type: "x" },
        })
        const pending = schedulesRepo.listPending()
        schedulesRepo.rows.get(s.id).status = "cancelled"
        schedulesRepo.listPending.mockImplementationOnce(() => pending)
        expect(await scheduler.tick()).toBe(0)
        expect(jobRunner.enqueue).not.toHaveBeenCalled()
    })

    test("one failing schedule does not block others", async () => {
        const { scheduler, jobRunner, schedulesRepo } = setup()
        jobRunner.enqueue
            .mockImplementationOnce(() => {
                throw new Error("boom")
            })
            .mockImplementationOnce(() => {
                throw "plain string"
            })
        const ids = []
        for (const job_type of ["a", "b", "c"]) {
            const s = await scheduler.add({
                task_id: 1,
                fire_at: PAST,
                action: "center_job",
                payload: { job_type },
            })
            ids.push(s.id)
        }
        expect(await scheduler.tick()).toBe(1)
        expect(ids.map((id) => schedulesRepo.rows.get(id).status)).toEqual([
            "failed",
            "failed",
            "fired",
        ])
        expect(schedulesRepo.rows.get(ids[0]).error).toBe("boom")
        expect(schedulesRepo.rows.get(ids[1]).error).toBe("plain string")
    })

    test("markFired failure falls back to markFailed", async () => {
        const { scheduler, schedulesRepo } = setup()
        schedulesRepo.markFired.mockImplementationOnce(() => {
            throw new Error("db locked")
        })
        const s = await scheduler.remind(1, PAST)
        expect(await scheduler.tick()).toBe(0)
        expect(schedulesRepo.rows.get(s.id)).toMatchObject({
            status: "failed",
            error: "db locked",
        })
    })

    test("markFailed failure is logged, never thrown", async () => {
        const { scheduler, schedulesRepo, log } = setup()
        schedulesRepo.markFailed.mockImplementation(() => {
            throw new Error("db gone")
        })
        await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "launch_agent",
        })
        await expect(scheduler.tick()).resolves.toBe(0)
        expect(log.error).toHaveBeenCalled()
    })

    test("listPending failure returns 0", async () => {
        const { scheduler, schedulesRepo, log } = setup()
        schedulesRepo.listPending.mockImplementationOnce(() => {
            throw new Error("db gone")
        })
        await expect(scheduler.tick()).resolves.toBe(0)
        expect(log.error).toHaveBeenCalled()
    })

    test("unexpected internal failure is caught", async () => {
        const { scheduler, clock, log } = setup()
        clock.now = () => {
            throw new Error("clock broke")
        }
        await expect(scheduler.tick()).resolves.toBe(0)
        expect(log.error).toHaveBeenCalled()
    })

    test("overlapping ticks share one run", async () => {
        const { scheduler, jobRunner } = setup()
        let release
        jobRunner.enqueue.mockImplementationOnce(
            () => new Promise((r) => (release = r))
        )
        await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "center_job",
            payload: { job_type: "slow" },
        })
        const a = scheduler.tick()
        const b = scheduler.tick()
        expect(b).toBe(a)
        await new Promise((r) => setImmediate(r))
        release({ id: "j" })
        expect(await a).toBe(1)
        expect(jobRunner.enqueue).toHaveBeenCalledTimes(1)
        // after completion a new tick runs again
        expect(scheduler.tick()).not.toBe(a)
    })
})

describe("start / stop", () => {
    test("first tick fires missed schedules, then loops every tickMs", async () => {
        const { scheduler, clock, schedulesRepo } = setup()
        const missed = await scheduler.remind(1, PAST)
        schedulesRepo.listPending.mockClear()
        scheduler.start()
        scheduler.start() // idempotent
        expect(clock.pending()).toBe(1)
        await clock.advance(0)
        expect(schedulesRepo.rows.get(missed.id).status).toBe("fired")
        expect(schedulesRepo.listPending).toHaveBeenCalledTimes(1)

        await scheduler.add({
            task_id: 1,
            fire_at: "2026-11-07T12:00:02.500Z",
            action: "center_job",
            payload: { job_type: "x" },
        })
        await clock.advance(1000)
        expect(schedulesRepo.listPending).toHaveBeenCalledTimes(2)
        await clock.advance(2000)
        expect(schedulesRepo.listPending).toHaveBeenCalledTimes(4)
        expect(
            [...schedulesRepo.rows.values()].every((r) => r.status === "fired")
        ).toBe(true)

        await expect(scheduler.stop()).resolves.toBe(0)
        expect(clock.pending()).toBe(0)
        await clock.advance(5000)
        expect(schedulesRepo.listPending).toHaveBeenCalledTimes(4)
    })

    test("stop during an in-flight tick waits for it and does not reschedule", async () => {
        const { scheduler, clock, jobRunner } = setup()
        let release
        jobRunner.enqueue.mockImplementationOnce(
            () => new Promise((r) => (release = r))
        )
        await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "center_job",
            payload: { job_type: "slow" },
        })
        scheduler.start()
        const advancing = clock.advance(0)
        await new Promise((r) => setImmediate(r))
        const stopped = scheduler.stop()
        release({ id: "j" })
        await expect(stopped).resolves.toBe(1)
        await advancing
        expect(clock.pending()).toBe(0)
    })

    test("a timer firing after stop does nothing", async () => {
        const { scheduler, clock, schedulesRepo } = setup()
        const handlers = []
        clock.setTimeout = (fn) => {
            handlers.push(fn)
            return handlers.length
        }
        clock.clearTimeout = () => {}
        scheduler.start()
        await scheduler.stop()
        await handlers[0]()
        expect(schedulesRepo.listPending).not.toHaveBeenCalled()
    })

    test("uses defaults for optional deps", async () => {
        const bus = createBus()
        const clock = createFakeClock(T0)
        const schedulesRepo = createFakeSchedulesRepo(clock)
        const scheduler = createScheduler({
            schedulesRepo,
            store: createFakeStore([makeTask(1)]),
            bus,
            clock,
        })
        await scheduler.add({
            task_id: 1,
            fire_at: PAST,
            action: "launch_agent",
        })
        expect(await scheduler.tick()).toBe(0)
        scheduler.start()
        await clock.advance(0)
        expect(clock.pending()).toBe(1)
        await clock.advance(15000)
        expect(schedulesRepo.listPending).toHaveBeenCalledTimes(3)
        await scheduler.stop()
    })
})
