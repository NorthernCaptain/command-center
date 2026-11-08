/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { EventEmitter } from "node:events"
import os from "node:os"
import { jest } from "@jest/globals"
import { createFakeClock } from "../util/clock.js"
import { AppError } from "../util/errors.js"
import {
    agentReady,
    createHerdrClient,
    createLineParser,
    expandHome,
    HerdrError,
    toAgentInfo,
} from "./herdrClient.js"

class FakeSocket extends EventEmitter {
    constructor(reply) {
        super()
        this.reply = reply
        this.written = []
        this.destroyed = false
    }
    write(line) {
        this.written.push(line)
        const req = JSON.parse(line)
        if (this.reply) queueMicrotask(() => this.reply(req, this))
    }
    send(obj) {
        this.emit("data", Buffer.from(JSON.stringify(obj) + "\n"))
    }
    destroy() {
        if (this.destroyed) return
        this.destroyed = true
        this.emit("close")
    }
}

/** connect factory answering each request with handler(req) -> {result}|{error}. */
function fakeServer(handler) {
    const sockets = []
    const connect = jest.fn(() => {
        const s = new FakeSocket((req, sock) => {
            const out = handler(req)
            if (out === undefined) return
            sock.send({ id: req.id, ...out })
        })
        sockets.push(s)
        return s
    })
    const requests = () => sockets.map((s) => JSON.parse(s.written[0]))
    return { connect, sockets, requests }
}

const AGENT = {
    agent: "claude",
    agent_status: "idle",
    agent_session: {
        source: "claude",
        agent: "claude",
        kind: "id",
        value: "uuid-1",
    },
    pane_id: "wE:p1",
    workspace_id: "wE",
    cwd: "/tree",
    name: "t1-x",
}

function client(handler, opts = {}) {
    const srv = fakeServer(handler)
    const clock = createFakeClock()
    const c = createHerdrClient({
        socketPath: "/tmp/h.sock",
        connect: srv.connect,
        clock,
        ...opts,
    })
    return { c, srv, clock }
}

/** Let queued socket I/O settle, then move the fake clock. */
async function settleAndAdvance(clock, ms) {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    await clock.advance(ms)
}

test("expandHome", () => {
    expect(expandHome("~/a/b", "/home/x")).toBe("/home/x/a/b")
    expect(expandHome("~", "/home/x")).toBe("/home/x")
    expect(expandHome("/abs")).toBe("/abs")
    expect(expandHome("~/x")).toBe(`${os.homedir()}/x`)
    expect(expandHome(undefined)).toBeUndefined()
})

test("default socket path is expanded", () => {
    const c = createHerdrClient()
    expect(c.socketPath).toBe(`${os.homedir()}/.config/herdr/herdr.sock`)
})

test("toAgentInfo normalizes and tolerates missing fields", () => {
    expect(toAgentInfo(AGENT)).toEqual({
        name: "t1-x",
        kind: "claude",
        status: "idle",
        sessionId: "uuid-1",
        paneId: "wE:p1",
        workspaceId: "wE",
        cwd: "/tree",
    })
    expect(toAgentInfo({})).toEqual({
        name: null,
        kind: null,
        status: "unknown",
        sessionId: null,
        paneId: null,
        workspaceId: null,
        cwd: null,
    })
    expect(toAgentInfo(null)).toBeNull()
    expect(toAgentInfo("x")).toBeNull()
})

test("HerdrError carries code, method and http status", () => {
    const e = new HerdrError("timeout", "t", { method: "ping" })
    expect(e).toBeInstanceOf(AppError)
    expect(e).toBeInstanceOf(Error)
    expect(e).toMatchObject({ code: "timeout", method: "ping", status: 504 })
    expect(new HerdrError("agent_blocked", "b").status).toBe(502)
    const cause = new Error("c")
    expect(new HerdrError("socket", "s", { cause }).cause).toBe(cause)
})

