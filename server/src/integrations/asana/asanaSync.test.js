/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { createBus } from "../../events/bus.js"
import { AppError } from "../../util/errors.js"
import { createFakeClock } from "../../util/clock.js"
import { trackingFingerprint } from "./asanaNotes.js"
import { createAsanaSync, needsSync } from "./asanaSync.js"

const asana = (over = {}) => ({
    gid: "111",
    url: "https://app.asana.com/0/1/111",
    section_gid: null,
    no_section: false,
    attachments: [],
    tracking_hash: null,
    ...over,
})

function task(id, over = {}) {
    return {
        id,
        title: `Task ${id}`,
        status: "active",
        repos: [],
        deliverables: [],
        links: [],
        asana: asana(),
        ...over,
    }
}

/** In-memory store that emits task.updated like the real one. */
function fakeStore(bus, tasks) {
    const map = new Map(tasks.map((t) => [t.id, structuredClone(t)]))
    const store = {
        map,
        updates: [],
        async getTask(id) {
            if (!map.has(id)) throw new Error(`task ${id} not found`)
            return { task: structuredClone(map.get(id)), revision: "r" }
        },
        async updateTask(id, patch, opts) {
            store.updates.push([id, patch, opts])
            const cur = map.get(id)
            const next = { ...cur }
            for (const [k, v] of Object.entries(patch))
                next[k] =
                    v && typeof v === "object" && !Array.isArray(v)
                        ? { ...cur[k], ...v }
                        : v
            map.set(id, next)
            bus.emit("task.updated", {
                task_id: id,
                data: { task: structuredClone(next) },
            })
            return { task: next, revision: "r2" }
        },
        async query() {
            return { tasks: [...map.values()].map((t) => structuredClone(t)) }
        },
    }
    return store
}

function setup(tasks, svcOver = {}, syncOver = {}) {
    const clock = createFakeClock()
    const bus = createBus({ clock })
    const store = fakeStore(bus, tasks)
    const asanaService = {
        syncTracking: jest.fn(async (t) => ({
            attachments: [
                ...(t.asana.attachments || []),
                "https://github.com/acme/x/pull/1",
            ],
            failed: [],
        })),
        ...svcOver,
    }
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const sync = createAsanaSync({
        store,
        bus,
        asanaService,
        clock,
        log,
        debounceMs: 1000,
        retryDelaysMs: [10_000, 20_000],
        ...syncOver,
    })
    return { clock, bus, store, asanaService, log, sync }
}

const update = (bus, store, id, patch) => store.updateTask(id, patch, {})

describe("needsSync / trackingFingerprint", () => {
    test("only Asana-linked tasks whose tracked state changed", () => {
        const t = task(1)
        expect(needsSync({ ...t, asana: asana({ gid: null }) })).toBe(false)
        expect(needsSync({ ...t, asana: undefined })).toBe(false)
        expect(needsSync(t)).toBe(true)
        const synced = {
            ...t,
            asana: asana({ tracking_hash: trackingFingerprint(t) }),
        }
        expect(needsSync(synced)).toBe(false)
        // title and updated_at are not tracked; status and PRs are
        expect(
            needsSync({ ...synced, title: "x", updated_at: "2027-01-01" })
        ).toBe(false)
        expect(needsSync({ ...synced, status: "pr_open" })).toBe(true)
        expect(
            needsSync({
                ...synced,
                links: [
                    {
                        type: "pr",
                        url: "https://github.com/acme/x/pull/2",
                    },
                ],
            })
        ).toBe(true)
    })
})

