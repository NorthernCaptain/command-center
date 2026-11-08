/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    EVENT_TYPES,
    createEventStream,
    getEventStream,
    normalizeEvent,
    setEventStream,
} from "./events.js"
import { FakeEventSource } from "../../test/helpers.js"

function fakeTimers() {
    const pending = []
    return {
        pending,
        setTimeout: jest.fn((fn, ms) => {
            const t = { fn, ms, cleared: false }
            pending.push(t)
            return t
        }),
        clearTimeout: jest.fn((t) => {
            if (t) t.cleared = true
        }),
        runNext() {
            const t = pending.shift()
            if (t && !t.cleared) t.fn()
            return t
        },
    }
}

beforeEach(() => FakeEventSource.reset())

describe("normalizeEvent", () => {
    it("passes bus events through", () => {
        const e = normalizeEvent("task.updated", {
            type: "task.updated",
            task_id: 3,
            data: { task: { id: 3 } },
            at: "x",
        })
        expect(e).toEqual({
            type: "task.updated",
            task_id: 3,
            data: { task: { id: 3 } },
            at: "x",
        })
    })
    it("wraps bare data payloads", () => {
        expect(normalizeEvent("job.delta", { job_id: "j", text: "a" })).toEqual(
            {
                type: "job.delta",
                task_id: null,
                data: { job_id: "j", text: "a" },
                at: null,
            }
        )
        expect(normalizeEvent("x", null).data).toEqual({})
        expect(normalizeEvent("x", { task_id: 4, data: null }).data).toEqual({})
        expect(normalizeEvent("x", { task_id: 4, data: {} }).type).toBe("x")
    })
})

