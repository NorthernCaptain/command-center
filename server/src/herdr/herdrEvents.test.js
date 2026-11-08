/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { EventEmitter } from "node:events"
import os from "node:os"
import { jest } from "@jest/globals"
import { createFakeClock } from "../util/clock.js"
import {
    buildSubscriptions,
    createHerdrEvents,
    parseEvent,
} from "./herdrEvents.js"

class FakeSocket extends EventEmitter {
    constructor() {
        super()
        this.written = []
        this.destroyed = false
    }
    write(line) {
        this.written.push(JSON.parse(line))
    }
    send(obj) {
        this.emit("data", Buffer.from(JSON.stringify(obj) + "\n"))
    }
    ack() {
        this.send({
            id: this.written[0].id,
            result: { type: "subscription_started" },
        })
    }
    subscriptions() {
        return this.written[0].params.subscriptions
    }
    destroy() {
        if (this.destroyed) return
        this.destroyed = true
        this.emit("close")
    }
}

function setup(opts = {}) {
    const sockets = []
    const connect = jest.fn(() => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
    })
    const clock = createFakeClock()
    const client = { agentList: jest.fn(async () => []) }
    const log = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }
    const ev = createHerdrEvents({
        socketPath: "/s.sock",
        connect,
        clock,
        client,
        log,
        pollMs: 10000,
        backoffMs: [1000, 2000],
        ...opts,
    })
    const got = []
    for (const name of ["status", "exited", "closed", "resync"])
        ev.on(name, (p) => got.push([name, p]))
    const last = () => sockets[sockets.length - 1]
    return { ev, sockets, connect, clock, client, log, got, last }
}

const statusEvent = (pane, status, ws = "wE") => ({
    event: "pane.agent_status_changed",
    data: { pane_id: pane, workspace_id: ws, agent_status: status },
})

test("buildSubscriptions: base types plus one status sub per pane", () => {
    expect(buildSubscriptions(new Set(["wE:p1", "wF:p2"]))).toEqual([
        { type: "workspace.closed" },
        { type: "pane.exited" },
        { type: "pane.closed" },
        { type: "pane.agent_status_changed", pane_id: "wE:p1" },
        { type: "pane.agent_status_changed", pane_id: "wF:p2" },
    ])
    expect(buildSubscriptions([])).toHaveLength(3)
})

describe("parseEvent", () => {
    const want = {
        kind: "pane_agent_status_changed",
        paneId: "wE:p1",
        workspaceId: "wE",
        status: "idle",
    }
    const fields = {
        pane_id: "wE:p1",
        workspace_id: "wE",
        agent_status: "idle",
    }
    test.each([
        [
            "subscription envelope",
            { event: "pane.agent_status_changed", data: fields },
        ],
        [
            "event envelope",
            {
                event: "pane_agent_status_changed",
                data: { type: "pane_agent_status_changed", ...fields },
            },
        ],
        ["flat", { event: "pane.agent_status_changed", ...fields }],
        ["type + data", { type: "pane.agent_status_changed", data: fields }],
        [
            "method event params",
            {
                method: "event",
                params: { event: "pane.agent_status_changed", data: fields },
            },
        ],
        [
            "method = kind",
            { method: "pane.agent_status_changed", params: fields },
        ],
        [
            "generic event with typed data",
            {
                event: "event",
                data: { type: "pane_agent_status_changed", ...fields },
            },
        ],
    ])("%s", (_name, msg) => {
        expect(parseEvent(msg)).toEqual(want)
    })

    test("workspace_closed reads workspace_id or workspace.workspace_id", () => {
        expect(
            parseEvent({
                event: "workspace.closed",
                data: { workspace_id: "wE" },
            })
        ).toMatchObject({ kind: "workspace_closed", workspaceId: "wE" })
        expect(
            parseEvent({
                event: "workspace_closed",
                data: { workspace: { workspace_id: "wF" } },
            })
        ).toMatchObject({ workspaceId: "wF", paneId: null, status: null })
    })

    test("ignores unknown / malformed", () => {
        expect(parseEvent(null)).toBeNull()
        expect(parseEvent("x")).toBeNull()
        expect(parseEvent({ event: "pane.focused", data: {} })).toBeNull()
        expect(parseEvent({ id: "1", result: { type: "pong" } })).toBeNull()
        expect(parseEvent({ event: 5 })).toBeNull()
    })
})

test("start subscribes, emits resync on ack, then status events", async () => {
    const { ev, connect, sockets, got, last } = setup()
    ev.track(["wE:p1"])
    expect(connect).not.toHaveBeenCalled()
    ev.start()
    ev.start() // idempotent
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith("/s.sock")
    const sub = sockets[0].written[0]
    expect(sub.method).toBe("events.subscribe")
    expect(sockets[0].subscriptions()).toEqual(buildSubscriptions(["wE:p1"]))
    expect(ev.isConnected()).toBe(false)
    last().ack()
    expect(ev.isConnected()).toBe(true)
    expect(got).toEqual([["resync", {}]])

    last().send(statusEvent("wE:p1", "working"))
    last().send(statusEvent("wE:p1", "working")) // dedupe
    last().send(statusEvent("wE:p1", "idle"))
    last().send(statusEvent("wX:p9", "idle")) // untracked
    last().send({ event: "pane.focused", data: {} }) // ignored
    expect(got.slice(1)).toEqual([
        ["status", { paneId: "wE:p1", workspaceId: "wE", status: "working" }],
        ["status", { paneId: "wE:p1", workspaceId: "wE", status: "idle" }],
    ])
    ev.stop()
})

