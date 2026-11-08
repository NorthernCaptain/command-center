/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    createHostGuard,
    RESOLVE_RETRY_MS,
    localHosts,
    normalizeHost,
    parsePublicBase,
} from "./hostGuard.js"

import { jest } from "@jest/globals"
import { createFakeClock } from "../util/clock.js"

const PUBLIC = "https://mac.tail.ts.net:8443"

function run(guard, headers, localPort) {
    const req = { headers, socket: { localPort } }
    try {
        let passed = false
        guard(req, {}, () => (passed = true))
        return { passed, host: req.ccHost }
    } catch (err) {
        return { status: err.status, error: err.code }
    }
}

describe("normalizeHost", () => {
    test("normalizes case and default ports", () => {
        expect(normalizeHost("MAC.ts.net:8443")).toBe("mac.ts.net:8443")
        expect(normalizeHost("mac.ts.net:443", "https:")).toBe("mac.ts.net")
        expect(normalizeHost("127.0.0.1:80")).toBe("127.0.0.1")
        expect(normalizeHost(" [::1]:7788 ")).toBe("[::1]:7788")
    })

    test("rejects anything but host[:port]", () => {
        for (const bad of [
            undefined,
            null,
            42,
            "",
            "   ",
            "a b",
            "user@host",
            "host/path",
            "host?x",
            "host#x",
            "host\\x",
            "host:99999",
            "[bad",
        ])
            expect(normalizeHost(bad)).toBeNull()
    })
})

describe("parsePublicBase", () => {
    test("accepts http(s) URLs", () => {
        expect(parsePublicBase(PUBLIC)).toEqual({
            protocol: "https:",
            host: "mac.tail.ts.net:8443",
        })
        expect(parsePublicBase("http://X.example/")).toEqual({
            protocol: "http:",
            host: "x.example",
        })
    })

    test("rejects missing, malformed and other schemes", () => {
        for (const bad of [
            undefined,
            null,
            "",
            5,
            "::bad::",
            "ftp://x",
            "file:///x",
        ])
            expect(parsePublicBase(bad)).toBeNull()
    })
})

describe("localHosts", () => {
    test("loopback names for each valid port", () => {
        expect([
            ...localHosts([7788, "7788", 0, -1, 70000, "x", undefined]),
        ]).toEqual(["127.0.0.1:7788", "localhost:7788", "[::1]:7788"])
    })
})

describe("createHostGuard", () => {
    test("tailnet: Host must be the public host; XFH must agree", () => {
        const guard = createHostGuard({
            mode: "tailnet",
            config: { publicBaseUrl: PUBLIC },
        })
        expect(run(guard, { host: "mac.tail.ts.net:8443" })).toEqual({
            passed: true,
            host: "mac.tail.ts.net:8443",
        })
        expect(
            run(guard, {
                host: "mac.tail.ts.net:8443",
                "x-forwarded-host": "MAC.tail.ts.net:8443",
            }).passed
        ).toBe(true)
        for (const headers of [
            {},
            { host: "evil.example:7789" },
            {
                host: "127.0.0.1:7789",
                "x-forwarded-host": "mac.tail.ts.net:8443",
            },
            {
                host: "mac.tail.ts.net:8443",
                "x-forwarded-host": "evil.example",
            },
            { host: "mac.tail.ts.net:8443", "x-forwarded-host": "" },
        ])
            expect(run(guard, headers)).toEqual({
                status: 421,
                error: "misdirected",
            })
    })

    test("tailnet: no publicBaseUrl is 503, logged once", () => {
        const logged = []
        const guard = createHostGuard({
            mode: "tailnet",
            config: {},
            log: { error: (o, m) => logged.push([o, m]) },
        })
        expect(run(guard, { host: "mac.tail.ts.net:8443" })).toEqual({
            status: 503,
            error: "not_configured",
        })
        run(guard, { host: "x" })
        expect(logged).toEqual([
            [
                { publicBaseUrl: null },
                "publicBaseUrl not configured: refusing tailnet requests",
            ],
        ])
        // Works without a logger too.
        const quiet = createHostGuard({ mode: "tailnet", config: {} })
        expect(run(quiet, {}).status).toBe(503)
    })

    test("local: configured port or the port the request arrived on", () => {
        const guard = createHostGuard({
            mode: "local",
            config: { listeners: { local: { port: 7788 } } },
        })
        expect(run(guard, { host: "localhost:7788" })).toEqual({
            passed: true,
            host: "localhost:7788",
        })
        expect(run(guard, { host: "127.0.0.1:5555" }, 5555).passed).toBe(true)
        expect(run(guard, { host: "127.0.0.1:5555" }, 7788).status).toBe(421)
        expect(run(guard, { host: "evil.example:7788" }, 7788).status).toBe(421)
        expect(run(guard, {}, 7788).status).toBe(421)
        // No configured port, no socket: nothing is accepted.
        const bare = createHostGuard({ mode: "local", config: {} })
        expect(run(bare, { host: "127.0.0.1:7788" }).status).toBe(421)
    })
})