test("request writes one JSON line per connection and resolves result", async () => {
    const { c, srv } = client((req) => ({ result: { echo: req.params } }))
    await expect(c.request("x.y", { a: 1 })).resolves.toEqual({
        echo: { a: 1 },
    })
    await expect(c.request("x.z")).resolves.toEqual({ echo: {} })
    expect(srv.connect).toHaveBeenCalledTimes(2)
    expect(srv.connect).toHaveBeenCalledWith("/tmp/h.sock")
    const [r1, r2] = srv.requests()
    expect(r1).toMatchObject({ method: "x.y", params: { a: 1 } })
    expect(r1.id).not.toBe(r2.id)
    expect(srv.sockets[0].written[0].endsWith("\n")).toBe(true)
    expect(srv.sockets.every((s) => s.destroyed)).toBe(true)
})

test("request: missing result resolves {}", async () => {
    const { c } = client(() => ({}))
    await expect(c.request("m")).resolves.toEqual({})
})

test("request parses responses split across chunks and skips noise", async () => {
    const srv = fakeServer(() => undefined)
    const c = createHerdrClient({
        socketPath: "/s",
        connect: srv.connect,
        clock: createFakeClock(),
    })
    const p = c.request("m")
    const sock = srv.sockets[0]
    const id = JSON.parse(sock.written[0]).id
    const line = JSON.stringify({ id, result: { ok: "é" } }) + "\n"
    const buf = Buffer.from(
        "\n" + JSON.stringify({ id: "other", result: {} }) + "\n" + line
    )
    // split inside the multi-byte character
    const cut = buf.indexOf(Buffer.from("é")) + 1
    sock.emit("data", buf.subarray(0, cut))
    sock.emit("data", buf.subarray(cut))
    await expect(p).resolves.toEqual({ ok: "é" })
})

test("request accepts a final line without newline before close", async () => {
    const srv = fakeServer(() => undefined)
    const c = createHerdrClient({
        connect: srv.connect,
        clock: createFakeClock(),
    })
    const p = c.request("m")
    const sock = srv.sockets[0]
    const id = JSON.parse(sock.written[0]).id
    sock.emit("data", JSON.stringify({ id, result: { v: 1 } }))
    sock.emit("close")
    await expect(p).resolves.toEqual({ v: 1 })
})

test("request maps herdr errors to HerdrError", async () => {
    const { c } = client(() => ({
        error: { code: "agent_blocked", message: "blocked" },
    }))
    const err = await c.request("agent.prompt", {}).catch((e) => e)
    expect(err).toBeInstanceOf(HerdrError)
    expect(err).toMatchObject({
        code: "agent_blocked",
        message: "blocked",
        method: "agent.prompt",
        details: { code: "agent_blocked", message: "blocked" },
    })
    const { c: c2 } = client(() => ({ error: {} }))
    await expect(c2.request("m")).rejects.toMatchObject({
        code: "herdr_error",
        message: "herdr_error",
    })
})

test("request rejects on invalid JSON", async () => {
    const srv = fakeServer(() => undefined)
    const c = createHerdrClient({
        connect: srv.connect,
        clock: createFakeClock(),
    })
    const p = c.request("m")
    srv.sockets[0].emit("data", "not json\n")
    await expect(p).rejects.toMatchObject({ code: "protocol", method: "m" })
})

test("request rejects with socket on error / early close / connect throw", async () => {
    const srv = fakeServer(() => undefined)
    const c = createHerdrClient({
        connect: srv.connect,
        clock: createFakeClock(),
    })
    const p1 = c.request("m")
    const cause = new Error("ENOENT")
    srv.sockets[0].emit("error", cause)
    const e1 = await p1.catch((e) => e)
    expect(e1).toMatchObject({ code: "socket" })
    expect(e1.cause).toBe(cause)

    const p2 = c.request("m")
    srv.sockets[1].emit("close")
    await expect(p2).rejects.toMatchObject({ code: "socket" })

    const c3 = createHerdrClient({
        connect: () => {
            throw new Error("boom")
        },
        clock: createFakeClock(),
    })
    await expect(c3.request("m")).rejects.toMatchObject({
        code: "socket",
        message: expect.stringContaining("boom"),
    })
})