test("exited / closed events; pane reported once", () => {
    const { ev, got, last } = setup()
    ev.track(["wE:p1"])
    ev.start()
    last().ack()
    got.length = 0
    last().send(statusEvent("wE:p1", "working"))
    last().send({
        event: "pane_exited",
        data: { type: "pane_exited", pane_id: "wE:p1", workspace_id: "wE" },
    })
    last().send({ event: "pane.closed", data: { pane_id: "wE:p1" } })
    last().send({ event: "pane.closed", data: { pane_id: "wZ:p3" } })
    last().send({ event: "pane.closed", data: { pane_id: "wZ:p3" } })
    last().send({ event: "pane.exited", data: {} }) // no pane id
    last().send({ event: "workspace.closed", data: { workspace_id: "wE" } })
    last().send({ event: "workspace.closed", data: {} }) // no id
    // status after exit is reported again (same value)
    last().send(statusEvent("wE:p1", "working"))
    expect(got).toEqual([
        ["status", { paneId: "wE:p1", workspaceId: "wE", status: "working" }],
        ["exited", { paneId: "wE:p1" }],
        ["exited", { paneId: "wZ:p3" }],
        ["exited", { paneId: "wZ:p3" }],
        ["closed", { workspaceId: "wE" }],
        ["status", { paneId: "wE:p1", workspaceId: "wE", status: "working" }],
    ])
    ev.stop()
})

test("track reconnects with the new set only when it changed", () => {
    const { ev, sockets, last } = setup()
    ev.start()
    last().ack()
    expect(ev.track(["a", "b"])).toBe(true)
    expect(sockets).toHaveLength(2)
    expect(sockets[0].destroyed).toBe(true)
    expect(
        last()
            .subscriptions()
            .map((s) => s.pane_id)
    ).toEqual([undefined, undefined, undefined, "a", "b"])
    expect(ev.isConnected()).toBe(false)
    last().ack()
    expect(ev.track(["b", "a", null])).toBe(false)
    expect(sockets).toHaveLength(2)
    expect(ev.track(["b"])).toBe(true)
    expect(sockets).toHaveLength(3)
    expect(ev.tracked()).toEqual(["b"])
    expect(ev.track(["c"])).toBe(true) // same size, different set
    expect(ev.track()).toBe(true)
    expect(ev.tracked()).toEqual([])
    ev.stop()
})

test("track drops dedupe state of removed panes", () => {
    const { ev, got, last } = setup()
    ev.track(["a"])
    ev.start()
    last().ack()
    last().send(statusEvent("a", "idle"))
    ev.track([])
    ev.track(["a"])
    last().ack()
    last().send(statusEvent("a", "idle"))
    expect(got.filter(([n]) => n === "status")).toHaveLength(2)
    ev.stop()
})

test("disconnect: backoff reconnect, poll fallback, resync on reconnect", async () => {
    const { ev, sockets, clock, client, got, last, log } = setup({
        backoffMs: [1000, 2000],
        pollMs: 500,
    })
    ev.track(["wE:p1", "wE:p2"])
    ev.start()
    last().ack()
    last().send(statusEvent("wE:p1", "working"))
    got.length = 0

    last().emit("close")
    expect(ev.isConnected()).toBe(false)
    expect(log.warn).toHaveBeenCalled()
    client.agentList.mockResolvedValue([
        { paneId: "wE:p1", workspaceId: "wE", status: "idle" },
    ])
    // poll at 500 (before the 1000 reconnect)
    await clock.advance(500)
    expect(client.agentList).toHaveBeenCalledTimes(1)
    expect(got).toEqual([
        ["status", { paneId: "wE:p1", workspaceId: "wE", status: "idle" }],
        ["exited", { paneId: "wE:p2" }],
        ["resync", {}],
    ])
    got.length = 0
    // second poll: nothing changed -> only resync, no duplicate exited
    await clock.advance(500)
    expect(got).toEqual([["resync", {}]])
    expect(sockets).toHaveLength(2) // reconnect fired at 1000
    // reconnect attempt fails -> next backoff 2000
    last().emit("error", new Error("ECONNREFUSED"))
    last().emit("close") // ignored (stale generation)
    await clock.advance(1999)
    expect(sockets).toHaveLength(2)
    await clock.advance(1)
    expect(sockets).toHaveLength(3)
    // further failures stay on the last backoff value
    last().emit("close")
    await clock.advance(2000)
    expect(sockets).toHaveLength(4)
    got.length = 0
    last().ack()
    expect(got).toEqual([["resync", {}]])
    const polls = client.agentList.mock.calls.length
    await clock.advance(5000)
    expect(client.agentList).toHaveBeenCalledTimes(polls) // poll stopped
    // backoff reset after a successful subscribe
    last().emit("close")
    await clock.advance(1000)
    expect(sockets).toHaveLength(5)
    ev.stop()
    expect(clock.pending()).toBe(0)
})

