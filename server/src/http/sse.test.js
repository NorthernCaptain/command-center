/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { EventEmitter } from "node:events"
import http from "node:http"
import { createBus } from "../events/bus.js"
import { createSseHandler, filterForViewer, SHARE_KEYS } from "./sse.js"
import {
    createHarness,
    makeTask,
    OWNER,
    seedTasks,
    TOKEN,
} from "./testing/fakes.js"

const SHARED = makeTask(1, { asana: { gid: "1", url: "https://a/1" } })
const PRIVATE = makeTask(2)

function fakeStore(tasks) {
    return {
        async getTask(id) {
            const task = tasks.find((t) => t.id === id)
            if (!task) throw new Error("not found")
            return { task, revision: "r" }
        },
    }
}

function fakeReqRes(role, extra = {}) {
    const req = new EventEmitter()
    req.auth = { role, ...extra }
    const res = new EventEmitter()
    res.headers = {}
    res.chunks = []
    res.status = (s) => {
        res.statusCode = s
        return res
    }
    res.setHeader = (k, v) => {
        res.headers[k.toLowerCase()] = v
    }
    res.flushHeaders = () => {}
    res.write = (c) => res.chunks.push(c)
    res.end = () => {
        res.ended = true
        res.emit("close")
    }
    return { req, res }
}