test("request survives a socket whose destroy throws", async () => {
    const c = createHerdrClient({
        clock: createFakeClock(),
        connect: () => {
            const s = new FakeSocket((req, sock) =>
                sock.send({ id: req.id, result: { ok: true } })
            )
            s.destroy = () => {
                throw new Error("x")
            }
            return s
        },
    })
    await expect(c.request("m")).resolves.toEqual({ ok: true })
})

test("request times out with the per-call or default timeout", async () => {
    const { c, clock, srv } = client(() => undefined, { timeoutMs: 1000 })
    const p = c.request("m")
    const p2 = c.request("m2", {}, { timeoutMs: 5000 })
    await clock.advance(1000)
    await expect(p).rejects.toMatchObject({ code: "timeout", method: "m" })
    expect(srv.sockets[0].destroyed).toBe(true)
    expect(srv.sockets[1].destroyed).toBe(false)
    await clock.advance(4000)
    await expect(p2).rejects.toMatchObject({ code: "timeout" })
})

test("ping checks the protocol", async () => {
    const { c } = client(() => ({
        result: { type: "pong", version: "0.9.5", protocol: 22 },
    }))
    await expect(c.ping()).resolves.toEqual({ version: "0.9.5", protocol: 22 })
    const { c: c2 } = client(() => ({
        result: { type: "pong", version: "1.0", protocol: 23 },
    }))
    await expect(c2.ping()).rejects.toMatchObject({
        code: "protocol",
        method: "ping",
    })
})

test("workspaceCreate sends params and extracts ids defensively", async () => {
    const { c, srv } = client(() => ({
        result: {
            type: "workspace_created",
            workspace: { workspace_id: "wE" },
            tab: { tab_id: "wE:t1" },
            root_pane: { pane_id: "wE:p1" },
        },
    }))
    await expect(
        c.workspaceCreate({ cwd: "/tree", label: "T-1 x", env: { A: "1" } })
    ).resolves.toEqual({ workspaceId: "wE", tabId: "wE:t1", paneId: "wE:p1" })
    expect(srv.requests()[0]).toMatchObject({
        method: "workspace.create",
        params: { cwd: "/tree", label: "T-1 x", env: { A: "1" }, focus: false },
    })

    const { c: c2 } = client(() => ({
        result: { workspace: { id: "w2" }, tab: null, root_pane: "w2:p1" },
    }))
    await expect(c2.workspaceCreate()).resolves.toEqual({
        workspaceId: "w2",
        tabId: null,
        paneId: "w2:p1",
    })

    const { c: c3 } = client(() => ({ result: { workspace: {} } }))
    await expect(c3.workspaceCreate({})).rejects.toMatchObject({
        code: "protocol",
        method: "workspace.create",
    })
})

test("workspaceClose / reportMetadata / agentFocus params", async () => {
    const { c, srv } = client(() => ({ result: { type: "ok" } }))
    await c.workspaceClose("wE")
    await c.reportMetadata("wE", {
        task: "T-1",
        n: 3,
        gone: null,
        u: undefined,
    })
    await c.reportMetadata("wE", {}, { ttlMs: 60000 })
    await c.reportMetadata("wE")
    await c.agentFocus("t1-x")
    const r = srv.requests()
    expect(r[0]).toMatchObject({
        method: "workspace.close",
        params: { workspace_id: "wE" },
    })
    expect(r[1].params).toEqual({
        workspace_id: "wE",
        source: "command-center",
        tokens: { task: "T-1", n: "3", gone: null, u: null },
    })
    expect(r[2].params).toEqual({
        workspace_id: "wE",
        source: "command-center",
        tokens: {},
        ttl_ms: 60000,
    })
    expect(r[3].params.tokens).toEqual({})
    expect(r[4]).toMatchObject({
        method: "agent.focus",
        params: { target: "t1-x" },
    })
})

