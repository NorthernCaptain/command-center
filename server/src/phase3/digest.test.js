/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { createBus } from "../events/bus.js"
import { createFakeClock } from "../util/clock.js"
import {
    createDigest,
    DEFAULT_DIGEST_ENABLED,
    DEFAULT_DIGEST_TIME,
    localParts,
    summaryLine,
} from "./digest.js"
import { PHASE3_DEFAULTS } from "./defaults.js"

const TZ = "America/Los_Angeles"
// 2026-11-07 07:00 PST
const MORNING = "2026-11-07T15:00:00.000Z"
const FLAGS = { enriching: false, now: false, now_reason: null, error: null }
const STATE = "/data/digest.json"

function task(id, over = {}) {
    return {
        id,
        title: `Task ${id}`,
        kind: "todo",
        status: "ready",
        due_at: null,
        flags: { ...FLAGS },
        ...over,
    }
}

function fakeStore(tasks) {
    return {
        query: jest.fn(async ({ status, limit, offset }) => {
            const all = tasks.filter((t) => status.includes(t.status))
            return {
                tasks: all.slice(offset, offset + limit),
                total: all.length,
            }
        }),
    }
}

function memFs(files = {}) {
    const data = new Map(Object.entries(files))
    return {
        data,
        mkdirSync: jest.fn(),
        readFileSync: jest.fn((p) => {
            if (!data.has(p))
                throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
            return data.get(p)
        }),
        writeFileSync: jest.fn((p, text) => data.set(p, text)),
        renameSync: jest.fn((a, b) => {
            data.set(b, data.get(a))
            data.delete(a)
        }),
    }
}

function settingsOf(values = {}) {
    return {
        values,
        get: jest.fn(async (k, d) => (k in values ? values[k] : d)),
    }
}

function setup({ tasks = [], settings = {}, ...over } = {}) {
    const clock = createFakeClock(MORNING)
    const bus = createBus({ clock })
    const busEvents = []
    bus.subscribe((e) => busEvents.push(e))
    const notifier = { notify: jest.fn(async () => true) }
    const staleSweep = { sweep: jest.fn(async () => ({ flagged: [] })) }
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const fs = memFs()
    const settingsRepo = settingsOf(settings)
    const deps = {
        store: fakeStore(tasks),
        settingsRepo,
        notifier,
        bus,
        staleSweep,
        clock,
        log,
        timezone: TZ,
        stateFile: STATE,
        fs,
        checkMs: 60000,
        ...over,
    }
    const digest = createDigest(deps)
    return { ...deps, busEvents, digest }
}

describe("helpers", () => {
    test("defaults come from PHASE3_DEFAULTS", () => {
        expect(DEFAULT_DIGEST_TIME).toBe(PHASE3_DEFAULTS["digest.time"])
        expect(DEFAULT_DIGEST_TIME).toBe("08:30")
        expect(DEFAULT_DIGEST_ENABLED).toBe(true)
    })

    test("localParts is wall-clock time in the zone, across DST", () => {
        expect(localParts(new Date(MORNING), TZ)).toEqual({
            date: "2026-11-07",
            time: "07:00",
        })
        // fall back: 01:30 happens twice
        expect(localParts(new Date("2026-11-01T08:30:00Z"), TZ).time).toBe(
            "01:30"
        )
        expect(localParts(new Date("2026-11-01T09:30:00Z"), TZ).time).toBe(
            "01:30"
        )
        // spring forward: 02:00-03:00 does not exist
        expect(localParts(new Date("2026-03-08T10:00:00Z"), TZ).time).toBe(
            "03:00"
        )
        expect(localParts(new Date("2026-11-07T23:30:00Z"), "UTC")).toEqual({
            date: "2026-11-07",
            time: "23:30",
        })
    })

    test("summaryLine", () => {
        const empty = { now: [], prs: [], overdue: [], blocked: [], stale: [] }
        expect(summaryLine(empty)).toBe("Morning: all clear")
        expect(
            summaryLine({
                now: [1, 2, 3],
                prs: [1],
                overdue: [1, 2],
                blocked: [1, 2],
                stale: [1],
            })
        ).toBe("Morning: 3 in Now, 1 PR, 2 overdue, 2 blocked agents, 1 stale")
        expect(summaryLine({ ...empty, prs: [1, 2], blocked: [1] })).toBe(
            "Morning: 2 PRs, 1 blocked agent"
        )
    })
})

