/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createFakeClock } from "../util/clock.js"
import {
    createAuth,
    ensureLocalToken,
    PAIR_CODE_TTL_MS,
    PAIR_GLOBAL_MAX_FAILURES,
    PAIR_MAX_FAILURES,
    PAIR_WINDOW_MS,
    parseCookies,
    publicDevice,
    safeEqual,
    serializeCookie,
    sha256,
} from "./auth.js"
import { createFakeDevicesRepo, makeConfig, OWNER } from "./testing/fakes.js"

function reqWith(headers) {
    return { headers }
}

describe("cookie helpers", () => {
    test("parseCookies", () => {
        expect(parseCookies(undefined)).toEqual({})
        expect(parseCookies(5)).toEqual({})
        expect(
            parseCookies('a=1; b="q v"; a=2; bad; =x; c=%E0%A4%A; d=%20x')
        ).toEqual({ a: "1", b: "q v", c: "%E0%A4%A", d: " x" })
    })

    test("serializeCookie", () => {
        expect(serializeCookie("n", "v w")).toBe(
            "n=v%20w; Path=/; HttpOnly; SameSite=Strict"
        )
        expect(
            serializeCookie("n", "v", {
                path: "/x",
                maxAgeMs: 1500,
                secure: true,
                httpOnly: false,
                sameSite: "Lax",
            })
        ).toBe("n=v; Path=/x; Max-Age=1; Secure; SameSite=Lax")
    })

    test("safeEqual / sha256 / publicDevice", () => {
        expect(safeEqual("abc", "abc")).toBe(true)
        expect(safeEqual("abc", "abd")).toBe(false)
        expect(safeEqual("abc", "abcd")).toBe(false)
        expect(safeEqual(null, "a")).toBe(false)
        expect(sha256("x")).toHaveLength(64)
        expect(publicDevice(null)).toBeNull()
        expect(publicDevice({ id: 1, name: "n", token_hash: "h" })).toEqual({
            id: 1,
            name: "n",
            created_at: null,
            last_seen_at: null,
            revoked_at: null,
        })
    })
})

describe("ensureLocalToken", () => {
    let dir
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-auth-"))
    })
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

    test("creates a 0600 token file with 32 random bytes hex", () => {
        const configDir = path.join(dir, "cfg")
        const token = ensureLocalToken({ configDir })
        expect(token).toMatch(/^[0-9a-f]{64}$/)
        const file = path.join(configDir, "token")
        expect(fs.statSync(file).mode & 0o777).toBe(0o600)
        expect(ensureLocalToken({ configDir })).toBe(token)
    })

    test("existing token is reused", () => {
        fs.writeFileSync(path.join(dir, "token"), "  tok \n")
        expect(ensureLocalToken({ configDir: dir })).toBe("tok")
    })

    test("empty token file is an error", () => {
        fs.writeFileSync(path.join(dir, "token"), "")
        expect(() => ensureLocalToken({ configDir: dir })).toThrow("is empty")
    })

    test("race: EEXIST reads the winner's token", () => {
        let reads = 0
        const fakeFs = {
            readFileSync() {
                reads++
                if (reads === 1) {
                    const e = new Error("missing")
                    e.code = "ENOENT"
                    throw e
                }
                return "winner\n"
            },
            mkdirSync() {},
            writeFileSync() {
                const e = new Error("exists")
                e.code = "EEXIST"
                throw e
            },
        }
        expect(ensureLocalToken({ configDir: "/x", fs: fakeFs })).toBe("winner")
    })

    test("other errors are rethrown", () => {
        const eacces = () => {
            const e = new Error("denied")
            e.code = "EACCES"
            throw e
        }
        expect(() =>
            ensureLocalToken({ configDir: "/x", fs: { readFileSync: eacces } })
        ).toThrow("denied")
        const enoent = () => {
            const e = new Error("missing")
            e.code = "ENOENT"
            throw e
        }
        expect(() =>
            ensureLocalToken({
                configDir: "/x",
                fs: {
                    readFileSync: enoent,
                    mkdirSync() {},
                    writeFileSync: eacces,
                },
            })
        ).toThrow("denied")
    })
})