test("agentStart sends timeout_ms and waits longer on the socket", async () => {
    const { c, srv, clock } = client(() => undefined, {
        startTimeoutMs: 30000,
    })
    const p = c.agentStart({ name: "t1-x", kind: "claude", paneId: "wE:p1" })
    expect(srv.requests()[0]).toMatchObject({
        method: "agent.start",
        params: {
            name: "t1-x",
            kind: "claude",
            pane_id: "wE:p1",
            args: [],
            timeout_ms: 30000,
        },
    })
    await clock.advance(30000)
    expect(srv.sockets[0].destroyed).toBe(false)
    await clock.advance(5000)
    await expect(p).rejects.toMatchObject({ code: "timeout" })

    const { c: c2, srv: s2 } = client(() => ({
        result: { type: "agent_started", agent: AGENT, argv: [] },
    }))
    await expect(
        c2.agentStart({
            name: "t1-x",
            kind: "codex",
            paneId: "p",
            args: ["resume", "id"],
            timeoutMs: 9000,
        })
    ).resolves.toMatchObject({ type: "agent_started" })
    expect(s2.requests()[0].params).toMatchObject({
        args: ["resume", "id"],
        timeout_ms: 9000,
    })
    await expect(c2.agentStart()).resolves.toBeTruthy()
})

test("agentReady: interactive_ready, launch_pending, name, old servers", () => {
    expect(agentReady(null)).toBe(false)
    expect(agentReady({ ...AGENT, interactive_ready: true }, "t1-x")).toBe(true)
    expect(agentReady({ ...AGENT, interactive_ready: true }, "other")).toBe(
        false
    )
    expect(agentReady({ ...AGENT, interactive_ready: false })).toBe(false)
    expect(
        agentReady({ ...AGENT, interactive_ready: true, launch_pending: true })
    ).toBe(false)
    // a server without the readiness fields: idle / done count as ready
    expect(agentReady({ ...AGENT, agent_status: "done" })).toBe(true)
    expect(agentReady({ ...AGENT, agent_status: "unknown" })).toBe(false)
    expect(agentReady({ ...AGENT, name: undefined }, "t1-x")).toBe(true)
})

test("agentStart waits for interactive readiness before resolving", async () => {
    const pending = {
        ...AGENT,
        agent_status: "unknown",
        interactive_ready: false,
        launch_pending: true,
    }
    let gets = 0
    const { c, srv, clock } = client(
        (req) => {
            if (req.method === "agent.start")
                return {
                    result: { type: "agent_started", agent: pending, argv: [] },
                }
            gets++
            if (gets === 1)
                return {
                    error: { code: "agent_not_found", message: "no agent" },
                }
            if (gets === 2)
                return { result: { type: "agent_info", agent: pending } }
            return {
                result: {
                    type: "agent_info",
                    agent: { ...AGENT, interactive_ready: true },
                },
            }
        },
        { readyPollMs: 500 }
    )
    let done = false
    const p = c
        .agentStart({ name: "t1-x", kind: "claude", paneId: "wE:p1" })
        .then((r) => {
            done = true
            return r
        })
    for (let i = 0; i < 3; i++) await settleAndAdvance(clock, 500)
    const r = await p
    expect(done).toBe(true)
    expect(r.agent.interactive_ready).toBe(true)
    const methods = srv.requests().map((q) => q.method)
    expect(methods).toEqual([
        "agent.start",
        "agent.get",
        "agent.get",
        "agent.get",
    ])
    expect(srv.requests()[1].params).toEqual({ target: "wE:p1" })
})