describe("buildDigest", () => {
    const tasks = [
        task(1, {
            flags: { ...FLAGS, now: true, now_reason: "Reminder" },
            due_at: "2026-11-06T10:00:00.000Z",
            kind: "reminder",
        }),
        task(2, { due_at: "2026-11-05T10:00:00.000Z" }),
        task(3, { due_at: "2026-11-09T10:00:00.000Z" }),
        task(4, { due_at: "bad" }),
        task(5, { status: "ready_for_pr" }),
        task(6, { status: "pr_feedback" }),
        task(7, {
            status: "pr_open",
            flags: {
                ...FLAGS,
                now: true,
                now_reason: "PR closed without merge",
            },
        }),
        task(8, {
            status: "active",
            flags: {
                ...FLAGS,
                now: true,
                now_reason: "Stale: no change in 7 days",
            },
        }),
        task(9, {
            status: "active",
            flags: { ...FLAGS, now: false, now_reason: "Stale: old" },
        }),
        task(10, { status: "done", flags: { ...FLAGS, now: true } }),
        task(11, { flags: null }),
    ]

    test("collects Now, overdue, PRs, blocked agents and stale tasks", async () => {
        const workerService = {
            states: jest.fn(async () => ({
                5: "working",
                6: "blocked",
                99: "blocked",
            })),
        }
        const { digest } = setup({ tasks, workerService })
        const d = await digest.buildDigest({
            staleFlagged: [{ id: 12, title: "New stale", status: "ready" }],
        })
        expect(d.generated_at).toBe(MORNING)
        expect(d.date).toBe("2026-11-07")
        expect(d.now.map((t) => [t.id, t.reason])).toEqual([
            [1, "Reminder"],
            [7, "PR closed without merge"],
            [8, "Stale: no change in 7 days"],
        ])
        expect(d.overdue).toEqual([
            {
                id: 2,
                title: "Task 2",
                status: "ready",
                kind: "todo",
                due_at: "2026-11-05T10:00:00.000Z",
            },
            {
                id: 1,
                title: "Task 1",
                status: "ready",
                kind: "reminder",
                due_at: "2026-11-06T10:00:00.000Z",
            },
        ])
        expect(d.prs.map((t) => [t.id, t.reason])).toEqual([
            [5, "ready for PR"],
            [6, "PR feedback"],
            [7, "PR closed without merge"],
        ])
        expect(d.blocked).toEqual([
            { id: 6, title: "Task 6", status: "pr_feedback", state: "blocked" },
            { id: 99, title: null, status: null },
        ])
        expect(d.stale.map((t) => t.id)).toEqual([12, 8])
        expect(d.summary).toBe(
            "Morning: 3 in Now, 3 PRs, 2 overdue, 2 blocked agents, 2 stale"
        )
    })

    test("stale flagged in this run is not listed twice", async () => {
        const { digest } = setup({ tasks })
        const d = await digest.buildDigest({
            staleFlagged: [{ id: 8, title: "Task 8", status: "active" }],
        })
        expect(d.stale.map((t) => t.id)).toEqual([8])
    })

    test("worker states: absent, failing, or empty", async () => {
        const a = setup({ tasks })
        expect((await a.digest.buildDigest()).blocked).toEqual([])
        a.digest.setWorkerService({
            states: async () => {
                throw new Error("herdr down")
            },
        })
        expect((await a.digest.buildDigest()).blocked).toEqual([])
        expect(a.log.warn).toHaveBeenCalledWith(
            { err: "herdr down" },
            "agent states unavailable"
        )
        a.digest.setWorkerService({ states: async () => null })
        expect((await a.digest.buildDigest()).blocked).toEqual([])
        a.digest.setWorkerService({})
        expect((await a.digest.buildDigest()).blocked).toEqual([])
        a.digest.setWorkerService(null)
        expect((await a.digest.buildDigest()).blocked).toEqual([])
    })
})