function fakeTimers() {
    const t = { fns: [], cleared: [] }
    t.setInterval = (fn, ms) => {
        t.fns.push({ fn, ms })
        return { id: t.fns.length, unref() {} }
    }
    t.clearInterval = (h) => t.cleared.push(h)
    return t
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("filterForViewer", () => {
    const store = fakeStore([SHARED, PRIVATE])
    const ev = (type, task_id, data) => ({ type, task_id, data, at: "now" })

    test("task events for shared tasks get viewerTask", async () => {
        const out = await filterForViewer(
            ev("task.updated", 1, {
                task: SHARED,
                changed: ["title", "flags"],
            }),
            store
        )
        expect(out.data.changed).toEqual(["title"])
        expect(out.data.task).not.toHaveProperty("source")
        expect(out.data.task).not.toHaveProperty("flags")
        const created = await filterForViewer(
            ev("task.created", 1, { task: SHARED }),
            store
        )
        expect(created.data).toEqual({ task: expect.any(Object) })
    })

    test("private tasks and invisible-only changes are dropped", async () => {
        expect(
            await filterForViewer(
                ev("task.created", 2, { task: PRIVATE }),
                store
            )
        ).toBeNull()
        expect(
            await filterForViewer(
                ev("task.updated", 1, { task: SHARED, changed: ["flags"] }),
                store
            )
        ).toBeNull()
        expect(
            await filterForViewer(ev("task.updated", 1, {}), store)
        ).toBeNull()
        expect(
            await filterForViewer({ type: "task.updated", task_id: 1 }, store)
        ).toBeNull()
    })

    test("artifact.updated: shared only, actor stripped", async () => {
        const out = await filterForViewer(
            ev("artifact.updated", 1, {
                revision: "r9",
                actor: "center",
                sections: ["Plan"],
            }),
            store
        )
        expect(out.data).toEqual({ revision: "r9", sections: ["Plan"] })
        const noSections = await filterForViewer(
            ev("artifact.updated", 1, { revision: "r9", actor: "me" }),
            store
        )
        expect(noSections.data).toEqual({ revision: "r9" })
        expect(
            await filterForViewer(
                ev("artifact.updated", 2, { revision: "r" }),
                store
            )
        ).toBeNull()
        expect(
            await filterForViewer(ev("artifact.updated", 99, {}), store)
        ).toBeNull()
        expect(
            await filterForViewer(ev("artifact.updated", null, {}), store)
        ).toBeNull()
    })

    test("visibility/asana change to shared sends the full viewer task", async () => {
        expect(SHARE_KEYS).toEqual(["visibility", "asana"])
        for (const changed of [["visibility"], ["asana"], ["asana", "flags"]]) {
            const out = await filterForViewer(
                ev("task.updated", 1, { task: SHARED, changed }),
                store
            )
            expect(out.type).toBe("task.updated")
            expect(out.data.task).toMatchObject({ id: 1, title: "Task 1" })
            expect(out.data.task).not.toHaveProperty("visibility")
            expect(out.data.changed).toEqual(
                changed.filter((k) => k === "asana")
            )
        }
    })

    test("visibility/asana change to private sends task.hidden only", async () => {
        const hidden = makeTask(1, { visibility: "private", title: "secret" })
        for (const changed of [["visibility"], ["asana"]]) {
            const out = await filterForViewer(
                ev("task.updated", 1, { task: hidden, changed }),
                store
            )
            expect(out).toEqual({
                type: "task.hidden",
                task_id: 1,
                data: { task_id: 1 },
                at: "now",
            })
        }
        // Other changes to a private task stay silent.
        expect(
            await filterForViewer(
                ev("task.updated", 1, { task: hidden, changed: ["title"] }),
                store
            )
        ).toBeNull()
        // A private task being created is never announced.
        expect(
            await filterForViewer(
                ev("task.created", 1, {
                    task: hidden,
                    changed: ["visibility"],
                }),
                store
            )
        ).toBeNull()
    })

    test("a task this stream showed is hidden when it stops being shared", async () => {
        const state = { visible: new Set() }
        const shown = await filterForViewer(
            ev("task.updated", 1, { task: SHARED, changed: ["status"] }),
            store,
            state
        )
        expect(shown.type).toBe("task.updated")
        expect(state.visible.has(1)).toBe(true)
        // Unshared without a changed list (e.g. a store-side rewrite).
        const out = await filterForViewer(
            ev("task.updated", 1, {
                task: makeTask(1, { visibility: "private" }),
            }),
            store,
            state
        )
        expect(out.type).toBe("task.hidden")
        expect(state.visible.has(1)).toBe(false)
        // Unknown to this stream and not a share change: silent.
        expect(
            await filterForViewer(
                ev("task.updated", 2, { task: PRIVATE, changed: ["title"] }),
                store,
                state
            )
        ).toBeNull()
    })

    test.each([
        "comment.added",
        "comment.updated",
        "event.added",
        "job.updated",
        "job.delta",
        "schedule.updated",
        "settings.updated",
    ])("%s is never sent to viewers", async (type) => {
        expect(await filterForViewer(ev(type, 1, { x: 1 }), store)).toBeNull()
    })
})

describe("createSseHandler", () => {
    test("owner receives every event, heartbeats, cleanup", async () => {
        const bus = createBus()
        const timers = fakeTimers()
        const handler = createSseHandler({
            bus,
            store: fakeStore([]),
            heartbeatMs: 1000,
            setInterval: timers.setInterval,
            clearInterval: timers.clearInterval,
        })
        const { req, res } = fakeReqRes("owner")
        handler(req, res)
        expect(res.statusCode).toBe(200)
        expect(res.headers["content-type"]).toMatch(/^text\/event-stream/)
        expect(res.chunks[0]).toBe("retry: 3000\n: connected\n\n")
        bus.emit("job.delta", { task_id: 2, data: { job_id: "j", text: "hi" } })
        await flush()
        const chunk = res.chunks[1]
        expect(chunk.startsWith("event: job.delta\ndata: ")).toBe(true)
        expect(chunk.endsWith("\n\n")).toBe(true)
        const payload = JSON.parse(chunk.split("data: ")[1])
        expect(payload).toMatchObject({
            type: "job.delta",
            task_id: 2,
            data: { job_id: "j", text: "hi" },
        })
        expect(timers.fns[0].ms).toBe(1000)
        timers.fns[0].fn()
        expect(res.chunks.at(-1)).toBe(": ping\n\n")
        expect(bus.listenerCount()).toBe(1)
        req.emit("close")
        res.emit("close")
        expect(bus.listenerCount()).toBe(0)
        expect(timers.cleared).toHaveLength(1)
        timers.fns[0].fn()
        bus.emit("job.delta", { data: {} })
        await flush()
        expect(res.chunks.at(-1)).toBe(": ping\n\n")
        expect(res.chunks).toHaveLength(3)
    })

    test("viewer receives filtered events in order", async () => {
        const bus = createBus()
        const timers = fakeTimers()
        const handler = createSseHandler({
            bus,
            store: fakeStore([SHARED, PRIVATE]),
            setInterval: timers.setInterval,
            clearInterval: timers.clearInterval,
        })
        const { req, res } = fakeReqRes("viewer")
        handler(req, res)
        bus.emit("artifact.updated", {
            task_id: 1,
            data: { revision: "a", actor: "me" },
        })
        bus.emit("task.created", { task_id: 2, data: { task: PRIVATE } })
        bus.emit("comment.added", { task_id: 1, data: { comment: {} } })
        bus.emit("task.updated", {
            task_id: 1,
            data: { task: SHARED, changed: ["status"] },
        })
        await flush()
        await flush()
        const types = res.chunks.slice(1).map((c) => c.split("\n")[0])
        expect(types).toEqual([
            "event: artifact.updated",
            "event: task.updated",
        ])
        expect(res.chunks.join("")).not.toContain('"actor"')
        expect(timers.fns[0].ms).toBe(25000)
        res.emit("error", new Error("x"))
        expect(bus.listenerCount()).toBe(0)
    })

    test("viewer filter failures are logged, not thrown", async () => {
        const bus = createBus()
        const warned = []
        const handler = createSseHandler({
            bus,
            store: {
                getTask() {
                    return { then: () => {} } // never used
                },
            },
            log: { warn: (o, m) => warned.push(m) },
            setInterval: () => null,
            clearInterval: () => {},
        })
        const { req, res } = fakeReqRes("viewer")
        handler(req, res)
        // A task event whose data getter throws inside the filter.
        bus.emit("task.created", {
            task_id: 1,
            data: Object.defineProperty({}, "task", {
                get() {
                    throw new Error("bad")
                },
            }),
        })
        await flush()
        expect(warned).toEqual(["sse filter failed"])
        req.emit("close")
    })
})

describe("createSseHandler: credential lifecycle", () => {
    function setup(auth, log) {
        const bus = createBus()
        const timers = fakeTimers()
        const handler = createSseHandler({
            bus,
            store: fakeStore([]),
            auth,
            log,
            setInterval: timers.setInterval,
            clearInterval: timers.clearInterval,
        })
        const { req, res } = fakeReqRes("owner", { via: "device" })
        handler(req, res)
        return { bus, timers, req, res }
    }

    test("heartbeat re-validates and ends an invalid stream", async () => {
        let valid = true
        const untracked = []
        let endFn
        const auth = {
            stillValid: async (who) => {
                expect(who.via).toBe("device")
                return valid
            },
            trackStream: (who, end) => {
                endFn = end
                return () => untracked.push(who.via)
            },
        }
        const { bus, timers, res } = setup(auth)
        expect(typeof endFn).toBe("function")
        timers.fns[0].fn()
        await flush()
        expect(res.chunks.at(-1)).toBe(": ping\n\n")
        valid = false
        timers.fns[0].fn()
        await flush()
        expect(res.ended).toBe(true)
        expect(bus.listenerCount()).toBe(0)
        expect(untracked).toEqual(["device"])
        expect(timers.cleared).toHaveLength(1)
        endFn() // idempotent
        timers.fns[0].fn()
        expect(untracked).toHaveLength(1)
    })

    test("a closed stream ignores a late validation result", async () => {
        let resolveValid
        const auth = {
            stillValid: () => new Promise((r) => (resolveValid = r)),
        }
        const { timers, req, res } = setup(auth)
        timers.fns[0].fn()
        req.emit("close")
        resolveValid(true)
        await flush()
        expect(res.chunks).toHaveLength(1)
    })

    test("validation errors end the stream (fail closed)", async () => {
        const warned = []
        const auth = {
            stillValid: async () => {
                throw new Error("db down")
            },
        }
        const { timers, res } = setup(auth, {
            warn: (o, m) => warned.push(m),
        })
        timers.fns[0].fn()
        await flush()
        expect(res.ended).toBe(true)
        expect(warned).toEqual(["sse revalidate failed"])
    })

    test("trackStream end closes the stream", () => {
        let endFn
        const { bus, res } = setup({
            trackStream: (who, end) => {
                endFn = end
                return () => {}
            },
        })
        endFn()
        expect(res.ended).toBe(true)
        expect(bus.listenerCount()).toBe(0)
    })
})

describe("GET /api/events end to end", () => {
    let h, server, base
    beforeAll(async () => {
        h = createHarness()
        seedTasks(h.store)
        server = http.createServer(h.tailnet)
        const local = http.createServer(h.local)
        await new Promise((r) => server.listen(0, "127.0.0.1", r))
        await new Promise((r) => local.listen(0, "127.0.0.1", r))
        base = {
            tailnet: server.address().port,
            local: local.address().port,
            localServer: local,
        }
    })
    afterAll(async () => {
        server.closeAllConnections()
        base.localServer.closeAllConnections()
        await new Promise((r) => server.close(r))
        await new Promise((r) => base.localServer.close(r))
    })

    function open(port, headers) {
        if (port === base.tailnet)
            headers = { Host: "mac.tail.ts.net:8443", ...headers }
        return new Promise((resolve, reject) => {
            const req = http.get(
                { host: "127.0.0.1", port, path: "/api/events", headers },
                (res) => {
                    res.setEncoding("utf8")
                    const stream = { res, req, data: "" }
                    res.on("data", (d) => (stream.data += d))
                    resolve(stream)
                }
            )
            req.on("error", reject)
        })
    }

    async function waitFor(stream, text) {
        for (let i = 0; i < 100 && !stream.data.includes(text); i++)
            await new Promise((r) => setTimeout(r, 5))
        return stream.data
    }

    async function ended(stream) {
        if (stream.res.complete) return true
        await new Promise((r) => {
            stream.res.once("end", r)
            stream.res.once("close", r)
            setTimeout(r, 1000)
        })
        return stream.res.complete
    }

    test("401 without identity", async () => {
        const s = await open(base.tailnet, {})
        expect(s.res.statusCode).toBe(401)
        s.req.destroy()
    })

    test("rebound Host is refused before the stream opens", async () => {
        const s = await open(base.tailnet, {
            Host: "evil.example:7789",
            "Tailscale-User-Login": "bob@x",
        })
        expect(s.res.statusCode).toBe(421)
        s.req.destroy()
    })

    test("revoking a device ends its open owner stream", async () => {
        const { code } = await h.auth.createPairCode()
        const { token, device } = await h.auth.pair({ code, login: OWNER })
        const s = await open(base.tailnet, {
            "Tailscale-User-Login": OWNER,
            Cookie: `cc_device=${token}`,
        })
        await waitFor(s, ": connected")
        const viewer = await open(base.tailnet, {
            "Tailscale-User-Login": "bob@x",
        })
        await waitFor(viewer, ": connected")
        const del = await fetch(
            `http://127.0.0.1:${base.local}/api/devices/${device.id}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } }
        )
        expect(del.status).toBe(200)
        expect(await ended(s)).toBe(true)
        expect(viewer.res.complete).toBe(false)
        viewer.req.destroy()
    })

    test("logout ends the session's open streams", async () => {
        const session = h.auth.createSession()
        const s = await open(base.local, { Cookie: `cc_session=${session}` })
        expect(s.res.statusCode).toBe(200)
        await waitFor(s, ": connected")
        const out = await fetch(
            `http://127.0.0.1:${base.local}/api/auth/logout`,
            {
                method: "POST",
                headers: { Cookie: `cc_session=${session}` },
            }
        )
        expect(out.status).toBe(200)
        expect(await ended(s)).toBe(true)
    })

    test("viewer stream is filtered; owner stream is not", async () => {
        const viewer = await open(base.tailnet, {
            "Tailscale-User-Login": "bob@x",
        })
        const owner = await open(base.local, {
            Authorization: `Bearer ${TOKEN}`,
        })
        expect(viewer.res.statusCode).toBe(200)
        expect(owner.res.statusCode).toBe(200)
        await waitFor(viewer, ": connected")
        await h.store.updateTask(2, { title: "secret title" }, { actor: "me" })
        await h.store.updateTask(1, { status: "ready" }, { actor: "me" })
        await waitFor(viewer, "event: task.updated")
        await waitFor(owner, '"ready"')
        expect(viewer.data).not.toContain("secret title")
        expect(owner.data).toContain("secret title")
        expect(viewer.data).not.toContain("secret source")
        viewer.req.destroy()
        owner.req.destroy()
        for (let i = 0; i < 100 && h.bus.listenerCount() > 0; i++)
            await new Promise((r) => setTimeout(r, 5))
        expect(h.bus.listenerCount()).toBe(0)
    })

    test("owner device on tailnet gets everything", async () => {
        const { code } = await h.auth.createPairCode()
        const raw = await h.auth.pair({ code, login: OWNER })
        const s = await open(base.tailnet, {
            "Tailscale-User-Login": OWNER,
            Cookie: `cc_device=${raw.token}`,
        })
        await waitFor(s, ": connected")
        h.bus.emit("job.updated", { task_id: 2, data: { job: { id: "j" } } })
        expect(await waitFor(s, "event: job.updated")).toContain('"id":"j"')
        s.req.destroy()
    })
})