describe("createEventStream", () => {
    it("connects, dispatches typed events and wildcard handlers", () => {
        const stream = createEventStream({ EventSource: FakeEventSource })
        const statuses = []
        stream.onStatus((s) => statuses.push(s))
        const typed = jest.fn()
        const all = jest.fn()
        const off = stream.on("task.updated", typed)
        stream.on("*", all)
        stream.start()
        const es = FakeEventSource.last()
        expect(es.url).toBe("/api/events")
        expect(es.opts).toEqual({ withCredentials: true })
        es.onopen()
        expect(stream.status).toBe("open")
        es.emit("task.updated", {
            type: "task.updated",
            task_id: 1,
            data: { changed: ["status"] },
        })
        expect(typed).toHaveBeenCalledWith(
            expect.objectContaining({
                task_id: 1,
                data: { changed: ["status"] },
            })
        )
        expect(all).toHaveBeenCalledTimes(1)
        off()
        es.emit("task.updated", { task_id: 1, data: {} })
        expect(typed).toHaveBeenCalledTimes(1)
        expect(statuses).toEqual(["connecting", "open"])
        // every contract type is subscribed
        for (const t of EVENT_TYPES) expect(es.listeners[t]).toHaveLength(1)
    })

    it("ignores malformed JSON and survives throwing handlers", () => {
        const spy = jest.spyOn(console, "error").mockImplementation(() => {})
        const stream = createEventStream({ EventSource: FakeEventSource })
        const good = jest.fn()
        stream.on("job.delta", () => {
            throw new Error("bad handler")
        })
        stream.on("job.delta", good)
        stream.start()
        const es = FakeEventSource.last()
        es.emit("job.delta", "{not json")
        expect(good).not.toHaveBeenCalled()
        es.emit("job.delta", { job_id: "j", text: "hi" })
        expect(good).toHaveBeenCalled()
        expect(spy).toHaveBeenCalled()
        es.emit("job.delta", "")
        expect(good).toHaveBeenCalledTimes(2)
        spy.mockRestore()
    })

    it("handles unnamed messages carrying a type", () => {
        const stream = createEventStream({ EventSource: FakeEventSource })
        const fn = jest.fn()
        stream.on("task.created", fn)
        stream.start()
        const es = FakeEventSource.last()
        es.onmessage({
            data: JSON.stringify({
                type: "task.created",
                task_id: 2,
                data: {},
            }),
        })
        es.onmessage({ data: "garbage" })
        es.onmessage({ data: JSON.stringify({ nope: 1 }) })
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it("reconnects with exponential backoff and signals reconnection", () => {
        const timers = fakeTimers()
        const stream = createEventStream({
            EventSource: FakeEventSource,
            timers,
            initialDelay: 100,
            maxDelay: 350,
        })
        const reconnected = jest.fn()
        stream.on("stream.reconnected", reconnected)
        stream.start()
        const first = FakeEventSource.last()
        first.onopen()
        first.onerror()
        expect(first.closed).toBe(true)
        expect(stream.status).toBe("reconnecting")
        expect(timers.pending[0].ms).toBe(100)
        timers.runNext()
        const second = FakeEventSource.last()
        expect(second).not.toBe(first)
        second.onerror()
        expect(timers.pending[0].ms).toBe(200)
        timers.runNext()
        FakeEventSource.last().onerror()
        expect(timers.pending[0].ms).toBe(350) // capped
        timers.runNext()
        const fourth = FakeEventSource.last()
        fourth.onopen()
        expect(reconnected).toHaveBeenCalledTimes(1)
        expect(stream.nextDelay).toBe(100) // reset after open
    })

    it("close() stops reconnects and is idempotent with start()", () => {
        const timers = fakeTimers()
        const stream = createEventStream({
            EventSource: FakeEventSource,
            timers,
        })
        stream.start()
        stream.start() // no second connection
        expect(FakeEventSource.instances).toHaveLength(1)
        const es = FakeEventSource.last()
        es.onerror()
        stream.close()
        expect(timers.clearTimeout).toHaveBeenCalled()
        expect(stream.status).toBe("closed")
        es.onerror() // late error after close is ignored
        expect(FakeEventSource.instances).toHaveLength(1)
    })

    it("a scheduled reconnect after close does nothing", () => {
        const timers = fakeTimers()
        const stream = createEventStream({
            EventSource: FakeEventSource,
            timers,
        })
        stream.start()
        FakeEventSource.last().onerror()
        const t = timers.pending[0]
        stream.close()
        t.fn()
        expect(FakeEventSource.instances).toHaveLength(1)
    })

    it("double error clears the previous timer", () => {
        const timers = fakeTimers()
        const stream = createEventStream({
            EventSource: FakeEventSource,
            timers,
        })
        stream.start()
        const es = FakeEventSource.last()
        es.onerror()
        // simulate a second error from the same (already closed) source
        es.onerror()
        expect(timers.clearTimeout).toHaveBeenCalledWith(timers.pending[0])
    })

    it("stays closed without an EventSource implementation", () => {
        const saved = globalThis.EventSource
        delete globalThis.EventSource
        const stream = createEventStream()
        stream.start()
        expect(stream.status).toBe("closed")
        globalThis.EventSource = saved
    })

    it("uses default timers", () => {
        jest.useFakeTimers()
        const stream = createEventStream({
            EventSource: FakeEventSource,
            initialDelay: 10,
        })
        stream.start()
        FakeEventSource.last().onerror()
        jest.advanceTimersByTime(10)
        expect(FakeEventSource.instances).toHaveLength(2)
        stream.close()
        jest.useRealTimers()
    })
})

describe("onError", () => {
    it("notifies every connection error and survives broken handlers", () => {
        const timers = fakeTimers()
        const stream = createEventStream({
            EventSource: FakeEventSource,
            timers,
        })
        const errors = jest.fn()
        const broken = jest.fn(() => {
            throw new Error("handler bug")
        })
        const spy = jest.spyOn(console, "error").mockImplementation(() => {})
        const offBroken = stream.onError(broken)
        const off = stream.onError(errors)
        stream.start()
        FakeEventSource.last().onerror()
        timers.runNext()
        FakeEventSource.last().onerror()
        expect(errors).toHaveBeenCalledTimes(2)
        expect(spy).toHaveBeenCalled()
        off()
        offBroken()
        timers.runNext()
        FakeEventSource.last().onerror()
        expect(errors).toHaveBeenCalledTimes(2)
        stream.close()
        spy.mockRestore()
    })

    it("delivers task.hidden events", () => {
        const stream = createEventStream({ EventSource: FakeEventSource })
        const fn = jest.fn()
        stream.on("task.hidden", fn)
        stream.start()
        FakeEventSource.last().emit("task.hidden", {
            type: "task.hidden",
            task_id: 7,
            data: { task_id: 7 },
        })
        expect(fn).toHaveBeenCalledWith(
            expect.objectContaining({ type: "task.hidden", task_id: 7 })
        )
        stream.close()
    })
})

describe("shared stream", () => {
    it("is lazily created and replaceable", () => {
        const prev = setEventStream(null)
        const a = getEventStream()
        expect(getEventStream()).toBe(a)
        const fake = { on: () => () => {} }
        expect(setEventStream(fake)).toBe(a)
        expect(getEventStream()).toBe(fake)
        setEventStream(prev)
    })
})