describe("run", () => {
    test("sweeps, builds, saves, emits and notifies", async () => {
        const tasks = [
            task(1, { flags: { ...FLAGS, now: true } }),
            task(2, { flags: { ...FLAGS, now: true } }),
            task(3, { flags: { ...FLAGS, now: true } }),
            task(4, { flags: { ...FLAGS, now: true } }),
            task(5, { status: "ready_for_pr" }),
            task(6, { due_at: "2026-11-01T00:00:00.000Z" }),
        ]
        const s = setup({ tasks })
        s.staleSweep.sweep.mockResolvedValueOnce({
            flagged: [{ id: 7, title: "S", status: "ready" }],
        })
        const d = await s.digest.run()
        expect(d.stale).toEqual([{ id: 7, title: "S", status: "ready" }])
        expect(s.digest.latest()).toBe(d)
        expect(JSON.parse(s.fs.data.get(STATE))).toEqual({
            last_run_date: "2026-11-07",
            latest: JSON.parse(JSON.stringify(d)),
        })
        expect(s.fs.renameSync).toHaveBeenCalledWith(`${STATE}.tmp`, STATE)
        expect(s.busEvents).toEqual([
            expect.objectContaining({
                type: "digest.updated",
                task_id: null,
                data: {
                    generated_at: MORNING,
                    date: "2026-11-07",
                    summary: d.summary,
                },
            }),
        ])
        expect(s.notifier.notify).toHaveBeenCalledWith({
            title: "Morning: 4 in Now, 1 PR, 1 overdue, 1 stale",
            body: "Now: T-1, T-2, T-3… · PRs: T-5 · Overdue: T-6",
            sound: "none",
            url: "/",
        })
    })

    test("notify false, sweep / notify / save failures are logged", async () => {
        const s = setup()
        s.staleSweep.sweep.mockRejectedValueOnce(new Error("sweep broke"))
        await s.digest.run({ notify: false })
        expect(s.notifier.notify).not.toHaveBeenCalled()
        expect(s.log.warn).toHaveBeenCalledWith(
            { err: "sweep broke" },
            "stale sweep failed"
        )
        s.staleSweep.sweep.mockResolvedValueOnce({})
        s.notifier.notify.mockRejectedValueOnce(new Error("no gui"))
        s.fs.writeFileSync.mockImplementationOnce(() => {
            throw new Error("disk full")
        })
        const d = await s.digest.run()
        expect(d.summary).toBe("Morning: all clear")
        expect(s.log.warn).toHaveBeenCalledWith(
            { err: "no gui" },
            "digest notify failed"
        )
        expect(s.log.warn).toHaveBeenCalledWith(
            { err: "disk full" },
            "digest state not saved"
        )
    })

    test("works without optional deps and shares concurrent runs", async () => {
        const store = fakeStore([task(1)])
        const digest = createDigest({ store, timezone: "UTC" })
        const [a, b] = await Promise.all([digest.run(), digest.run()])
        expect(a).toBe(b)
        expect(store.query).toHaveBeenCalledTimes(1)
        expect(digest.latest()).toBe(a)
        // default timezone
        const d2 = createDigest({ store })
        expect(typeof (await d2.buildDigest()).date).toBe("string")
        expect(d2.latest()).toBeNull()
    })
})