describe("createAsanaSync", () => {
    test("start reconciles stale tasks; the sync writes hash + attachments once", async () => {
        const done = task(2)
        done.asana.tracking_hash = trackingFingerprint(done)
        const { clock, store, asanaService, sync } = setup([
            task(1),
            done,
            task(3, { asana: asana({ gid: null }) }),
        ])
        expect(await sync.start()).toBe(1)
        await sync.start() // idempotent
        await clock.advance(1000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(1)
        expect(asanaService.syncTracking.mock.calls[0][0].id).toBe(1)
        expect(store.updates).toEqual([
            [
                1,
                {
                    asana: {
                        attachments: ["https://github.com/acme/x/pull/1"],
                        synced_gid: "111",
                        tracking_hash: trackingFingerprint(task(1)),
                    },
                },
                { actor: "system", reason: "asana sync" },
            ],
        ])
        // our own write emitted task.updated: it matches the hash, no loop
        await clock.advance(10_000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(1)
        expect(sync.pending()).toBe(0)
        expect(store.map.get(1).asana.gid).toBe("111")
        await sync.stop()
    })

    test("a burst of tracked changes is one debounced sync", async () => {
        const t = task(1)
        t.asana.tracking_hash = trackingFingerprint(t)
        const { clock, bus, store, asanaService, sync } = setup([t])
        await sync.start()
        await update(bus, store, 1, { status: "ready_for_pr" })
        await clock.advance(500)
        await update(bus, store, 1, { status: "pr_open" })
        await update(bus, store, 1, { title: "untracked" })
        await clock.advance(999)
        expect(asanaService.syncTracking).not.toHaveBeenCalled()
        await clock.advance(1)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(1)
        expect(asanaService.syncTracking.mock.calls[0][0].status).toBe(
            "pr_open"
        )
        await sync.stop()
    })

    test("events for tasks without Asana or other types are ignored", async () => {
        const { clock, bus, asanaService, sync } = setup([
            task(1, { asana: asana({ gid: null }) }),
        ])
        await sync.start()
        bus.emit("task.updated", {
            task_id: 1,
            data: { task: task(1, { asana: asana({ gid: null }) }) },
        })
        bus.emit("artifact.updated", { task_id: 1, data: {} })
        bus.emit("task.updated", { task_id: null, data: {} })
        expect(sync.pending()).toBe(0)
        // an event without the task body is checked on the re-read
        bus.emit("task.created", { task_id: 1, data: {} })
        expect(sync.pending()).toBe(1)
        await clock.advance(1000)
        expect(asanaService.syncTracking).not.toHaveBeenCalled()
        await sync.stop()
    })

    test("failures retry with backoff, then give up until the next change", async () => {
        const { clock, bus, store, asanaService, log, sync } = setup(
            [task(1)],
            {
                syncTracking: jest.fn(async () => {
                    throw new AppError("asana_error", "boom", {
                        status: 502,
                        details: { status: 500 },
                    })
                }),
            }
        )
        await sync.start()
        await clock.advance(1000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(1)
        await clock.advance(10_000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(2)
        await clock.advance(20_000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(3)
        await clock.advance(60_000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(3)
        expect(log.error).toHaveBeenCalledTimes(1)
        expect(store.updates).toHaveLength(0)

        // a new tracked change starts over
        await update(bus, store, 1, { status: "review" })
        await clock.advance(1000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(4)
        await sync.stop()
        expect(sync.pending()).toBe(0)
    })

    test("failed attachments: keep the added ones, no hash, retry with backoff", async () => {
        const A = "https://github.com/acme/x/pull/1"
        const B = "https://github.com/acme/x/tree/b"
        let call = 0
        const { clock, store, asanaService, log, sync } = setup([task(1)], {
            syncTracking: jest.fn(async (t) => {
                call++
                if (call === 1) return { attachments: [A], failed: [B] }
                if (call === 2) return { attachments: [A], failed: [B] }
                return { attachments: [...t.asana.attachments, B], failed: [] }
            }),
        })
        await sync.start()
        await clock.advance(1000)
        expect(store.updates).toHaveLength(1)
        expect(store.updates[0][1]).toEqual({
            asana: { attachments: [A], synced_gid: "111" },
        })
        expect(store.map.get(1).asana.tracking_hash).toBeNull()
        expect(log.warn).toHaveBeenCalledTimes(1)
        // our own write did not reset the backoff or trigger a debounce run
        await clock.advance(9_999)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(1)
        await clock.advance(1)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(2)
        // nothing new attached: no write this time
        expect(store.updates).toHaveLength(1)
        await clock.advance(20_000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(3)
        expect(store.map.get(1).asana).toMatchObject({
            attachments: [A, B],
            tracking_hash: trackingFingerprint(task(1)),
        })
        await clock.advance(100_000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(3)
        await sync.stop()
    })

    test("an incomplete sync is picked up again by reconcile", async () => {
        const { clock, asanaService, sync } = setup([task(1)], {
            syncTracking: jest.fn(async () => ({
                attachments: [],
                failed: ["https://x"],
            })),
        })
        await sync.start()
        await clock.advance(1000 + 10_000 + 20_000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(3)
        await sync.stop()
        expect(await sync.reconcile()).toBe(0) // stopped: nothing scheduled
        await sync.start()
        await clock.advance(1000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(4)
        await sync.stop()
    })

    test("a change made while the bookkeeping write waits is synced too", async () => {
        const { clock, store, asanaService, sync } = setup([task(1)])
        // the bookkeeping write waits behind another writer that moves the
        // task to review; that writer's event arrives during our write
        const realUpdate = store.updateTask
        let interfered = false
        store.updateTask = async (id, patch, opts) => {
            if (!interfered && patch.asana) {
                interfered = true
                await realUpdate(id, { status: "review" }, {})
            }
            return realUpdate(id, patch, opts)
        }
        await sync.start()
        await clock.advance(1000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(1)
        expect(asanaService.syncTracking.mock.calls[0][0].status).toBe("active")
        // the stored hash is the "active" one; the task is in review
        expect(sync.pending()).toBe(1)
        await clock.advance(1000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(2)
        expect(asanaService.syncTracking.mock.calls[1][0].status).toBe("review")
        await clock.advance(10_000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(2)
        await sync.stop()
    })

    test("a failing re-read after the write is only logged", async () => {
        const { clock, store, log, sync } = setup([task(1)])
        const realGet = store.getTask
        let n = 0
        store.getTask = async (id) => {
            // 1: sync read, 2: bookkeeping re-check, 3: catch-up re-read
            if (++n === 3) throw new Error("db closed")
            return realGet(id)
        }
        await sync.start()
        await clock.advance(1000)
        expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ err: "db closed" }),
            "asana sync: recheck"
        )
        await sync.stop()
    })

    test("a public URL detected later re-syncs on the periodic reconcile", async () => {
        let base = null // tailnet URL not detected yet
        const { clock, store, asanaService, sync } = setup([task(1)], {
            artifactUrlFor: (t) => (base ? `${base}/t/${t.id}` : null),
        })
        await sync.start()
        await clock.advance(1000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(1)
        expect(store.map.get(1).asana.tracking_hash).toBe(
            trackingFingerprint(task(1), null)
        )
        // nothing changes on the task; the URL becomes known
        base = "https://mac.ts.net:8443"
        await clock.advance(15 * 60_000)
        await clock.advance(1000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(2)
        expect(store.map.get(1).asana.tracking_hash).toBe(
            trackingFingerprint(task(1), "https://mac.ts.net:8443/t/1")
        )
        // in step now: the next periodic pass does nothing
        await clock.advance(16 * 60_000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(2)
        await sync.stop()
        expect(clock.pending()).toBe(0)
    })

    test("the artifact URL is part of the fingerprint", () => {
        const t = task(1)
        expect(trackingFingerprint(t, "https://a/t/1")).not.toBe(
            trackingFingerprint(t, null)
        )
        const synced = {
            ...t,
            asana: asana({
                tracking_hash: trackingFingerprint(t, "https://a/t/1"),
            }),
        }
        expect(needsSync(synced, "https://a/t/1")).toBe(false)
        expect(needsSync(synced, null)).toBe(true)
    })

    test("re-linking to another Asana task re-syncs it with fresh attachments", async () => {
        const t = task(1, {
            asana: asana({ attachments: ["https://old/1"], synced_gid: "111" }),
        })
        t.asana.tracking_hash = trackingFingerprint(t)
        const { clock, store, asanaService, sync } = setup([t])
        await sync.start()
        await clock.advance(5000)
        expect(asanaService.syncTracking).not.toHaveBeenCalled()
        await store.updateTask(1, { asana: { gid: "222" } }, {})
        await clock.advance(1000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(1)
        const sent = asanaService.syncTracking.mock.calls[0][0]
        expect(sent.asana.gid).toBe("222")
        expect(sent.asana.attachments).toEqual([]) // old task's links don't count
        expect(store.map.get(1).asana).toMatchObject({
            gid: "222",
            synced_gid: "222",
            attachments: ["https://github.com/acme/x/pull/1"],
        })
        await sync.stop()
    })

    test("a sync for the old link never writes onto a new one", async () => {
        let relink
        const { store, sync } = setup([task(1)], {
            syncTracking: jest.fn(async () => {
                if (relink) await relink()
                return { attachments: ["https://x/old"], failed: [] }
            }),
        })
        relink = async () => {
            relink = null
            await store.updateTask(1, { asana: { gid: "333" } }, {})
        }
        await sync.run(1) // syncs gid 111, which is replaced mid-way
        expect(store.map.get(1).asana).toMatchObject({
            gid: "333",
            tracking_hash: null,
        })
        expect(store.map.get(1).asana.synced_gid ?? null).toBeNull()
        expect(sync.pending()).toBe(0) // stopped: schedule() is a no-op
        await sync.start()
        await new Promise((r) => setImmediate(r))
        expect(sync.pending()).toBe(1) // the new link is queued for sync
        await sync.stop()
    })

    test("a 404 from Asana is not retried", async () => {
        const { clock, asanaService, log, sync } = setup([task(1)], {
            syncTracking: jest.fn(async () => {
                throw new AppError("asana_error", "gone", {
                    status: 502,
                    details: { status: 404 },
                })
            }),
        })
        await sync.start()
        await clock.advance(100_000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(1)
        expect(log.error).toHaveBeenCalledTimes(1)
        await sync.stop()
    })

    test("syncs of one task never overlap; non-array result keeps attachments", async () => {
        let release
        let running = 0
        let maxRunning = 0
        const t = task(1, { asana: asana({ attachments: ["a"] }) })
        const { store, sync } = setup([t], {
            syncTracking: jest.fn(async () => {
                running++
                maxRunning = Math.max(maxRunning, running)
                await new Promise((r) => (release = r))
                running--
                return undefined
            }),
        })
        const one = sync.run(1)
        const two = sync.run(1)
        await new Promise((r) => setImmediate(r))
        release()
        await one
        await two // re-reads: hash now matches, nothing to do
        expect(maxRunning).toBe(1)
        expect(store.updates).toHaveLength(1)
        expect(store.updates[0][1].asana.attachments).toEqual(["a"])
    })

    test("missing task and failing reconcile are logged, not thrown", async () => {
        const { store, log, sync } = setup([])
        expect(await sync.run(9)).toBe(false)
        store.query = async () => {
            throw new Error("db closed")
        }
        expect(await sync.start()).toBe(0)
        expect(log.warn).toHaveBeenCalledTimes(2)
        await sync.stop()
    })

    test("stop cancels timers and nothing is scheduled afterwards", async () => {
        const { clock, bus, store, asanaService, sync } = setup([task(1)])
        await sync.start()
        expect(sync.pending()).toBe(1)
        await sync.stop()
        expect(sync.pending()).toBe(0)
        await update(bus, store, 1, { status: "review" })
        await clock.advance(5000)
        expect(asanaService.syncTracking).not.toHaveBeenCalled()
        await sync.stop() // idempotent
    })
})

describe("asana sync with a GitHub org", () => {
    const dlv = (branch) => [
        { repo: "mobile", branch, role: "work", disposition: "pending" },
    ]
    test("hashes with the org; a branch-only change syncs again", async () => {
        const t = task(5, { deliverables: dlv("t5-a") })
        const { clock, store, asanaService, sync } = setup(
            [t],
            {},
            {
                githubOrg: "acme",
            }
        )
        await sync.start()
        await clock.advance(1000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(1)
        expect(store.map.get(5).asana.tracking_hash).toBe(
            trackingFingerprint(t, null, "acme")
        )
        // only the deliverable branch changes
        await update(null, store, 5, { deliverables: dlv("t5-b") })
        await clock.advance(1000)
        expect(asanaService.syncTracking).toHaveBeenCalledTimes(2)
        expect(
            asanaService.syncTracking.mock.calls[1][0].deliverables[0].branch
        ).toBe("t5-b")
        await sync.stop()
    })

    test("needsSync uses the org it is given", () => {
        const t = task(6, { deliverables: dlv("t6-a") })
        const synced = {
            ...t,
            asana: asana({
                tracking_hash: trackingFingerprint(t, null, "acme"),
            }),
        }
        expect(needsSync(synced, null, "acme")).toBe(false)
        expect(
            needsSync({ ...synced, deliverables: dlv("t6-b") }, null, "acme")
        ).toBe(true)
    })
})