test("agentStart: a startup dialog or the timeout is agent_not_ready; other errors pass through", async () => {
    const blocked = client(() => ({
        result: {
            type: "agent_started",
            agent: {
                ...AGENT,
                agent_status: "blocked",
                interactive_ready: false,
            },
            argv: [],
        },
    }))
    await expect(
        blocked.c.agentStart({ name: "t1-x", kind: "claude", paneId: "p" })
    ).rejects.toMatchObject({
        code: "agent_not_ready",
        message: expect.stringMatching(/dialog at startup/),
    })

    const slow = client(
        (req) =>
            req.method === "agent.start"
                ? { result: { type: "agent_started", agent: null, argv: [] } }
                : { error: { code: "agent_not_found", message: "no" } },
        { readyPollMs: 1000 }
    )
    const p = slow.c.agentStart({
        name: "t1-x",
        kind: "claude",
        paneId: "p",
        timeoutMs: 4000,
    })
    const caught = p.catch((e) => e)
    for (let i = 0; i < 5; i++) await settleAndAdvance(slow.clock, 1000)
    expect(await caught).toMatchObject({
        code: "agent_not_ready",
        message: expect.stringMatching(/not ready for input after 4000ms/),
    })

    const broken = client(
        (req) =>
            req.method === "agent.start"
                ? { result: { type: "agent_started", argv: [] } }
                : { error: { code: "server_error", message: "boom" } },
        { readyPollMs: 10 }
    )
    const q = broken.c
        .agentStart({ name: "t1-x", kind: "claude", paneId: "p" })
        .catch((e) => e)
    await settleAndAdvance(broken.clock, 10)
    expect(await q).toMatchObject({ code: "server_error" })
})

test("agentStart: the readiness polls are bounded by the start timeout", async () => {
    // agent.get never answers: the request is cut at the time left, and
    // the start fails as agent_not_ready, not after the 15s request timeout
    const { c, srv, clock } = client(
        (req) =>
            req.method === "agent.start"
                ? { result: { type: "agent_started", agent: null, argv: [] } }
                : undefined,
        { readyPollMs: 1000, timeoutMs: 15000 }
    )
    const p = c
        .agentStart({
            name: "t1-x",
            kind: "claude",
            paneId: "p",
            timeoutMs: 4000,
        })
        .catch((e) => e)
    await settleAndAdvance(clock, 1000) // first poll sleep
    await settleAndAdvance(clock, 3000) // agent.get cut at the 3000ms left
    const err = await p
    expect(err).toMatchObject({
        code: "agent_not_ready",
        message: expect.stringMatching(/after 4000ms/),
    })
    expect(srv.requests().map((q) => q.method)).toEqual([
        "agent.start",
        "agent.get",
    ])

    // a poll sleep longer than the time left is shortened to it
    const short = client(
        (req) =>
            req.method === "agent.start"
                ? { result: { type: "agent_started", agent: null, argv: [] } }
                : { error: { code: "agent_not_found", message: "no" } },
        { readyPollMs: 60000 }
    )
    const q = short.c
        .agentStart({
            name: "t1-x",
            kind: "claude",
            paneId: "p",
            timeoutMs: 4000,
        })
        .catch((e) => e)
    await settleAndAdvance(short.clock, 4000)
    expect(await q).toMatchObject({ code: "agent_not_ready" })
    // the sleep ended at the deadline, so no agent.get was sent after it
    expect(short.srv.requests().map((r) => r.method)).toEqual(["agent.start"])
})