describe("schedule", () => {
    test("runs once a day when the local time reaches digest.time", async () => {
        const s = setup({ settings: { "digest.time": "08:30" } })
        expect(await s.digest.check()).toBeNull() // 07:00 local
        s.clock.set("2026-11-07T16:29:00.000Z") // 08:29
        expect(await s.digest.check()).toBeNull()
        s.clock.set("2026-11-07T16:30:00.000Z") // 08:30
        expect((await s.digest.check()).date).toBe("2026-11-07")
        s.clock.set("2026-11-07T20:00:00.000Z")
        expect(await s.digest.check()).toBeNull()
        s.clock.set("2026-11-08T16:31:00.000Z")
        expect((await s.digest.check()).date).toBe("2026-11-08")
        expect(s.notifier.notify).toHaveBeenCalledTimes(2)
    })

    test("disabled, default and invalid times", async () => {
        const off = setup({ settings: { "digest.enabled": false } })
        off.clock.set("2026-11-07T23:00:00.000Z")
        expect(await off.digest.check()).toBeNull()

        const bad = setup({ settings: { "digest.time": "8:30" } })
        bad.clock.set("2026-11-07T16:29:00.000Z") // 08:29: default 08:30
        expect(await bad.digest.check()).toBeNull()
        bad.clock.set("2026-11-07T16:30:00.000Z")
        expect(await bad.digest.check()).not.toBeNull()

        // no settings repo: defaults (enabled, 08:30)
        const none = setup({ settingsRepo: null })
        none.clock.set("2026-11-07T16:30:00.000Z")
        expect(await none.digest.check()).not.toBeNull()
    })

    test("DST: a skipped wall time fires at the next valid minute", async () => {
        const s = setup({ settings: { "digest.time": "02:30" } })
        s.clock.set("2026-03-08T09:59:00.000Z") // 01:59 PST
        expect(await s.digest.check()).toBeNull()
        s.clock.set("2026-03-08T10:00:00.000Z") // 03:00 PDT
        expect((await s.digest.check()).date).toBe("2026-03-08")
        // fall back: the repeated hour does not send a second digest
        const f = setup({ settings: { "digest.time": "01:15" } })
        f.clock.set("2026-11-01T08:20:00.000Z") // 01:20 PDT
        expect(await f.digest.check()).not.toBeNull()
        f.clock.set("2026-11-01T09:20:00.000Z") // 01:20 PST
        expect(await f.digest.check()).toBeNull()
    })

    test("check never throws", async () => {
        const s = setup()
        s.settingsRepo.get.mockRejectedValueOnce(new Error("db gone"))
        expect(await s.digest.check()).toBeNull()
        expect(s.log.error).toHaveBeenCalledWith(
            { err: "db gone" },
            "digest run failed"
        )
    })

    test("start loads state, checks now and every checkMs; stop", async () => {
        const s = setup({ settings: { "digest.time": "07:00" } })
        s.fs.data.set(
            STATE,
            JSON.stringify({
                last_run_date: "2026-11-07",
                latest: { date: "2026-11-07", summary: "old" },
            })
        )
        s.digest.start()
        s.digest.start() // no-op
        await s.clock.advance(0)
        // today already has a digest (from before the restart)
        expect(s.notifier.notify).not.toHaveBeenCalled()
        expect(s.digest.latest()).toEqual({
            date: "2026-11-07",
            summary: "old",
        })
        expect(s.clock.pending()).toBe(1)
        s.clock.set("2026-11-08T15:00:00.000Z")
        await s.clock.advance(60000)
        expect(s.notifier.notify).toHaveBeenCalledTimes(1)
        await s.digest.stop()
        expect(s.clock.pending()).toBe(0)
        await s.digest.stop()
    })

    test("a restart after digest.time catches up a missed day once", async () => {
        const s = setup({ settings: { "digest.time": "06:00" } })
        s.digest.start()
        await s.clock.advance(0)
        expect(s.notifier.notify).toHaveBeenCalledTimes(1)
        await s.digest.stop()
    })

    test("stop waits for the timer's check and starts no run after it", async () => {
        const s = setup({ settings: { "digest.time": "06:00" } })
        let release
        const gate = new Promise((r) => (release = r))
        const get = s.settingsRepo.get
        s.settingsRepo.get = jest.fn(async (k, d) => {
            await gate
            return get(k, d)
        })
        const query = s.store.query
        s.digest.start()
        const ticked = s.clock.advance(0)
        let stopped = false
        const stopping = s.digest.stop().then(() => (stopped = true))
        await Promise.resolve()
        expect(stopped).toBe(false) // still waiting for the check
        release()
        await stopping
        await ticked
        expect(query).not.toHaveBeenCalled()
        expect(s.notifier.notify).not.toHaveBeenCalled()
        expect(s.clock.pending()).toBe(0)
    })

    test("a timer firing after stop does nothing", async () => {
        const s = setup()
        const handlers = []
        s.clock.setTimeout = (fn) => handlers.push(fn)
        s.digest.start()
        await s.digest.stop()
        await handlers[0]()
        expect(s.settingsRepo.get).not.toHaveBeenCalled()
    })

    test("state file: missing, unreadable, odd content", async () => {
        const a = setup()
        expect(a.digest.latest()).toBeNull()
        expect(a.log.warn).not.toHaveBeenCalled()

        const b = setup()
        b.fs.data.set(STATE, "{")
        expect(b.digest.latest()).toBeNull()
        expect(b.log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.any(String) }),
            "digest state unreadable"
        )

        const c = setup()
        c.fs.data.set(STATE, "null")
        expect(c.digest.latest()).toBeNull()
        c.fs.data.set(STATE, "{}")
        expect(c.digest.latest()).toBeNull()

        const d = setup({ stateFile: null })
        await d.digest.run()
        expect(d.fs.writeFileSync).not.toHaveBeenCalled()
    })
})