test("poll errors are logged and polling continues; no client -> no poll", async () => {
    const { ev, clock, client, log, last } = setup({
        pollMs: 100,
        backoffMs: [100000],
    })
    ev.track(["a"])
    ev.start()
    client.agentList.mockRejectedValue(new Error("down"))
    last().emit("close")
    await clock.advance(100)
    await clock.advance(100)
    expect(client.agentList).toHaveBeenCalledTimes(2)
    expect(log.debug).toHaveBeenCalled()
    ev.stop()

    const s = setup({ client: null, pollMs: 100, backoffMs: [100000] })
    s.ev.start()
    s.last().emit("close")
    await s.clock.advance(300)
    expect(s.client.agentList).not.toHaveBeenCalled()
    s.ev.stop()
})

test("poll result arriving after reconnect is dropped", async () => {
    let release
    const { ev, clock, client, got, last } = setup({
        pollMs: 100,
        backoffMs: [50],
    })
    ev.track(["a"])
    ev.start()
    last().emit("close")
    await clock.advance(50) // reconnect opened, not acknowledged yet
    client.agentList.mockImplementation(
        () =>
            new Promise((r) => {
                release = r
            })
    )
    const adv = clock.advance(50) // poll at 100 starts and waits
    last().ack()
    expect(ev.isConnected()).toBe(true)
    got.length = 0
    release([])
    await adv
    expect(got).toEqual([])
    expect(clock.pending()).toBe(0)
    ev.stop()
})

test("subscribe error or missing ack -> reconnect with backoff", async () => {
    const { ev, sockets, clock, last } = setup({
        backoffMs: [1000],
        ackTimeoutMs: 3000,
    })
    ev.start()
    last().send({
        id: last().written[0].id,
        error: { code: "invalid_params", message: "x" },
    })
    expect(sockets[0].destroyed).toBe(true)
    await clock.advance(1000)
    expect(sockets).toHaveLength(2)
    await clock.advance(3000) // no ack
    expect(sockets[1].destroyed).toBe(true)
    await clock.advance(1000)
    expect(sockets).toHaveLength(3)
    ev.stop()
})

test("bad lines are logged; events with the subscription id are events", () => {
    const { ev, got, log, last } = setup()
    ev.track(["a"])
    ev.start()
    last().emit("data", "garbage\n")
    expect(log.warn).toHaveBeenCalled()
    last().ack()
    last().send({ id: last().written[0].id, ...statusEvent("a", "blocked") })
    expect(got.at(-1)).toEqual([
        "status",
        { paneId: "a", workspaceId: "wE", status: "blocked" },
    ])
    ev.stop()
})

test("connect throwing schedules a reconnect", async () => {
    const clock = createFakeClock()
    let n = 0
    const sockets = []
    const ev = createHerdrEvents({
        clock,
        backoffMs: [10],
        connect: () => {
            if (n++ === 0) throw new Error("ENOENT")
            const s = new FakeSocket()
            sockets.push(s)
            return s
        },
    })
    ev.start()
    expect(sockets).toHaveLength(0)
    await clock.advance(10)
    expect(sockets).toHaveLength(1)
    ev.stop()
})

test("listener errors are contained; destroy errors are ignored", () => {
    const { ev, log, last } = setup()
    ev.on("resync", () => {
        throw new Error("listener bug")
    })
    ev.start()
    const s = last()
    s.destroy = () => {
        throw new Error("x")
    }
    s.ack()
    expect(log.error).toHaveBeenCalled()
    expect(() => ev.stop()).not.toThrow()
})

test("stop prevents reconnect and ignores late events", async () => {
    const { ev, sockets, clock, got, last } = setup()
    ev.track(["a"])
    ev.start()
    const s = last()
    s.ack()
    ev.stop()
    expect(s.destroyed).toBe(true)
    got.length = 0
    s.send(statusEvent("a", "idle"))
    await clock.advance(60000)
    expect(sockets).toHaveLength(1)
    expect(got).toEqual([])
    ev.track(["b"]) // not running: just updates the set
    expect(sockets).toHaveLength(1)
    expect(ev.tracked()).toEqual(["b"])
})

test("track while a reconnect is pending waits for it", async () => {
    const { ev, sockets, clock, last } = setup({ backoffMs: [1000] })
    ev.start()
    last().emit("close")
    ev.track(["x"])
    expect(sockets).toHaveLength(1)
    await clock.advance(1000)
    expect(last().subscriptions().at(-1)).toEqual({
        type: "pane.agent_status_changed",
        pane_id: "x",
    })
    ev.stop()
})

test("default socket path is expanded", () => {
    const connect = jest.fn(() => new FakeSocket())
    const ev = createHerdrEvents({ connect, clock: createFakeClock() })
    ev.start()
    expect(connect).toHaveBeenCalledWith(
        `${os.homedir()}/.config/herdr/herdr.sock`
    )
    ev.stop()
})