describe("createAuth", () => {
    let clock, devicesRepo, auth
    beforeEach(() => {
        clock = createFakeClock()
        devicesRepo = createFakeDevicesRepo({ clock })
        auth = createAuth({
            config: makeConfig(),
            devicesRepo,
            localToken: "tok",
            clock,
        })
    })

    test("reads the token file when no token is injected", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-auth-"))
        try {
            fs.writeFileSync(path.join(dir, "token"), "filetok")
            const a = createAuth({
                config: makeConfig({ configDir: dir }),
                devicesRepo,
            })
            expect(a.localToken()).toBe("filetok")
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    test("local: bearer variants", async () => {
        const r = (h) => auth.resolve(reqWith(h), "local")
        expect((await r({ authorization: "Bearer tok" })).role).toBe("owner")
        expect((await r({ authorization: "bearer tok " })).via).toBe("bearer")
        expect((await r({ authorization: "Basic tok" })).role).toBeNull()
        expect((await r({ authorization: "Bearer" })).role).toBeNull()
        expect((await r({})).role).toBeNull()
    })

    test("unknown mode resolves to no role", async () => {
        expect(
            (await auth.resolve(reqWith({ authorization: "Bearer tok" }), "x"))
                .role
        ).toBeNull()
    })

    test("sessions are pruned and revocable", async () => {
        const s = auth.createSession()
        const r = () =>
            auth.resolve(reqWith({ cookie: `cc_session=${s}` }), "local")
        expect((await r()).via).toBe("session")
        auth.revokeSession(s)
        auth.revokeSession(undefined)
        expect((await r()).role).toBeNull()
        const s2 = auth.createSession()
        await clock.advance(31 * 24 * 3600 * 1000)
        auth.createSession() // prunes s2
        expect(
            (
                await auth.resolve(
                    reqWith({ cookie: `cc_session=${s2}` }),
                    "local"
                )
            ).role
        ).toBeNull()
    })

    test("bootstrap tokens: single use, expire, bad input", async () => {
        const { token, expires_at } = auth.createBootstrapToken()
        expect(expires_at.toISOString()).toBe("2026-11-07T12:02:00.000Z")
        expect(auth.consumeBootstrapToken(token)).toBe(true)
        expect(auth.consumeBootstrapToken(token)).toBe(false)
        expect(auth.consumeBootstrapToken(undefined)).toBe(false)
        expect(auth.consumeBootstrapToken(42)).toBe(false)
    })

    test("pair code is zero padded and stored hashed", async () => {
        const a = createAuth({
            config: makeConfig(),
            devicesRepo,
            localToken: "tok",
            clock,
            randomInt: () => 42,
        })
        const { code, expires_at } = await a.createPairCode()
        expect(code).toBe("000042")
        expect(expires_at).toBe("2026-11-07T12:10:00.000Z")
        expect(devicesRepo.codes.has(sha256("000042"))).toBe(true)
    })

    test("pair requires the configured owner", async () => {
        const noOwner = createAuth({
            config: makeConfig({ owner: {} }),
            devicesRepo,
            localToken: "tok",
            clock,
        })
        await expect(
            noOwner.pair({ code: "123456", login: OWNER })
        ).rejects.toThrow("owner login")
        await expect(auth.pair({ code: "123456", login: "" })).rejects.toThrow(
            "owner login"
        )
        await expect(auth.pair({ code: 123456, login: OWNER })).rejects.toThrow(
            "invalid or expired"
        )
    })

    test("device touch failure is logged, owner still resolved", async () => {
        const warned = []
        const a = createAuth({
            config: makeConfig(),
            devicesRepo: {
                ...devicesRepo,
                touch() {
                    throw new Error("db locked")
                },
            },
            localToken: "tok",
            clock,
            log: { warn: (o, m) => warned.push(m), info() {} },
        })
        const { code } = await a.createPairCode()
        const { token, device } = await a.pair({
            code,
            login: OWNER,
            name: "p",
        })
        expect(device.name).toBe("p")
        const who = await a.resolve(
            reqWith({
                "tailscale-user-login": OWNER,
                cookie: `cc_device=${token}`,
            }),
            "tailnet"
        )
        expect(who.role).toBe("owner")
        expect(who.device.id).toBe(device.id)
        expect(warned).toEqual(["device touch failed"])
    })

    test("non-string tailscale header is treated as missing", async () => {
        const who = await auth.resolve(
            reqWith({ "tailscale-user-login": ["a", "b"] }),
            "tailnet"
        )
        expect(who.role).toBeNull()
    })
})

describe("createAuth: pairing limits", () => {
    let clock, devicesRepo, auth, warned
    beforeEach(() => {
        clock = createFakeClock()
        devicesRepo = createFakeDevicesRepo({ clock })
        warned = []
        auth = createAuth({
            config: makeConfig(),
            devicesRepo,
            localToken: "tok",
            clock,
            log: { warn: (o, m) => warned.push(m), info() {} },
        })
    })
    const wrong = (code) => (code === "000000" ? "000001" : "000000")
    const tryPair = (code) =>
        auth.pair({ code, login: OWNER }).then(
            () => 200,
            (e) => e.status
        )

    test("failures are tied to the active code, not the login", async () => {
        const { code } = await auth.createPairCode()
        for (let i = 0; i < PAIR_MAX_FAILURES; i++)
            expect(await tryPair(wrong(code))).toBe(400)
        expect(warned).toContain("pairing code invalidated after failures")
        expect(devicesRepo.codes.get(sha256(code)).used).toBe(true)
        expect(await tryPair(code)).toBe(400)
        const fresh = await auth.createPairCode()
        expect(await tryPair(fresh.code)).toBe(200)
    })

    test("a new code supersedes the old one and resets its failures", async () => {
        const first = await auth.createPairCode()
        for (let i = 0; i < PAIR_MAX_FAILURES - 1; i++)
            await tryPair(wrong(first.code))
        const second = await auth.createPairCode()
        expect(devicesRepo.codes.get(sha256(first.code)).used).toBe(true)
        for (let i = 0; i < PAIR_MAX_FAILURES - 1; i++)
            expect(await tryPair(wrong(second.code))).toBe(400)
        expect(await tryPair(second.code)).toBe(200)
        // Used: a second attempt with the same code fails.
        expect(await tryPair(second.code)).toBe(400)
    })

    test("expired active code is rejected", async () => {
        const { code } = await auth.createPairCode()
        await clock.advance(PAIR_CODE_TTL_MS + 1)
        expect(await tryPair(code)).toBe(400)
    })

    test("no active code (e.g. after a restart) is rejected", async () => {
        await devicesRepo.pairCodes.add(
            sha256("123456"),
            "2099-01-01T00:00:00Z"
        )
        expect(await tryPair("123456")).toBe(400)
    })

    test("global cap: fresh codes still pair, misses under the cap kill them", async () => {
        for (let i = 0; i < PAIR_GLOBAL_MAX_FAILURES - 1; i++)
            expect(await tryPair("abc")).toBe(400)
        expect(await tryPair("abc")).toBe(429)
        expect(await tryPair("123456")).toBe(429)
        const fresh = await auth.createPairCode()
        expect(await tryPair(fresh.code)).toBe(200)
        const next = await auth.createPairCode()
        expect(await tryPair(wrong(next.code))).toBe(429)
        expect(await tryPair(next.code)).toBe(429)
        await clock.advance(PAIR_WINDOW_MS + 1)
        const later = await auth.createPairCode()
        expect(await tryPair(later.code)).toBe(200)
    })

    test("repo failures while burning a code are logged", async () => {
        const a = createAuth({
            config: makeConfig(),
            devicesRepo: {
                ...devicesRepo,
                pairCodes: {
                    add: devicesRepo.pairCodes.add,
                    consume() {
                        throw new Error("db locked")
                    },
                },
            },
            localToken: "tok",
            clock,
            log: { warn: (o, m) => warned.push(m) },
        })
        await a.createPairCode()
        await a.createPairCode()
        expect(warned).toEqual(["pair code invalidation failed"])
    })
})

describe("createAuth: stream registry and re-validation", () => {
    let clock, devicesRepo, auth, warned
    beforeEach(() => {
        clock = createFakeClock()
        devicesRepo = createFakeDevicesRepo({ clock })
        warned = []
        auth = createAuth({
            config: makeConfig(),
            devicesRepo,
            localToken: "tok",
            clock,
            log: { warn: (o, m) => warned.push(m), info() {} },
        })
    })

    async function pairedOwner() {
        const { code } = await auth.createPairCode()
        const { token, device } = await auth.pair({ code, login: OWNER })
        const who = await auth.resolve(
            reqWith({
                "tailscale-user-login": OWNER,
                cookie: `cc_device=${token}`,
            }),
            "tailnet"
        )
        return { who, device }
    }

    test("device credential: registry key, revoke ends streams", async () => {
        const { who, device } = await pairedOwner()
        expect(who.credential).toBe(`device:${device.id}`)
        expect(await auth.stillValid(who)).toBe(true)
        const ended = []
        const untrack = auth.trackStream(who, () => ended.push("a"))
        auth.trackStream(who, () => ended.push("b"))
        untrack()
        await devicesRepo.revoke(device.id)
        expect(await auth.stillValid(who)).toBe(false)
        expect(auth.endDeviceStreams(device.id)).toBe(1)
        expect(ended).toEqual(["b"])
        expect(auth.endDeviceStreams(device.id)).toBe(0)
        untrack() // late unregister is harmless
    })

    test("device credential whose hash now maps to another device is invalid", async () => {
        const { who } = await pairedOwner()
        expect(await auth.stillValid({ ...who, device: { id: 999 } })).toBe(
            false
        )
        expect(
            await auth.stillValid({ ...who, tokenHash: sha256("nope") })
        ).toBe(false)
    })

    test("session credential: logout ends streams; expiry invalidates", async () => {
        const raw = auth.createSession()
        const who = await auth.resolve(
            reqWith({ cookie: `cc_session=${raw}` }),
            "local"
        )
        expect(who.credential).toBe(`session:${sha256(raw)}`)
        expect(await auth.stillValid(who)).toBe(true)
        const ended = []
        auth.trackStream(who, () => {
            throw new Error("boom")
        })
        auth.trackStream(who, () => ended.push(1))
        auth.revokeSession(raw)
        expect(ended).toEqual([1])
        expect(warned).toEqual(["ending stream failed"])
        expect(await auth.stillValid(who)).toBe(false)

        const raw2 = auth.createSession()
        const who2 = await auth.resolve(
            reqWith({ cookie: `cc_session=${raw2}` }),
            "local"
        )
        await clock.advance(31 * 24 * 3600 * 1000)
        expect(await auth.stillValid(who2)).toBe(false)
    })

    test("bearer and header viewers are untracked and stay valid", async () => {
        const bearerWho = await auth.resolve(
            reqWith({ authorization: "Bearer tok" }),
            "local"
        )
        const viewer = await auth.resolve(
            reqWith({ "tailscale-user-login": "bob@x" }),
            "tailnet"
        )
        for (const who of [bearerWho, viewer]) {
            expect(who.credential).toBeUndefined()
            expect(await auth.stillValid(who)).toBe(true)
            const untrack = auth.trackStream(who, () => {})
            expect(typeof untrack).toBe("function")
            untrack()
        }
        expect(await auth.stillValid(null)).toBe(false)
        expect(await auth.stillValid({ role: null })).toBe(false)
        expect(auth.trackStream(null, () => {})).toEqual(expect.any(Function))
    })
})