/** Await an async (lazy) guard; resolves like run(). */
async function runAsync(guard, headers) {
    const req = { headers, socket: {} }
    let nextArg = "not called"
    const ret = guard(req, {}, (err) => (nextArg = err))
    await ret
    if (nextArg === "not called") return { pending: true }
    if (nextArg) return { status: nextArg.status, error: nextArg.code }
    return { passed: true, host: req.ccHost }
}

describe("createHostGuard: lazy publicBaseUrl resolution", () => {
    const HOST = { host: "mac.tail.ts.net:8443" }

    function setup(results) {
        const clock = createFakeClock()
        const config = { publicBaseUrl: null }
        const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
        const resolver = jest.fn(async () => {
            const r = results.shift()
            if (r instanceof Error) throw r
            return r
        })
        const guard = createHostGuard({
            mode: "tailnet",
            config,
            log,
            clock,
            resolvePublicBaseUrl: resolver,
        })
        return { clock, config, log, resolver, guard }
    }

    test("503 while unknown, retried at most once per minute, then cached", async () => {
        const { clock, config, log, resolver, guard } = setup([
            null,
            new Error("tailscale down"),
            "not a url",
            PUBLIC,
        ])
        const notConfigured = { status: 503, error: "not_configured" }
        // attempt 1: resolver returns null
        expect(await runAsync(guard, HOST)).toEqual(notConfigured)
        expect(resolver).toHaveBeenCalledTimes(1)
        // within the minute: no new attempt, still 503
        clock.advance(RESOLVE_RETRY_MS - 1)
        expect(await runAsync(guard, HOST)).toEqual(notConfigured)
        expect(resolver).toHaveBeenCalledTimes(1)
        // attempt 2: resolver throws -> warn, 503
        clock.advance(1)
        expect(await runAsync(guard, HOST)).toEqual(notConfigured)
        expect(resolver).toHaveBeenCalledTimes(2)
        expect(log.warn).toHaveBeenCalledWith(
            { err: "tailscale down" },
            "publicBaseUrl resolution failed"
        )
        // attempt 3: unusable URL -> 503
        clock.advance(RESOLVE_RETRY_MS)
        expect(await runAsync(guard, HOST)).toEqual(notConfigured)
        expect(config.publicBaseUrl).toBeNull()
        // attempt 4: success -> cached, written to config, Host enforced
        clock.advance(RESOLVE_RETRY_MS)
        expect(await runAsync(guard, HOST)).toEqual({
            passed: true,
            host: "mac.tail.ts.net:8443",
        })
        expect(config.publicBaseUrl).toBe(PUBLIC)
        expect(log.info).toHaveBeenCalledWith(
            { publicBaseUrl: PUBLIC },
            "tailnet URL resolved"
        )
        // cached: synchronous path, no more resolver calls
        expect(run(guard, HOST)).toEqual({
            passed: true,
            host: "mac.tail.ts.net:8443",
        })
        expect(run(guard, { host: "evil.example" })).toEqual({
            status: 421,
            error: "misdirected",
        })
        clock.advance(10 * RESOLVE_RETRY_MS)
        run(guard, HOST)
        expect(resolver).toHaveBeenCalledTimes(4)
        // the 503 was logged once
        expect(log.error).toHaveBeenCalledTimes(1)
    })

    test("the request that resolves the URL still gets the Host check", async () => {
        const { guard } = setup([PUBLIC])
        expect(
            await runAsync(guard, {
                host: "mac.tail.ts.net:8443",
                "x-forwarded-host": "evil.example",
            })
        ).toEqual({ status: 421, error: "misdirected" })
    })

    test("concurrent requests share one resolution", async () => {
        const { guard, resolver } = setup([PUBLIC])
        const [a, b] = await Promise.all([
            runAsync(guard, HOST),
            runAsync(guard, HOST),
        ])
        expect(a.passed && b.passed).toBe(true)
        expect(resolver).toHaveBeenCalledTimes(1)
    })

    test("a configured publicBaseUrl never calls the resolver", () => {
        const resolver = jest.fn()
        const guard = createHostGuard({
            mode: "tailnet",
            config: { publicBaseUrl: PUBLIC },
            resolvePublicBaseUrl: resolver,
        })
        expect(run(guard, HOST).passed).toBe(true)
        expect(resolver).not.toHaveBeenCalled()
    })

    test("works without a logger and with the system clock", async () => {
        const guard = createHostGuard({
            mode: "tailnet",
            config: {},
            resolvePublicBaseUrl: async () => {
                throw new Error("x")
            },
        })
        expect((await runAsync(guard, HOST)).status).toBe(503)
        expect((await runAsync(guard, HOST)).status).toBe(503)
    })
})

test("a resolver that throws synchronously is retried after the delay", async () => {
    const clock = createFakeClock()
    let calls = 0
    const guard = createHostGuard({
        mode: "tailnet",
        config: {},
        clock,
        resolvePublicBaseUrl: () => {
            calls++
            if (calls === 1) throw new Error("sync boom")
            return PUBLIC
        },
    })
    const HOST = { host: "mac.tail.ts.net:8443" }
    expect((await runAsync(guard, HOST)).status).toBe(503)
    clock.advance(RESOLVE_RETRY_MS)
    expect((await runAsync(guard, HOST)).passed).toBe(true)
    expect(calls).toBe(2)
})