test("agentStart retries while the new pane's shell is still starting", async () => {
    let starts = 0
    const { c, srv, clock } = client(
        (req) => {
            if (req.method !== "agent.start") return undefined
            starts++
            if (starts < 3)
                return {
                    error: {
                        code: "agent_pane_busy",
                        message:
                            "agent target pane p is not an available shell",
                    },
                }
            return {
                result: {
                    type: "agent_started",
                    agent: { ...AGENT, interactive_ready: true },
                    argv: [],
                },
            }
        },
        { readyPollMs: 500 }
    )
    const p = c.agentStart({ name: "t1-x", kind: "claude", paneId: "p" })
    await settleAndAdvance(clock, 500)
    await settleAndAdvance(clock, 500)
    const r = await p
    expect(r.agent.interactive_ready).toBe(true)
    expect(srv.requests().map((q) => q.method)).toEqual([
        "agent.start",
        "agent.start",
        "agent.start",
    ])

    // still busy near the deadline: a clear agent_pane_busy, and no retry
    // once less than herdr's 3s minimum is left
    const busy = client(
        () => ({ error: { code: "agent_pane_busy", message: "busy" } }),
        { readyPollMs: 1000 }
    )
    const q = busy.c
        .agentStart({
            name: "t1-x",
            kind: "claude",
            paneId: "p",
            timeoutMs: 4000,
        })
        .catch((e) => e)
    for (let i = 0; i < 5; i++) await settleAndAdvance(busy.clock, 1000)
    expect(await q).toMatchObject({
        code: "agent_pane_busy",
        message: "pane p was not at a shell prompt after 4000ms",
    })
    // 4000ms budget: the first try only (a retry would get <= 3000ms)
    expect(busy.srv.requests()).toHaveLength(1)
    expect(busy.srv.requests()[0].params.timeout_ms).toBe(4000)

    // retries get the time left, with the socket grace on top; a slow
    // busy answer that eats the budget ends the retries
    let tries = 0
    const slow = client(
        () => {
            tries++
            return { error: { code: "agent_pane_busy", message: "busy" } }
        },
        { readyPollMs: 1000 }
    )
    const sp = slow.c
        .agentStart({
            name: "t1-x",
            kind: "claude",
            paneId: "p",
            timeoutMs: 10000,
        })
        .catch((e) => e)
    await settleAndAdvance(slow.clock, 1000) // pause -> retry at t=1000
    await settleAndAdvance(slow.clock, 1000) // pause -> retry at t=2000
    const sent = slow.srv.requests()
    expect(sent.map((x) => x.params.timeout_ms)).toEqual([10000, 9000, 8000])
    for (let i = 0; i < 8; i++) await settleAndAdvance(slow.clock, 1000)
    const serr = await sp
    expect(serr).toMatchObject({ code: "agent_pane_busy" })
    // no attempt was sent with 3000ms or less left
    expect(slow.srv.requests().every((x) => x.params.timeout_ms > 3000)).toBe(
        true
    )
    expect(tries).toBe(slow.srv.requests().length)

    // a retry whose answer never comes: its socket timeout is the time
    // left plus the grace (t = 1000 + 9000 + 5000), not a fresh full window
    let n = 0
    const hang = client(
        () =>
            ++n === 1
                ? { error: { code: "agent_pane_busy", message: "busy" } }
                : undefined,
        { readyPollMs: 1000 }
    )
    let settled = null
    hang.c
        .agentStart({
            name: "t1-x",
            kind: "claude",
            paneId: "p",
            timeoutMs: 10000,
        })
        .catch((e) => {
            settled = e
        })
    await settleAndAdvance(hang.clock, 1000) // retry sent at t=1000
    expect(hang.srv.requests()[1].params.timeout_ms).toBe(9000)
    await settleAndAdvance(hang.clock, 13999) // t=14999
    expect(settled).toBeNull()
    await settleAndAdvance(hang.clock, 1) // t=15000
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    expect(settled).toMatchObject({ code: "timeout" })

    // other start errors are not retried
    const other = client(() => ({
        error: { code: "agent_pane_not_found", message: "gone" },
    }))
    await expect(
        other.c.agentStart({ name: "t1-x", kind: "claude", paneId: "p" })
    ).rejects.toMatchObject({ code: "agent_pane_not_found" })
    expect(other.srv.requests()).toHaveLength(1)
})

test("agentPrompt with wait sends wait.timeout_ms; without wait omits it", async () => {
    const { c, srv } = client(() => ({
        result: { type: "agent_prompted", agent: AGENT },
    }))
    await c.agentPrompt("t1-x", "hello", { timeoutMs: 1000 })
    await c.agentPrompt("t1-x", "hi", { wait: false })
    await c.agentPrompt("t1-x", "hey")
    const r = srv.requests()
    expect(r[0].params).toEqual({
        target: "t1-x",
        text: "hello",
        wait: { timeout_ms: 1000 },
    })
    expect(r[1].params).toEqual({ target: "t1-x", text: "hi" })
    expect(r[2].params.wait).toEqual({ timeout_ms: 120000 })
})

test("agentPrompt never retries on stalled / timeout", async () => {
    const { c, srv } = client(() => ({
        error: { code: "agent_prompt_stalled", message: "stalled" },
    }))
    await expect(c.agentPrompt("a", "t")).rejects.toMatchObject({
        code: "agent_prompt_stalled",
    })
    expect(srv.connect).toHaveBeenCalledTimes(1)

    const { c: c2, srv: s2, clock } = client(() => undefined)
    const p = c2.agentPrompt("a", "t", { timeoutMs: 100 })
    await clock.advance(5100)
    await expect(p).rejects.toMatchObject({ code: "timeout" })
    await clock.advance(60000)
    expect(s2.connect).toHaveBeenCalledTimes(1)
})

test("agentGet returns AgentInfo, null on agent_not_found, rethrows others", async () => {
    const { c } = client((req) =>
        req.params.target === "gone"
            ? { error: { code: "agent_not_found", message: "nope" } }
            : req.params.target === "bad"
              ? { error: { code: "agent_not_ready", message: "x" } }
              : { result: { type: "agent_info", agent: AGENT } }
    )
    await expect(c.agentGet("t1-x")).resolves.toMatchObject({
        sessionId: "uuid-1",
        status: "idle",
    })
    await expect(c.agentGet("gone")).resolves.toBeNull()
    await expect(c.agentGet("bad")).rejects.toMatchObject({
        code: "agent_not_ready",
    })
})

test("agentList maps agents and tolerates a missing list", async () => {
    const { c } = client(() => ({
        result: { type: "agent_list", agents: [AGENT, null] },
    }))
    await expect(c.agentList()).resolves.toEqual([toAgentInfo(AGENT)])
    const { c: c2 } = client(() => ({ result: {} }))
    await expect(c2.agentList()).resolves.toEqual([])
})

test("agentRead requests recent text and returns it", async () => {
    const { c, srv } = client(() => ({
        result: { type: "pane_read", read: { text: "line1\nline2" } },
    }))
    await expect(c.agentRead("t1-x")).resolves.toBe("line1\nline2")
    await c.agentRead("t1-x", { lines: 40, source: "visible" })
    const r = srv.requests()
    expect(r[0]).toMatchObject({
        method: "agent.read",
        params: {
            target: "t1-x",
            source: "recent",
            lines: 80,
            format: "text",
            strip_ansi: true,
        },
    })
    expect(r[1].params).toMatchObject({ lines: 40, source: "visible" })

    const { c: c2 } = client(() => ({ result: { text: "flat" } }))
    await expect(c2.agentRead("a")).resolves.toBe("flat")
    const { c: c3 } = client(() => ({ result: {} }))
    await expect(c3.agentRead("a")).resolves.toBe("")
})

test("createLineParser stops when the handler returns false", () => {
    const seen = []
    const p = createLineParser(
        (m) => {
            seen.push(m)
            return m.n !== 1
        },
        () => true
    )
    p.push('{"n":0}\n{"n":1}\n{"n":2}\n')
    expect(seen.map((m) => m.n)).toEqual([0, 1])
    const bad = []
    const p2 = createLineParser(
        () => true,
        (l) => {
            bad.push(l)
            return bad.length < 1
        }
    )
    p2.push("x\ny\n")
    expect(bad).toEqual(["x"])
    p2.end()
})
