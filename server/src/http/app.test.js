/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import {
    createApp,
    detectSourceType,
    extractUrl,
    firstLine,
    mapError,
    normalizeRepos,
    parseTaskId,
    validateTaskPatch,
} from "./app.js"
import { AppError } from "../util/errors.js"
import { createFakeClock } from "../util/clock.js"
import { nullLogger } from "../util/logger.js"
import { createDateParser } from "../scheduler/dateParser.js"
import { createLockManager } from "../store/mutex.js"
import {
    createHarness,
    DUE,
    makeTask,
    OWNER,
    request,
    seedTasks,
    TOKEN,
} from "./testing/fakes.js"

const VIEWER = "bob@example.com"
const bearer = (r) => r.set("Authorization", `Bearer ${TOKEN}`)
const asViewer = (r) => r.set("Tailscale-User-Login", VIEWER)

async function pairDevice(h, name = "phone") {
    const { code } = await h.auth.createPairCode()
    const res = await request(h.tailnet)
        .post("/api/pair")
        .set("Tailscale-User-Login", OWNER)
        .send({ code, name })
    expect(res.status).toBe(200)
    const cookie = res.headers["set-cookie"][0]
    return {
        cookie: cookie.split(";")[0],
        raw: cookie,
        device: res.body.device,
    }
}

async function localSession(h) {
    const tok = await bearer(request(h.local).post("/api/auth/bootstrap-token"))
    const url = new URL(tok.body.url)
    const res = await request(h.local).get(url.pathname + url.search)
    return { res, cookie: res.headers["set-cookie"]?.[0].split(";")[0], url }
}

describe("helpers", () => {
    test("extractUrl / detectSourceType / firstLine", () => {
        expect(extractUrl("see https://x.slack.com/archives/C1/p2).")).toBe(
            "https://x.slack.com/archives/C1/p2"
        )
        expect(extractUrl("none")).toBeNull()
        expect(extractUrl("")).toBeNull()
        expect(detectSourceType("https://acme.slack.com/a")).toBe("slack")
        expect(detectSourceType("https://app.asana.com/0/1/2")).toBe("asana")
        expect(detectSourceType("https://github.com/a/b")).toBe("github")
        expect(detectSourceType("https://example.com")).toBeNull()
        expect(detectSourceType("not a url")).toBeNull()
        expect(detectSourceType(null)).toBeNull()
        expect(firstLine("\n  hello \nworld")).toBe("hello")
        expect(firstLine("x".repeat(200))).toHaveLength(120)
        expect(firstLine("")).toBe("")
        expect(firstLine("  \n ")).toBe("")
    })

    test("parseTaskId", () => {
        expect(parseTaskId("12")).toBe(12)
        expect(parseTaskId("T-12")).toBe(12)
        expect(() => parseTaskId("0")).toThrow("invalid task id")
        expect(() => parseTaskId("abc")).toThrow("invalid task id")
    })

    test("validateTaskPatch keeps only sent keys", () => {
        expect(validateTaskPatch({ status: "done" })).toEqual({
            status: "done",
        })
        expect(() => validateTaskPatch([])).toThrow("patch must be an object")
        expect(() => validateTaskPatch(null)).toThrow()
        expect(() => validateTaskPatch({ id: 3 })).toThrow("unknown")
        expect(() => validateTaskPatch({ status: "nope" })).toThrow("invalid")
        expect(() => validateTaskPatch({ prev_status: "ready" })).toThrow(
            "service-owned"
        )
    })

    test("mapError", () => {
        const zerr = z.string().safeParse(1).error
        expect(mapError(zerr).status).toBe(400)
        expect(mapError(zerr).body.error).toBe("validation")
        expect(mapError({ status: 405, expose: true, message: "m" })).toEqual({
            status: 405,
            body: { error: "bad_request", message: "m" },
        })
        expect(mapError({ status: 418, code: "teapot", message: "t" })).toEqual(
            { status: 418, body: { error: "teapot", message: "t" } }
        )
        expect(mapError(new AppError("x", "y", { status: 422 })).status).toBe(
            422
        )
        expect(mapError(new Error("secret")).body).toEqual({
            error: "internal",
            message: "internal error",
        })
        expect(mapError(null).status).toBe(500)
    })

    test("createApp rejects an unknown mode", () => {
        expect(() => createApp({ mode: "public" })).toThrow("invalid app mode")
    })
})

describe("auth matrix: local listener", () => {
    let h
    beforeEach(() => {
        h = createHarness()
    })

    test("401 without credentials", async () => {
        const res = await request(h.local).get("/api/me")
        expect(res.status).toBe(401)
        expect(res.body.error).toBe("unauthorized")
    })

    test("bearer token is owner", async () => {
        const res = await bearer(request(h.local).get("/api/me"))
        expect(res.status).toBe(200)
        expect(res.body).toEqual({
            role: "owner",
            login: null,
            mode: "local",
            features: {},
        })
        expect(res.headers["cache-control"]).toBe("no-store")
    })

    test("owners see the wired features; mounts, task and board extras apply", async () => {
        const mounted = []
        const h2 = createHarness({
            deps: {
                features: { workers: true, github: true },
                mounts: [
                    (api, helpers) => {
                        mounted.push(Object.keys(helpers).sort())
                        api.get("/ping-extra", (req, res) =>
                            res.json({ viewer: helpers.isViewer(req) })
                        )
                    },
                ],
                taskExtras: [async (id) => ({ agent: { id } })],
                boardExtras: [async () => ({ agents: { 2: "idle" } })],
            },
        })
        seedTasks(h2.store)
        const me = await bearer(request(h2.local).get("/api/me"))
        expect(me.body.features).toEqual({ workers: true, github: true })
        expect(mounted[0]).toEqual([
            "ACTOR",
            "isViewer",
            "mode",
            "parse",
            "parseTaskId",
            "tailnet",
        ])
        expect(
            (await bearer(request(h2.local).get("/api/ping-extra"))).body
        ).toEqual({ viewer: false })
        const t = await bearer(request(h2.local).get("/api/tasks/2"))
        expect(t.body.agent).toEqual({ id: 2 })
        expect(t.body.task.id).toBe(2)
        const b = await bearer(request(h2.local).get("/api/board"))
        expect(b.body.agents).toEqual({ 2: "idle" })
        // viewers: no features, no extras
        const vme = await request(h2.tailnet).get("/api/me")
        expect(vme.body.features).toBeUndefined()
        const vb = await request(h2.tailnet).get("/api/board")
        expect(vb.body.agents).toBeUndefined()
        expect(vb.body.agent_tasks).toBeUndefined()
    })

    test("board: tasks with an agent that the lanes leave out come as agent_tasks", async () => {
        const h2 = createHarness({
            deps: {
                features: { workers: true },
                boardExtras: [
                    async () => ({
                        agents: { 1: "working", 2: "idle", 77: "blocked" },
                    }),
                ],
            },
        })
        seedTasks(h2.store)
        const b = await bearer(request(h2.local).get("/api/board"))
        // both on the board, 77 does not exist
        expect(b.body.agent_tasks).toEqual([])
        // task 2 finished long ago: out of the Done window
        const board = h2.store.board.bind(h2.store)
        h2.store.board = async (opts) => {
            const lanes = await board(opts)
            for (const l of Object.keys(lanes))
                lanes[l] = lanes[l].filter((t) => t.id !== 2)
            return lanes
        }
        const b2 = await bearer(request(h2.local).get("/api/board"))
        expect(b2.body.agent_tasks.map((t) => t.id)).toEqual([2])
        expect(b2.body.agent_tasks[0].title).toBe("Private")
    })

    test("board: no agent_tasks without an agents overlay", async () => {
        seedTasks(h.store)
        const b = await bearer(request(h.local).get("/api/board"))
        expect(b.body.agent_tasks).toBeUndefined()
    })

    test("wrong bearer is 401", async () => {
        const res = await request(h.local)
            .get("/api/me")
            .set("Authorization", "Bearer nope")
        expect(res.status).toBe(401)
    })

    test("forged Tailscale headers are ignored on local", async () => {
        const res = await request(h.local)
            .get("/api/board")
            .set("Tailscale-User-Login", OWNER)
            .set("X-Forwarded-For", "100.64.0.1")
        expect(res.status).toBe(401)
    })

    test("device cookie is ignored on local", async () => {
        const { cookie } = await pairDevice(h)
        const res = await request(h.local).get("/api/me").set("Cookie", cookie)
        expect(res.status).toBe(401)
    })

    test("bootstrap flow sets a working session cookie, single use", async () => {
        const { res, cookie, url } = await localSession(h)
        expect(res.status).toBe(302)
        expect(res.headers.location).toBe("/")
        expect(res.headers["set-cookie"][0]).toMatch(
            /^cc_session=\w+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict$/
        )
        const me = await request(h.local).get("/api/me").set("Cookie", cookie)
        expect(me.body.role).toBe("owner")
        const again = await request(h.local).get(url.pathname + url.search)
        expect(again.status).toBe(401)
    })

    test("bootstrap url uses the request host for loopback", async () => {
        const res = await bearer(
            request(h.local)
                .post("/api/auth/bootstrap-token")
                .set("Host", "LOCALHOST:7788")
        )
        expect(res.body.url).toMatch(
            /^http:\/\/localhost:7788\/auth\/bootstrap\?t=[0-9a-f]{64}$/
        )
        const v6 = await bearer(
            request(h.local)
                .post("/api/auth/bootstrap-token")
                .set("Host", "[::1]:7788")
        )
        expect(v6.body.url).toMatch(/^http:\/\/127\.0\.0\.1:7788\//)
        const other = await bearer(
            request(h.local)
                .post("/api/auth/bootstrap-token")
                .set("Host", "evil.example")
        )
        expect(other.status).toBe(421)
    })

    test("bootstrap token expires after 2 minutes", async () => {
        const tok = await bearer(
            request(h.local).post("/api/auth/bootstrap-token")
        )
        await h.clock.advance(121000)
        const url = new URL(tok.body.url)
        const res = await request(h.local).get(url.pathname + url.search)
        expect(res.status).toBe(401)
        expect(res.text).toMatch(/cc open/)
        const none = await request(h.local).get("/auth/bootstrap")
        expect(none.status).toBe(401)
    })

    test("session expires after 30 days", async () => {
        const { cookie } = await localSession(h)
        await h.clock.advance(31 * 24 * 3600 * 1000)
        const res = await request(h.local).get("/api/me").set("Cookie", cookie)
        expect(res.status).toBe(401)
    })

    test("session cannot mint bootstrap tokens (bearer only)", async () => {
        const { cookie } = await localSession(h)
        const res = await request(h.local)
            .post("/api/auth/bootstrap-token")
            .set("Cookie", cookie)
        expect(res.status).toBe(403)
    })

    test("logout revokes the session", async () => {
        const { cookie } = await localSession(h)
        const out = await request(h.local)
            .post("/api/auth/logout")
            .set("Cookie", cookie)
        expect(out.status).toBe(200)
        expect(out.headers["set-cookie"][0]).toMatch(/Max-Age=0/)
        const res = await request(h.local).get("/api/me").set("Cookie", cookie)
        expect(res.status).toBe(401)
    })

    test("/api/pair is not mounted on local", async () => {
        const res = await bearer(
            request(h.local).post("/api/pair").send({ code: "123456" })
        )
        expect(res.status).toBe(404)
    })
})

describe("auth matrix: tailnet listener", () => {
    let h
    beforeEach(() => {
        h = createHarness()
        seedTasks(h.store)
    })

    test("401 without Tailscale header", async () => {
        expect((await request(h.tailnet).get("/api/me")).status).toBe(401)
        const blank = await request(h.tailnet)
            .get("/api/me")
            .set("Tailscale-User-Login", "  ")
        expect(blank.status).toBe(401)
    })

    test("bearer token does nothing on tailnet", async () => {
        const res = await bearer(request(h.tailnet).get("/api/me"))
        expect(res.status).toBe(401)
        const v = await bearer(asViewer(request(h.tailnet).get("/api/me")))
        expect(v.body.role).toBe("viewer")
    })

    test("any login is a viewer", async () => {
        const res = await asViewer(request(h.tailnet).get("/api/me"))
        expect(res.body).toEqual({
            role: "viewer",
            login: VIEWER,
            mode: "tailnet",
        })
    })

    test("owner login alone is owner (no device needed) and can write", async () => {
        const res = await request(h.tailnet)
            .get("/api/me")
            .set("Tailscale-User-Login", OWNER)
        expect(res.body.role).toBe("owner")
        const bogus = await request(h.tailnet)
            .get("/api/me")
            .set("Tailscale-User-Login", OWNER)
            .set("Cookie", "cc_device=deadbeef")
        expect(bogus.body.role).toBe("owner")
        const code = await request(h.tailnet)
            .post("/api/pair/code")
            .set("Tailscale-User-Login", OWNER)
        expect(code.status).toBe(200)
        // another login is still a read-only viewer
        const other = await asViewer(request(h.tailnet).get("/api/me"))
        expect(other.body.role).toBe("viewer")
    })

    test("paired device + owner login is owner; cookie attributes", async () => {
        const { cookie, raw, device } = await pairDevice(h)
        expect(raw).toMatch(
            /^cc_device=[0-9a-f]{64}; Path=\/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict$/
        )
        expect(device).toEqual({
            id: 1,
            name: "phone",
            created_at: expect.any(String),
            last_seen_at: null,
            revoked_at: null,
        })
        expect(device.token_hash).toBeUndefined()
        const res = await request(h.tailnet)
            .get("/api/me")
            .set("Tailscale-User-Login", OWNER)
            .set("Cookie", cookie)
        expect(res.body.role).toBe("owner")
        expect(h.devicesRepo.devices[0].last_seen_at).not.toBeNull()
    })

    test("device cookie with another login is a viewer", async () => {
        const { cookie } = await pairDevice(h)
        const res = await asViewer(
            request(h.tailnet).get("/api/me").set("Cookie", cookie)
        )
        expect(res.body.role).toBe("viewer")
    })

    test("revoked device falls back to the owner login (no device)", async () => {
        const { cookie, device } = await pairDevice(h)
        const del = await bearer(
            request(h.local).delete(`/api/devices/${device.id}`)
        )
        expect(del.body).toEqual({ ok: true })
        const res = await request(h.tailnet)
            .get("/api/me")
            .set("Tailscale-User-Login", OWNER)
            .set("Cookie", cookie)
        expect(res.body.role).toBe("owner")
        const viewer = await asViewer(
            request(h.tailnet).get("/api/me").set("Cookie", cookie)
        )
        expect(viewer.body.role).toBe("viewer")
    })

    test("session cookie is ignored on tailnet", async () => {
        const { cookie } = await localSession(h)
        const res = await asViewer(
            request(h.tailnet).get("/api/me").set("Cookie", cookie)
        )
        expect(res.body.role).toBe("viewer")
    })

    test("bootstrap, bootstrap-token and mcp are not mounted", async () => {
        const { cookie } = await pairDevice(h)
        const owner = (r) =>
            r.set("Tailscale-User-Login", OWNER).set("Cookie", cookie)
        expect(
            (await request(h.tailnet).get("/auth/bootstrap?t=x")).status
        ).toBe(404)
        expect(
            (await owner(request(h.tailnet).post("/api/auth/bootstrap-token")))
                .status
        ).toBe(404)
        expect((await owner(request(h.tailnet).post("/mcp"))).status).toBe(404)
    })
})

describe("pairing", () => {
    let h
    beforeEach(() => {
        h = createHarness()
    })

    test("owner gets a 6-digit code; viewer cannot", async () => {
        const res = await bearer(request(h.local).post("/api/pair/code"))
        expect(res.status).toBe(200)
        expect(res.body.code).toMatch(/^\d{6}$/)
        expect(res.body.expires_at).toBe("2026-11-07T12:10:00.000Z")
        expect(h.devicesRepo.codes.has(res.body.code)).toBe(false) // hashed
        const v = await asViewer(request(h.tailnet).post("/api/pair/code"))
        expect(v.status).toBe(403)
    })

    test("non-owner login cannot pair", async () => {
        const { code } = await h.auth.createPairCode()
        const res = await asViewer(
            request(h.tailnet).post("/api/pair").send({ code })
        )
        expect(res.status).toBe(403)
    })

    test("code is single use and expires", async () => {
        const { code } = await h.auth.createPairCode()
        const ok = await request(h.tailnet)
            .post("/api/pair")
            .set("Tailscale-User-Login", OWNER)
            .send({ code })
        expect(ok.status).toBe(200)
        expect(ok.body.device.name).toBe("device")
        const reuse = await request(h.tailnet)
            .post("/api/pair")
            .set("Tailscale-User-Login", OWNER)
            .send({ code })
        expect(reuse.status).toBe(400)
        const second = await h.auth.createPairCode()
        await h.clock.advance(11 * 60 * 1000)
        const late = await request(h.tailnet)
            .post("/api/pair")
            .set("Tailscale-User-Login", OWNER)
            .send({ code: second.code })
        expect(late.status).toBe(400)
    })

    test("malformed code is a validation error", async () => {
        const res = await request(h.tailnet)
            .post("/api/pair")
            .set("Tailscale-User-Login", OWNER)
            .send({ code: "12ab" })
        expect(res.status).toBe(400)
        expect(res.body.error).toBe("validation")
    })

    const sendCode = (code) =>
        request(h.tailnet)
            .post("/api/pair")
            .set("Tailscale-User-Login", OWNER)
            .send({ code })
    const wrong = (code) => (code === "000000" ? "000001" : "000000")

    test("5 wrong codes invalidate the active code; a new code works", async () => {
        const { code } = await h.auth.createPairCode()
        for (let i = 0; i < 5; i++)
            expect((await sendCode(wrong(code))).status).toBe(400)
        // The right digits no longer work: the code was invalidated.
        expect((await sendCode(code)).status).toBe(400)
        // A forged owner header cannot lock the owner out: a new code pairs.
        const fresh = await h.auth.createPairCode()
        expect((await sendCode(fresh.code)).status).toBe(200)
    })

    test("only the latest code is accepted", async () => {
        const first = await h.auth.createPairCode()
        const second = await h.auth.createPairCode()
        if (first.code !== second.code)
            expect((await sendCode(first.code)).status).toBe(400)
        expect((await sendCode(second.code)).status).toBe(200)
    })

    test("global cap: 429 after 20 failures; a fresh code still pairs", async () => {
        for (let round = 0; round < 4; round++) {
            const { code } = await h.auth.createPairCode()
            for (let i = 0; i < 5; i++) await sendCode(wrong(code))
        }
        const noCode = await sendCode("123456")
        expect(noCode.status).toBe(429)
        expect(noCode.body.error).toBe("rate_limited")
        // Fresh code, right digits: not rate limited.
        const fresh = await h.auth.createPairCode()
        expect((await sendCode(fresh.code)).status).toBe(200)
        // Fresh code, one miss under the cap: 429 and the code is dead.
        const next = await h.auth.createPairCode()
        expect((await sendCode(wrong(next.code))).status).toBe(429)
        expect((await sendCode(next.code)).status).toBe(429)
        // The window passes.
        await h.clock.advance(10 * 60 * 1000 + 1)
        const later = await h.auth.createPairCode()
        expect((await sendCode(later.code)).status).toBe(200)
    })
})

describe("CSRF", () => {
    let h, cookie
    const ownerPost = (path, origin, extra = {}) => {
        let r = request(h.tailnet)
            .post(path)
            .set("Tailscale-User-Login", OWNER)
            .set("Cookie", cookie)
            .set("Host", "mac.tail.ts.net:8443")
        if (origin !== undefined) r = r.set("Origin", origin)
        for (const [k, v] of Object.entries(extra)) r = r.set(k, v)
        return r.send({ text: "x" })
    }
    beforeEach(async () => {
        h = createHarness()
        ;({ cookie } = await pairDevice(h))
    })

    test("same-origin write passes", async () => {
        const res = await ownerPost(
            "/api/command",
            "https://mac.tail.ts.net:8443"
        )
        expect(res.status).toBe(202)
    })

    test("missing Origin passes", async () => {
        expect((await ownerPost("/api/command")).status).toBe(202)
    })

    test("cross-origin write is rejected", async () => {
        const res = await ownerPost("/api/command", "https://evil.example")
        expect(res.status).toBe(403)
        expect(res.body.error).toBe("csrf")
        expect(h.jobRunner.jobs).toHaveLength(0)
    })

    test("Origin null / malformed is rejected", async () => {
        expect((await ownerPost("/api/command", "null")).status).toBe(403)
    })

    test("Sec-Fetch-Site cross-site is rejected", async () => {
        const res = await ownerPost("/api/command", undefined, {
            "Sec-Fetch-Site": "cross-site",
        })
        expect(res.status).toBe(403)
    })

    test("matching X-Forwarded-Host passes; Origin must be the public host", async () => {
        const fwd = await ownerPost(
            "/api/command",
            "https://mac.tail.ts.net:8443",
            { "X-Forwarded-Host": "mac.tail.ts.net:8443" }
        )
        expect(fwd.status).toBe(202)
        const loopOrigin = await ownerPost(
            "/api/command",
            "http://127.0.0.1:7789"
        )
        expect(loopOrigin.status).toBe(403)
    })

    test("local session cookie is checked, bearer is not", async () => {
        const { cookie: s } = await localSession(h)
        const bad = await request(h.local)
            .post("/api/command")
            .set("Cookie", s)
            .set("Origin", "https://evil.example")
            .send({ text: "x" })
        expect(bad.status).toBe(403)
        const ok = await bearer(
            request(h.local)
                .post("/api/command")
                .set("Origin", "https://evil.example")
                .send({ text: "x" })
        )
        expect(ok.status).toBe(202)
    })
})

describe("host guard (DNS rebinding)", () => {
    let h
    beforeEach(() => {
        h = createHarness()
        seedTasks(h.store)
    })

    test("tailnet: rebound or loopback Host is 421 before auth and healthz", async () => {
        for (const host of [
            "evil.example:7789",
            "127.0.0.1:7789",
            "localhost:7789",
            "mac.tail.ts.net",
            "mac.tail.ts.net:8443.evil.example",
        ]) {
            const me = await asViewer(
                request(h.tailnet).get("/api/me").set("Host", host)
            )
            expect(me.status).toBe(421)
            expect(me.body.error).toBe("misdirected")
            const health = await request(h.tailnet)
                .get("/healthz")
                .set("Host", host)
            expect(health.status).toBe(421)
        }
        const ev = await asViewer(
            request(h.tailnet)
                .get("/api/events")
                .set("Host", "evil.example:7789")
        )
        expect(ev.status).toBe(421)
        expect(ev.text).not.toContain("Shared")
    })

    test("tailnet: the public host passes, case-insensitively", async () => {
        const res = await asViewer(
            request(h.tailnet)
                .get("/api/me")
                .set("Host", "MAC.tail.ts.net:8443")
        )
        expect(res.status).toBe(200)
        expect((await request(h.tailnet).get("/healthz")).body).toEqual({
            ok: true,
        })
    })

    test("tailnet: X-Forwarded-Host must name the public host too", async () => {
        const bad = await asViewer(
            request(h.tailnet)
                .get("/api/me")
                .set("X-Forwarded-Host", "evil.example:7789")
        )
        expect(bad.status).toBe(421)
        const mixed = await asViewer(
            request(h.tailnet)
                .get("/api/me")
                .set("X-Forwarded-Host", "mac.tail.ts.net:8443, evil.example")
        )
        expect(mixed.status).toBe(421)
        const good = await asViewer(
            request(h.tailnet)
                .get("/api/me")
                .set("X-Forwarded-Host", "mac.tail.ts.net:8443")
        )
        expect(good.status).toBe(200)
    })

    test("tailnet: default https port in publicBaseUrl", async () => {
        const h2 = createHarness({
            config: { publicBaseUrl: "https://mac.tail.ts.net/" },
        })
        for (const host of ["mac.tail.ts.net", "mac.tail.ts.net:443"]) {
            const res = await asViewer(
                request(h2.tailnet).get("/api/me").set("Host", host)
            )
            expect(res.status).toBe(200)
        }
        const other = await asViewer(
            request(h2.tailnet)
                .get("/api/me")
                .set("Host", "mac.tail.ts.net:8443")
        )
        expect(other.status).toBe(421)
    })

    test.each([null, "::bad::", "ftp://mac.tail.ts.net"])(
        "tailnet: publicBaseUrl %p refuses everything with 503 (logged once)",
        async (publicBaseUrl) => {
            const errors = []
            const h2 = createHarness({
                config: { publicBaseUrl },
                deps: {
                    log: { ...nullLogger, error: (o, m) => errors.push(m) },
                },
            })
            for (const p of ["/healthz", "/api/me"]) {
                const res = await asViewer(
                    request(h2.tailnet)
                        .get(p)
                        .set("Host", "mac.tail.ts.net:8443")
                )
                expect(res.status).toBe(503)
                expect(res.body).toEqual({
                    error: "not_configured",
                    message: "publicBaseUrl not configured",
                })
            }
            expect(errors).toEqual([
                "publicBaseUrl not configured: refusing tailnet requests",
            ])
            // The local listener does not depend on publicBaseUrl.
            expect(
                (await bearer(request(h2.local).get("/api/me"))).status
            ).toBe(200)
        }
    )

    test("local: only loopback names on the listener port", async () => {
        for (const host of ["127.0.0.1:7788", "localhost:7788", "[::1]:7788"]) {
            const res = await bearer(
                request(h.local).get("/api/me").set("Host", host)
            )
            expect(res.status).toBe(200)
        }
        for (const host of [
            "evil.example:7788",
            "127.0.0.1:9999",
            "127.0.0.1",
            "mac.tail.ts.net:8443",
            "user@127.0.0.1:7788",
        ]) {
            const res = await bearer(
                request(h.local).get("/api/me").set("Host", host)
            )
            expect(res.status).toBe(421)
            const health = await request(h.local)
                .get("/healthz")
                .set("Host", host)
            expect(health.status).toBe(421)
        }
        const boot = await request(h.local)
            .get("/auth/bootstrap?t=x")
            .set("Host", "evil.example:7788")
        expect(boot.status).toBe(421)
    })

    test("local: CSRF compares Origin with the validated Host", async () => {
        const { cookie } = await localSession(h)
        const res = await request(h.local)
            .post("/api/command")
            .set("Host", "localhost:7788")
            .set("Origin", "http://localhost:7788")
            .set("Cookie", cookie)
            .send({ text: "x" })
        expect(res.status).toBe(202)
        const cross = await request(h.local)
            .post("/api/command")
            .set("Host", "localhost:7788")
            .set("Origin", "http://127.0.0.1:7788")
            .set("Cookie", cookie)
            .send({ text: "x" })
        expect(cross.status).toBe(403)
    })
})

describe("viewer filtering", () => {
    let h
    beforeEach(() => {
        h = createHarness()
        seedTasks(h.store)
    })

    const PRIVATE_KEYS = ["source", "flags", "deliverables", "prev_status"]

    test("board shows only shared tasks with viewerTask fields", async () => {
        const res = await asViewer(request(h.tailnet).get("/api/board"))
        expect(res.status).toBe(200)
        const all = Object.values(res.body.lanes).flat()
        expect(all.map((t) => t.id)).toEqual([1])
        for (const k of PRIVATE_KEYS) expect(all[0]).not.toHaveProperty(k)
        expect(all[0].links).toEqual([
            { type: "pr", url: "https://github.com/x/pull/1", label: "PR" },
        ])
        expect(h.store.calls.at(-1)).toEqual(["board", { shared_only: true }])
    })

    test("task list shows only shared tasks", async () => {
        const res = await asViewer(request(h.tailnet).get("/api/tasks"))
        expect(res.body.tasks.map((t) => t.id)).toEqual([1])
        expect(res.body.tasks[0]).not.toHaveProperty("source")
        expect(h.store.calls.at(-1)[1].shared_only).toBe(true)
    })

    test("shared task detail is the viewer view", async () => {
        const res = await asViewer(request(h.tailnet).get("/api/tasks/1"))
        expect(res.status).toBe(200)
        expect(Object.keys(res.body).sort()).toEqual(["artifact", "task"])
        expect(res.body.artifact).toEqual({ content: "# shared artifact" })
        expect(res.body.task).not.toHaveProperty("source")
    })

    test("private task detail is 404 for viewers", async () => {
        const res = await asViewer(request(h.tailnet).get("/api/tasks/2"))
        expect(res.status).toBe(404)
    })

    test("visibility override: shared without Asana, private with Asana", async () => {
        h.store.seed(makeTask(3, { visibility: "shared" }))
        h.store.seed(
            makeTask(4, {
                visibility: "private",
                asana: { gid: "9", url: "u", attachments: [] },
            })
        )
        const res = await asViewer(request(h.tailnet).get("/api/tasks"))
        expect(res.body.tasks.map((t) => t.id)).toEqual([1, 3])
    })

    test.each([
        ["get", "/api/tasks/1/history"],
        ["get", "/api/tasks/1/history/abcd"],
        ["get", "/api/settings"],
        ["get", "/api/devices"],
        ["get", "/api/jobs/j1"],
        ["post", "/api/tasks"],
        ["patch", "/api/tasks/1"],
        ["put", "/api/tasks/1/artifact"],
        ["post", "/api/tasks/1/comments"],
        ["post", "/api/tasks/1/schedules"],
        ["post", "/api/tasks/1/asana"],
        ["post", "/api/command"],
        ["patch", "/api/settings"],
        ["delete", "/api/devices/1"],
        ["post", "/api/admin/reindex"],
        ["get", "/api/nonexistent"],
    ])("viewer %s %s is forbidden", async (method, url) => {
        const res = await asViewer(request(h.tailnet)[method](url).send({}))
        expect(res.status).toBe(403)
        expect(res.body.error).toBe("forbidden")
    })
})

describe("owner: board, list, detail", () => {
    let h
    beforeEach(() => {
        h = createHarness()
        seedTasks(h.store)
    })

    test("board returns all lanes", async () => {
        const res = await bearer(request(h.local).get("/api/board?done_days=3"))
        expect(Object.keys(res.body.lanes)).toEqual([
            "now",
            "active",
            "prs",
            "ready",
            "inbox",
            "waiting",
            "done",
        ])
        expect(res.body.lanes.ready[0].source).toBeDefined()
        expect(h.store.calls.at(-1)).toEqual([
            "board",
            { shared_only: false, done_days: 3 },
        ])
    })

    test("board tolerates missing lanes", async () => {
        h.store.board = async () => null
        const res = await bearer(request(h.local).get("/api/board"))
        expect(res.body.lanes.now).toEqual([])
    })

    test("list parses query", async () => {
        const res = await bearer(
            request(h.local).get(
                "/api/tasks?q=ron&status=ready,%20waiting&area=infra&kind=todo&lane=ready&limit=5&offset=1"
            )
        )
        expect(res.status).toBe(200)
        expect(h.store.calls.at(-1)[1]).toEqual({
            q: "ron",
            status: ["ready", "waiting"],
            area: ["infra"],
            kind: ["todo"],
            lane: "ready",
            limit: 5,
            offset: 1,
        })
        expect(res.body.tasks.map((t) => t.id)).toEqual([2])
    })

    test("list rejects bad query", async () => {
        const res = await bearer(
            request(h.local).get("/api/tasks?status=bogus")
        )
        expect(res.status).toBe(400)
        const lim = await bearer(request(h.local).get("/api/tasks?limit=0"))
        expect(lim.status).toBe(400)
    })

    test("owner detail has everything", async () => {
        h.jobRunner.enqueue("enrich", {}, { task_id: 2 })
        const res = await bearer(request(h.local).get("/api/tasks/T-2"))
        expect(res.status).toBe(200)
        expect(Object.keys(res.body).sort()).toEqual([
            "artifact",
            "comments",
            "events",
            "feedback",
            "jobs",
            "revision",
            "schedules",
            "task",
        ])
        expect(res.body.jobs).toHaveLength(1)
        expect(res.body.events[0].opts).toEqual({ limit: 50 })
    })

    test("unknown task is 404, bad id is 400", async () => {
        expect(
            (await bearer(request(h.local).get("/api/tasks/99"))).status
        ).toBe(404)
        expect(
            (await bearer(request(h.local).get("/api/tasks/x1"))).status
        ).toBe(400)
    })
})

describe("owner: capture", () => {
    let h
    const post = (body) =>
        bearer(request(h.local).post("/api/tasks").send(body))
    beforeEach(() => {
        h = createHarness()
    })
    const created = () => h.store.calls.find((c) => c[0] === "createTask")

    test("plain text -> todo in inbox, first line title", async () => {
        const res = await post({ text: "Fix the login bug\nmore details" })
        expect(res.status).toBe(201)
        expect(res.body.task.title).toBe("Fix the login bug")
        expect(res.body.revision).toBeDefined()
        const [, input, actor] = created()
        expect(actor).toBe("me")
        expect(input).toMatchObject({
            kind: "todo",
            area: "other",
            status: "inbox",
            due_at: null,
            source: {
                type: "manual",
                url: null,
                text: "Fix the login bug\nmore details",
            },
        })
        // free text is enriched too (classification, repos, artifact draft)
        expect(input.flags).toEqual({ enriching: true })
        expect(h.jobRunner.jobs.map((j) => [j.type, j.input])).toEqual([
            [
                "enrich",
                {
                    baseline: { content: "# T-1", revision: "r2" },
                    snapshot: {
                        title: "Fix the login bug",
                        area: "other",
                        kind: "todo",
                    },
                },
            ],
        ])
        expect(h.scheduler.reminded).toHaveLength(0)
    })

    test("long first line is truncated to 120 chars", async () => {
        const res = await post({ text: "y".repeat(500) })
        expect(res.body.task.title).toHaveLength(120)
    })

    test("reminder -> kind reminder, waiting, due, scheduler.remind", async () => {
        const res = await post({
            text: "remind me to talk to Ron about 123 tomorrow",
        })
        expect(res.status).toBe(201)
        expect(res.body.task).toMatchObject({
            title: "Talk to Ron about 123",
            kind: "reminder",
            status: "waiting",
            due_at: DUE,
        })
        expect(h.scheduler.reminded).toEqual([[1, DUE]])
    })

    test("explicit title wins over parsed reminder title", async () => {
        const res = await post({
            text: "remind me to x tomorrow",
            title: "  Mine ",
        })
        expect(res.body.task.title).toBe("Mine")
    })

    test("explicit non-reminder kind ignores reminder parse", async () => {
        const res = await post({
            text: "remind me to x tomorrow",
            kind: "todo",
        })
        expect(res.body.task.kind).toBe("todo")
        expect(res.body.task.status).toBe("inbox")
        expect(h.scheduler.reminded).toHaveLength(0)
        // rule parser "failed" for a reminder-looking text -> parse_quick
        expect(h.jobRunner.jobs[0]).toMatchObject({
            type: "parse_quick",
            input: { text: "remind me to x tomorrow" },
            task_id: 1,
        })
    })

    test("Create in Asana with an unparsed 'remind me' still runs parse_quick", async () => {
        await post({
            text: "remind me to call mom sometime",
            wants_asana: true,
        })
        expect(h.jobRunner.jobs.map((j) => j.type).sort()).toEqual([
            "asana_create",
            "parse_quick",
        ])
    })

    test("explicit area / kind / title are pinned for enrich", async () => {
        await post({ text: "x", area: "infra", kind: "agent_task" })
        expect(h.jobRunner.jobs[0].input.pinned).toEqual(["area", "kind"])
        h.jobRunner.jobs.length = 0
        await post({ text: "y", title: "Mine" })
        expect(h.jobRunner.jobs[0].input.pinned).toEqual(["title"])
        h.jobRunner.jobs.length = 0
        await post({ text: "z" })
        expect(h.jobRunner.jobs[0].input).not.toHaveProperty("pinned")
    })

    test("Create in Asana ticked: via enrich, or right away without it", async () => {
        await post({ text: "Fix the upload bug", wants_asana: true })
        expect(h.jobRunner.jobs.map((j) => [j.type, j.input])).toEqual([
            [
                "enrich",
                {
                    baseline: { content: "# T-1", revision: "r2" },
                    snapshot: {
                        title: "Fix the upload bug",
                        area: "other",
                        kind: "todo",
                    },
                    create_asana: true,
                },
            ],
        ])
        h.jobRunner.jobs.length = 0
        await post({
            text: "call the bank",
            kind: "reminder",
            wants_asana: true,
        })
        expect(h.jobRunner.jobs.map((j) => j.type)).toEqual(["asana_create"])
    })

    test("unparsed 'remind me' enqueues parse_quick with a full snapshot", async () => {
        await post({ text: "remind me to call mom sometime" })
        expect(h.jobRunner.jobs.map((j) => j.type)).toEqual(["parse_quick"])
        expect(h.jobRunner.jobs[0].input.snapshot).toEqual({
            title: "remind me to call mom sometime",
            area: "other",
            kind: "todo",
            due_at: null,
            status: "inbox",
        })
    })

    test("slack url in text -> source slack, enriching, enrich job", async () => {
        const res = await post({
            text: "look at https://acme.slack.com/archives/C1/p123.",
        })
        expect(res.status).toBe(201)
        const [, input] = created()
        expect(input.source).toEqual({
            type: "slack",
            url: "https://acme.slack.com/archives/C1/p123",
            text: "look at https://acme.slack.com/archives/C1/p123.",
        })
        expect(input.flags).toEqual({ enriching: true })
        expect(res.body.task.flags.enriching).toBe(true)
        expect(h.jobRunner.jobs[0]).toMatchObject({
            type: "enrich",
            input: {
                snapshot: {
                    title: res.body.task.title,
                    area: res.body.task.area,
                    kind: res.body.task.kind,
                },
            },
            task_id: 1,
        })
    })

    test("asana url only -> title is the url, enrich", async () => {
        const url = "https://app.asana.com/0/1/2"
        const res = await post({ url })
        expect(res.body.task.title).toBe(url)
        expect(created()[1].source).toEqual({ type: "asana", url, text: null })
        expect(h.jobRunner.jobs[0].type).toBe("enrich")
    })

    test("github url -> source github, enriched from its text", async () => {
        await post({ text: "https://github.com/a/b/pull/1" })
        expect(created()[1].source.type).toBe("github")
        expect(h.jobRunner.jobs.map((j) => j.type)).toEqual(["enrich"])
    })

    test("reminders without a due date are not enriched", async () => {
        await post({ text: "call the bank", kind: "reminder" })
        expect(created()[1].flags).toBeUndefined()
        expect(h.jobRunner.jobs).toHaveLength(0)
    })

    test("explicit source_type wins", async () => {
        await post({ text: "from phone", source_type: "phone" })
        expect(created()[1].source.type).toBe("phone")
    })

    test("when field -> reminder via parseWhen", async () => {
        const res = await post({ text: "call mom", when: "2h" })
        expect(res.body.task).toMatchObject({
            kind: "reminder",
            status: "waiting",
            due_at: "2026-11-07T14:00:00.000Z",
            title: "call mom",
        })
        expect(h.scheduler.reminded).toHaveLength(1)
    })

    test("unparseable when is 400", async () => {
        const res = await post({ text: "call mom", when: "someday" })
        expect(res.status).toBe(400)
        expect(res.body.details).toEqual({ when: "someday" })
    })

    test("reminder kind with explicit due_at", async () => {
        const res = await post({
            title: "Pay",
            kind: "reminder",
            due_at: "2026-11-09T09:00:00Z",
        })
        expect(res.body.task.status).toBe("waiting")
        expect(h.scheduler.reminded).toEqual([[1, "2026-11-09T09:00:00Z"]])
    })

    test("validation errors", async () => {
        const res = await post({})
        expect(res.status).toBe(400)
        expect(res.body.error).toBe("validation")
        expect(res.body.details.issues).toBeDefined()
        expect((await post({ text: "   " })).status).toBe(400)
        expect((await post({ url: "nope" })).status).toBe(400)
    })

    test("real date parser: ordinary lines stay todos, due_at only for reminders", async () => {
        const clock = createFakeClock("2026-11-07T20:00:00.000Z")
        h = createHarness({
            deps: {
                dateParser: createDateParser({
                    clock,
                    timezone: "America/Los_Angeles",
                }),
            },
        })
        for (const text of [
            "Reminders page crashes on Sunday",
            "Reminder push broken since monday",
            "Remove the reminder banner now",
            "fix bug by 5pm",
        ]) {
            const res = await post({ text })
            expect(res.status).toBe(201)
            expect(res.body.task).toMatchObject({
                title: text,
                kind: "todo",
                status: "inbox",
                due_at: null,
            })
        }
        const r = await post({ text: "remind me on friday to file taxes" })
        expect(r.body.task).toMatchObject({
            title: "File taxes",
            kind: "reminder",
            status: "waiting",
            due_at: "2026-11-13T17:00:00.000Z",
        })
        // a reminder with only non-date tokens: no due date -> parse_quick
        const q = await post({ text: "remind me to check the 24/7 page" })
        expect(q.body.task).toMatchObject({
            title: "Check the 24/7 page",
            kind: "reminder",
            status: "inbox",
            due_at: null,
        })
        expect(h.scheduler.reminded).toEqual([
            [r.body.task.id, "2026-11-13T17:00:00.000Z"],
        ])
        // ordinary lines are enriched; the reminder is not; the dateless
        // "remind me" goes to parse_quick instead of enrich
        const ids = []
        for (let i = 1; i < q.body.task.id; i++)
            if (i !== r.body.task.id) ids.push(["enrich", i])
        expect(h.jobRunner.jobs.map((j) => [j.type, j.task_id])).toEqual([
            ...ids,
            ["parse_quick", q.body.task.id],
        ])
    })

    test("follow-up failures do not fail the request", async () => {
        const errors = []
        h = createHarness({
            deps: {
                log: { error: (o, m) => errors.push(m), info() {}, warn() {} },
            },
        })
        h.scheduler.remind = () => {
            throw new Error("boom")
        }
        const res = await post({ text: "remind me to x tomorrow" })
        expect(res.status).toBe(201)
        expect(errors).toEqual(["remind failed"])
    })
})

describe("owner: patch, artifact, history", () => {
    let h
    const patch = (id, body) =>
        bearer(request(h.local).patch(`/api/tasks/${id}`).send(body))
    beforeEach(() => {
        h = createHarness()
        seedTasks(h.store)
    })

    test("patch status forwards only sent keys", async () => {
        const res = await patch(2, { patch: { status: "done" } })
        expect(res.status).toBe(200)
        expect(res.body.task.status).toBe("done")
        const call = h.store.calls.find((c) => c[0] === "updateTask")
        expect(call[2]).toEqual({ status: "done" })
        expect(call[3]).toEqual({ actor: "me", baseRevision: undefined })
    })

    test("seen clears a Now flag raised only to be seen, nothing else", async () => {
        const V = "2026-11-07T12:00:00.000Z" // makeTask updated_at
        const seen = (id, updatedAt = V) =>
            bearer(
                request(h.local)
                    .post(`/api/tasks/${id}/seen`)
                    .send({ updated_at: updatedAt })
            )
        const flags = (over) => ({
            enriching: false,
            now: true,
            error: null,
            ...over,
        })
        // a reminder: cleared
        h.store.seed(
            makeTask(3, {
                flags: flags({ now_reason: "Call Ron", now_seen: "Call Ron" }),
            })
        )
        let res = await seen(3)
        expect(res.status).toBe(200)
        expect(res.body.cleared).toBe(true)
        expect(res.body.task.flags).toMatchObject({
            now: false,
            now_reason: null,
            now_seen: null,
        })
        const call = h.store.calls.find((c) => c[0] === "updateTask")
        expect(call[3]).toEqual({ actor: "me", reason: "seen" })
        // a snooze end raised before the mark existed: cleared too
        h.store.seed(
            makeTask(4, { flags: flags({ now_reason: "Snooze ended" }) })
        )
        expect((await seen(4)).body.cleared).toBe(true)
        // the reason was replaced since (e.g. Ready for PR): kept
        h.store.seed(
            makeTask(5, {
                flags: flags({
                    now_reason: "Ready for PR",
                    now_seen: "Call Ron",
                }),
            })
        )
        expect((await seen(5)).body).toEqual({ cleared: false })
        expect((await h.store.getTask(5)).task.flags.now).toBe(true)
        // the page showed an older version (a newer reminder fired since)
        h.store.seed(
            makeTask(7, {
                flags: flags({ now_reason: "Call Ron", now_seen: "Call Ron" }),
            })
        )
        expect((await seen(7, "2026-11-07T11:00:00.000Z")).body).toEqual({
            cleared: false,
            stale: true,
        })
        expect((await h.store.getTask(7)).task.flags.now).toBe(true)
        expect(
            (await bearer(request(h.local).post("/api/tasks/7/seen").send({})))
                .status
        ).toBe(400)
        // not in Now, unknown task
        expect((await seen(2)).body).toEqual({ cleared: false })
        expect((await seen(99)).status).toBe(404)
        // without a task lock in the store it still works
        h.store.withTaskLock = undefined
        h.store.seed(
            makeTask(6, { flags: flags({ now_reason: "Snooze ended" }) })
        )
        expect((await seen(6)).body.cleared).toBe(true)
    })

    test("stale base_revision -> 409 with current", async () => {
        const res = await patch(2, {
            patch: { title: "x" },
            base_revision: "nope",
        })
        expect(res.status).toBe(409)
        expect(res.body.error).toBe("stale_revision")
        expect(res.body.details.current.task.id).toBe(2)
    })

    test("illegal transition -> 409", async () => {
        h.store.updateTask = async () => {
            const e = new Error("illegal status transition done -> pr_open")
            e.code = "illegal_transition"
            e.from = "done"
            e.to = "pr_open"
            throw e
        }
        const res = await patch(2, { patch: { status: "pr_open" } })
        expect(res.status).toBe(409)
        expect(res.body).toEqual({
            error: "illegal_transition",
            message: "illegal status transition done -> pr_open",
            details: { from: "done", to: "pr_open" },
        })
    })

    test("patch validation", async () => {
        expect((await patch(2, { patch: { id: 5 } })).status).toBe(400)
        expect((await patch(2, { patch: { status: "nah" } })).status).toBe(400)
        expect((await patch(2, { patch: {} })).status).toBe(400)
        expect((await patch(2, {})).status).toBe(400)
        expect((await patch(2, { patch: "x" })).status).toBe(400)
        const owned = await patch(2, {
            patch: { status: "waiting", prev_status: "done" },
        })
        expect(owned.status).toBe(400)
        expect(owned.body.details).toEqual({ fields: ["prev_status"] })
        expect(h.store.calls.some((c) => c[0] === "updateTask")).toBe(false)
    })

    test("snooze text -> waiting + surface schedule, replaces old snooze", async () => {
        const first = await patch(2, { snooze: "2h" })
        expect(first.status).toBe(200)
        expect(first.body.task).toMatchObject({
            status: "waiting",
            snooze_until: "2026-11-07T14:00:00.000Z",
        })
        expect(h.scheduler.schedules[0]).toMatchObject({
            task_id: 2,
            fire_at: "2026-11-07T14:00:00.000Z",
            action: "surface",
            payload: { snooze: true },
            status: "pending",
        })
        await patch(2, { snooze: "tomorrow" })
        expect(h.scheduler.schedules.map((s) => s.status)).toEqual([
            "cancelled",
            "pending",
        ])
    })

    test("snooze cancels plain reminders due before it ends, keeps later ones", async () => {
        const early = h.scheduler.remind(2, "2026-11-07T13:00:00.000Z")
        const late = h.scheduler.remind(2, "2026-11-09T09:00:00.000Z")
        const other = h.scheduler.remind(1, "2026-11-07T13:00:00.000Z")
        const job = h.scheduler.add({
            task_id: 2,
            fire_at: "2026-11-07T13:00:00.000Z",
            action: "center_job",
        })
        const res = await patch(2, { snooze: "tomorrow" }) // DUE 11-08 10:00Z
        expect(res.status).toBe(200)
        const byId = (s) => h.scheduler.schedules.find((x) => x.id === s.id)
        expect(byId(early).status).toBe("cancelled")
        expect(byId(late).status).toBe("pending")
        expect(byId(other).status).toBe("pending")
        expect(byId(job).status).toBe("pending")
        expect(h.scheduler.schedules.at(-1)).toMatchObject({
            task_id: 2,
            fire_at: DUE,
            payload: { snooze: true },
            status: "pending",
        })
    })

    test("explicit snooze_until also cancels earlier reminders", async () => {
        const early = h.scheduler.remind(2, "2026-11-08T09:00:00.000Z")
        await patch(2, {
            patch: { status: "waiting", snooze_until: "2026-11-10T09:00:00Z" },
        })
        expect(early.status).toBe("cancelled")
    })

    test("explicit waiting + snooze_until schedules surface", async () => {
        const res = await patch(2, {
            patch: { status: "waiting", snooze_until: "2026-11-10T09:00:00Z" },
        })
        expect(res.status).toBe(200)
        expect(h.scheduler.schedules).toHaveLength(1)
    })

    test("snooze_until without waiting does not schedule", async () => {
        await patch(2, { patch: { snooze_until: "2026-11-10T09:00:00Z" } })
        expect(h.scheduler.schedules).toHaveLength(0)
    })

    test("overlapping snoozes leave exactly the newest snooze timer", async () => {
        const locks = createLockManager()
        h.store.withTaskLock = (id, fn) => locks.withLock(id, fn)
        // the first request stalls while reading the schedules
        let release
        const gate = new Promise((r) => (release = r))
        const realList = h.scheduler.listForTask
        let n = 0
        h.scheduler.listForTask = async (id) => {
            if (++n === 1) await gate
            return realList(id)
        }
        // .then() sends the request now (supertest is lazy)
        const first = patch(2, {
            patch: { status: "waiting", snooze_until: "2026-11-09T09:00:00Z" },
        }).then((r) => r)
        await new Promise((r) => setTimeout(r, 20))
        const second = patch(2, {
            patch: { status: "waiting", snooze_until: "2026-11-12T09:00:00Z" },
        }).then((r) => r)
        await new Promise((r) => setTimeout(r, 20))
        release()
        const [a, b] = await Promise.all([first, second])
        expect([a.status, b.status]).toEqual([200, 200])
        const pending = h.scheduler.schedules.filter(
            (x) => x.status === "pending" && x.payload && x.payload.snooze
        )
        expect(pending.map((x) => x.fire_at)).toEqual(["2026-11-12T09:00:00Z"])
        expect(h.store.tasks.get(2).task.snooze_until).toBe(
            "2026-11-12T09:00:00Z"
        )
    })

    test("every snooze takes the task out of Now", async () => {
        h.store.tasks.get(2).task.flags = {
            ...h.store.tasks.get(2).task.flags,
            now: true,
            now_reason: "Reminder",
        }
        await patch(2, { snooze: "2h" })
        await patch(2, {
            patch: { status: "waiting", snooze_until: "2026-11-10T09:00:00Z" },
        })
        const flags = h.store.calls
            .filter((c) => c[0] === "updateTask")
            .map((c) => c[2].flags)
        expect(flags).toEqual([
            { now: false, now_reason: null },
            { now: false, now_reason: null },
        ])
        // a patch without a snooze leaves the flags alone
        await patch(2, { patch: { title: "renamed" } })
        expect(h.store.calls.at(-1)[2]).toEqual({ title: "renamed" })
    })

    test("done on an Asana-linked task starts close_out once", async () => {
        const first = await patch(1, { patch: { status: "done" } })
        expect(first.status).toBe(202)
        expect(first.body).toMatchObject({
            close_out: "started",
            job: { type: "close_out", task_id: 1, status: "queued" },
        })
        expect(first.body.task.status).toBe("inbox")
        expect(h.store.calls.some((c) => c[0] === "updateTask")).toBe(false)

        const again = await patch(1, {
            patch: { status: "done", title: "Shared, finished" },
        })
        expect(again.status).toBe(202)
        expect(again.body.close_out).toBe("pending")
        expect(again.body.job.id).toBe(first.body.job.id)
        expect(again.body.task.title).toBe("Shared, finished")
        const call = h.store.calls.find((c) => c[0] === "updateTask")
        expect(call[2]).toEqual({ title: "Shared, finished" })
        expect(
            h.jobRunner.jobs.filter((j) => j.type === "close_out")
        ).toHaveLength(1)

        // once that job is over, a new Done starts a new close-out
        h.jobRunner.jobs[0].status = "failed"
        const third = await patch(1, { patch: { status: "done" } })
        expect(third.body.close_out).toBe("started")
        expect(third.body.job.id).not.toBe(first.body.job.id)
    })

    test("close_out Done checks the revision and open deliverables", async () => {
        const stale = await patch(1, {
            patch: { status: "done" },
            base_revision: "nope",
        })
        expect(stale.status).toBe(409)
        expect(stale.body.error).toBe("stale_revision")

        h.store.tasks.get(1).task.deliverables = [
            { repo: "aws-lambda", branch: "feat/x", merged_at: null },
        ]
        const open = await patch(1, { patch: { status: "done" } })
        expect(open.status).toBe(409)
        expect(open.body.error).toBe("deliverables_open")
        expect(h.jobRunner.jobs).toHaveLength(0)
    })

    test("done without Asana still requires merged deliverables", async () => {
        h.store.tasks.get(2).task.deliverables = [
            { repo: "aws-lambda", branch: "feat/y", merged_at: null },
        ]
        const open = await patch(2, { patch: { status: "done" } })
        expect(open.status).toBe(409)
        expect(open.body.error).toBe("deliverables_open")
        expect(h.store.calls.some((c) => c[0] === "updateTask")).toBe(false)
        h.store.tasks.get(2).task.deliverables = [
            {
                repo: "aws-lambda",
                branch: "feat/y",
                merged_at: "2026-11-07T10:00:00Z",
            },
            { repo: "ios", branch: "feat/y", disposition: "no_change" },
        ]
        const ok = await patch(2, { patch: { status: "done" } })
        expect(ok.status).toBe(200)
        expect(ok.body.task.status).toBe("done")
        expect(h.jobRunner.jobs).toHaveLength(0)
    })

    test("done on a SOC2-area task needs a change record", async () => {
        h.store.tasks.get(2).task.area = "infra"
        const missing = await patch(2, { patch: { status: "done" } })
        expect(missing.status).toBe(409)
        expect(missing.body).toMatchObject({
            error: "change_record_missing",
            details: {
                missing: ["what", "why", "risk", "rollback", "tested"],
            },
        })
        expect(h.store.calls.some((c) => c[0] === "updateTask")).toBe(false)

        const record =
            "## Change record (SOC2)\n- What: new VPC\n- Why: isolation\n" +
            "- Risk: low\n- Rollback: revert TF\n- Tested: staging\n"
        h.store.seed(h.store.tasks.get(2).task, record)
        const ok = await patch(2, { patch: { status: "done" } })
        expect(ok.status).toBe(200)
        expect(ok.body.task.status).toBe("done")
    })

    test("SOC2 check uses the patched area and covers close-out", async () => {
        // moving into a SOC2 area in the same patch counts
        const moved = await patch(2, {
            patch: { status: "done", area: "access" },
        })
        expect(moved.status).toBe(409)
        expect(moved.body.error).toBe("change_record_missing")

        // Asana-linked: no close-out job without the record
        h.store.tasks.get(1).task.area = "security"
        const res = await patch(1, { patch: { status: "done" } })
        expect(res.status).toBe(409)
        expect(res.body.error).toBe("change_record_missing")
        expect(h.jobRunner.jobs).toHaveLength(0)
    })

    test("task detail and close-out show a missing change record", async () => {
        h.store.tasks.get(2).task.area = "access"
        const res = await bearer(request(h.local).get("/api/tasks/2"))
        expect(res.body.change_record).toEqual({
            section: "Change record (SOC2)",
            present: false,
            missing: ["what", "why", "risk", "rollback", "tested"],
        })
        const job = await bearer(
            request(h.local).post("/api/tasks/2/close-out")
        )
        expect(job.status).toBe(409)
        expect(job.body.error).toBe("change_record_missing")
        expect(h.jobRunner.jobs).toHaveLength(0)

        h.store.seed(
            h.store.tasks.get(2).task,
            "## Change record (SOC2)\n- What: a\n- Why: b\n- Risk: c\n" +
                "- Rollback: d\n- Tested:\n"
        )
        const partial = await bearer(request(h.local).get("/api/tasks/2"))
        expect(partial.body.change_record).toMatchObject({
            present: true,
            missing: ["tested"],
        })
    })

    test("done + a new Asana link in the same patch closes out through Asana", async () => {
        const res = await patch(2, {
            patch: { status: "done", asana: { gid: "777" } },
        })
        expect(res.status).toBe(202)
        expect(res.body.close_out).toBe("started")
        // the link is stored now; the status follows the close-out job
        const call = h.store.calls.find((c) => c[0] === "updateTask")
        expect(call[2]).toEqual({ asana: { gid: "777" } })
        expect(h.jobRunner.jobs.map((j) => j.type)).toEqual(["close_out"])
    })

    test("done + a pending deliverable in the same patch is refused (Asana task)", async () => {
        const res = await patch(1, {
            patch: {
                status: "done",
                deliverables: [
                    {
                        repo: "aws-lambda",
                        branch: "t1-x",
                        role: "work",
                        created_at: "2026-11-07T10:00:00.000Z",
                        disposition: "pr",
                    },
                ],
            },
        })
        expect(res.status).toBe(409)
        expect(res.body.error).toBe("deliverables_open")
        expect(h.jobRunner.jobs).toHaveLength(0)
        expect(h.store.calls.some((c) => c[0] === "updateTask")).toBe(false)
    })

    test("done on an Asana-linked task that is already done is a plain patch", async () => {
        h.store.tasks.get(1).task.status = "done"
        const res = await patch(1, { patch: { status: "done" } })
        expect(res.status).toBe(200)
        expect(h.jobRunner.jobs).toHaveLength(0)
    })

    test("changing or clearing due_at reconciles the due reminder", async () => {
        h.store.tasks.get(2).task.kind = "reminder"
        h.store.tasks.get(2).task.due_at = "2026-11-09T09:00:00.000Z"
        await patch(2, { patch: { due_at: "2026-11-20T09:00:00.000Z" } })
        await patch(2, { patch: { due_at: null } })
        expect(h.scheduler.reconciled).toEqual([
            [2, "2026-11-20T09:00:00.000Z", { ensure: true }],
            [2, null, { ensure: true }],
        ])
    })

    test("turning a dated task into a reminder schedules it; no-op patches do not", async () => {
        h.store.tasks.get(2).task.due_at = "2026-11-09T09:00:00.000Z"
        await patch(2, { patch: { title: "renamed" } })
        await patch(2, { patch: { due_at: "2026-11-09T09:00:00.000Z" } })
        expect(h.scheduler.reconciled).toEqual([])
        await patch(2, { patch: { kind: "reminder" } })
        expect(h.scheduler.reconciled).toEqual([
            [2, "2026-11-09T09:00:00.000Z", { ensure: true }],
        ])
    })

    test("unparseable snooze -> 400", async () => {
        const res = await patch(2, { snooze: "whenever" })
        expect(res.status).toBe(400)
    })

    test("artifact write ok / stale / invalid", async () => {
        const { revision } = (
            await bearer(request(h.local).get("/api/tasks/2"))
        ).body.artifact
        const ok = await bearer(
            request(h.local)
                .put("/api/tasks/2/artifact")
                .send({ content: "# new", base_revision: revision })
        )
        expect(ok.status).toBe(200)
        expect(ok.body.revision).toBeDefined()
        const stale = await bearer(
            request(h.local)
                .put("/api/tasks/2/artifact")
                .send({ content: "# x", base_revision: revision })
        )
        expect(stale.status).toBe(409)
        expect(stale.body.details.current.content).toBe("# new")
        const bad = await bearer(
            request(h.local).put("/api/tasks/2/artifact").send({ content: "x" })
        )
        expect(bad.status).toBe(400)
    })

    test("history and diff", async () => {
        const hist = await bearer(
            request(h.local).get("/api/tasks/2/history?limit=5")
        )
        expect(hist.body.commits[0].message).toBe("m 5")
        const diff = await bearer(
            request(h.local).get("/api/tasks/2/history/abc123")
        )
        expect(diff.body).toEqual({ diff: "diff 2 abc123" })
        const bad = await bearer(
            request(h.local).get("/api/tasks/2/history/zz;rm")
        )
        expect(bad.status).toBe(400)
    })
})

describe("owner: comments, schedules, jobs", () => {
    let h
    beforeEach(() => {
        h = createHarness()
        seedTasks(h.store)
    })

    test("note comment -> no job", async () => {
        const res = await bearer(
            request(h.local)
                .post("/api/tasks/2/comments")
                .send({ body: "just a note", intent: "note" })
        )
        expect(res.status).toBe(201)
        expect(res.body.comment.author).toBe("me")
        expect(res.body.job).toBeUndefined()
        const rec = h.store.calls.find((c) => c[0] === "appendComment")[2]
        expect(rec).toEqual({
            op: "create",
            parent_id: null,
            anchor: null,
            body: "just a note",
            intent: "note",
            author: "me",
            job_id: null,
        })
    })

    test.each(["ask", "change", "chat"])(
        "%s comment enqueues assist",
        async (intent) => {
            const anchor = {
                section: "Plan",
                exact: "do x",
                prefix: "",
                suffix: "",
            }
            const res = await bearer(
                request(h.local)
                    .post("/api/tasks/2/comments")
                    .send({ body: "why?", intent, anchor, parent_id: "c_9" })
            )
            expect(res.status).toBe(201)
            expect(res.body.job).toMatchObject({
                type: "assist",
                task_id: 2,
                input: {
                    comment_id: res.body.comment.id,
                    message: "why?",
                    intent,
                    anchor,
                },
            })
        }
    )

    test("chat without anchor omits it", async () => {
        const res = await bearer(
            request(h.local)
                .post("/api/tasks/2/comments")
                .send({ body: "hi", intent: "chat" })
        )
        expect(res.body.job.input).not.toHaveProperty("anchor")
    })

    test("comment validation", async () => {
        const res = await bearer(
            request(h.local)
                .post("/api/tasks/2/comments")
                .send({ body: "x", intent: "shout" })
        )
        expect(res.status).toBe(400)
    })

    test("comment status", async () => {
        const c = await bearer(
            request(h.local).post("/api/tasks/2/comments").send({ body: "n" })
        )
        const res = await bearer(
            request(h.local)
                .patch(`/api/tasks/2/comments/${c.body.comment.id}`)
                .send({ status: "resolved" })
        )
        expect(res.body.comment.status).toBe("resolved")
        const missing = await bearer(
            request(h.local)
                .patch("/api/tasks/2/comments/c_404")
                .send({ status: "resolved" })
        )
        expect(missing.status).toBe(404)
    })

    test("schedules: when, fire_at, errors, delete", async () => {
        const a = await bearer(
            request(h.local)
                .post("/api/tasks/2/schedules")
                .send({ when: "tomorrow", note: "check" })
        )
        expect(a.status).toBe(201)
        expect(a.body.schedule).toMatchObject({
            task_id: 2,
            fire_at: DUE,
            action: "surface",
            payload: {},
            note: "check",
        })
        const b = await bearer(
            request(h.local)
                .post("/api/tasks/2/schedules")
                .send({
                    fire_at: "2026-12-01T09:00:00Z",
                    action: "center_job",
                    payload: { job_type: "enrich" },
                })
        )
        expect(b.body.schedule.action).toBe("center_job")
        const none = await bearer(
            request(h.local).post("/api/tasks/2/schedules").send({})
        )
        expect(none.status).toBe(400)
        const unparsed = await bearer(
            request(h.local)
                .post("/api/tasks/2/schedules")
                .send({ when: "meh" })
        )
        expect(unparsed.status).toBe(400)
        const missing = await bearer(
            request(h.local)
                .post("/api/tasks/77/schedules")
                .send({ when: "2h" })
        )
        expect(missing.status).toBe(404)
        const del = await bearer(request(h.local).delete("/api/schedules/1"))
        expect(del.body).toEqual({ ok: true })
        expect(
            (await bearer(request(h.local).delete("/api/schedules/99"))).status
        ).toBe(404)
        expect(
            (await bearer(request(h.local).delete("/api/schedules/x"))).status
        ).toBe(400)
    })

    test.each([
        ["asana", "asana_create"],
        ["close-out", "close_out"],
        ["enrich", "enrich"],
    ])("POST /tasks/:id/%s enqueues %s", async (route, type) => {
        const res = await bearer(request(h.local).post(`/api/tasks/2/${route}`))
        expect(res.status).toBe(202)
        expect(res.body.job).toMatchObject({ type, task_id: 2 })
        if (type === "enrich") {
            expect(res.body.job.input.baseline).toEqual(
                await h.store.getArtifact(2)
            )
        }
        if (type === "enrich")
            expect(Object.keys(res.body.job.input.snapshot).sort()).toEqual([
                "area",
                "kind",
                "title",
            ])
        else expect(res.body.job.input).toEqual({})
        const missing = await bearer(
            request(h.local).post(`/api/tasks/55/${route}`)
        )
        expect(missing.status).toBe(404)
    })

    test("POST close-out twice reuses the pending job", async () => {
        const one = await bearer(
            request(h.local).post("/api/tasks/2/close-out")
        )
        const two = await bearer(
            request(h.local).post("/api/tasks/2/close-out")
        )
        expect(two.status).toBe(202)
        expect(two.body.job.id).toBe(one.body.job.id)
        expect(h.jobRunner.jobs).toHaveLength(1)
    })

    test("command, job get and cancel", async () => {
        const res = await bearer(
            request(h.local).post("/api/command").send({ text: "snooze T-2" })
        )
        expect(res.status).toBe(202)
        expect(res.body.job).toMatchObject({
            type: "command",
            input: { text: "snooze T-2" },
            task_id: null,
        })
        const id = res.body.job.id
        const got = await bearer(request(h.local).get(`/api/jobs/${id}`))
        expect(got.body.job.id).toBe(id)
        const c1 = await bearer(request(h.local).post(`/api/jobs/${id}/cancel`))
        expect(c1.body).toEqual({ ok: true })
        const c2 = await bearer(request(h.local).post(`/api/jobs/${id}/cancel`))
        expect(c2.body).toEqual({ ok: false })
        expect(
            (await bearer(request(h.local).get("/api/jobs/nope"))).status
        ).toBe(404)
        expect(
            (await bearer(request(h.local).post("/api/jobs/nope/cancel")))
                .status
        ).toBe(404)
        expect(
            (await bearer(request(h.local).get("/api/jobs/a%20b"))).status
        ).toBe(400)
        const empty = await bearer(
            request(h.local).post("/api/command").send({ text: " " })
        )
        expect(empty.status).toBe(400)
    })

    test("reindex", async () => {
        const res = await bearer(request(h.local).post("/api/admin/reindex"))
        expect(res.body).toEqual({ count: 2 })
    })
})

describe("owner: settings and devices", () => {
    let h
    beforeEach(() => {
        h = createHarness()
    })
    const patch = (body) =>
        bearer(request(h.local).patch("/api/settings").send(body))

    test("get settings", async () => {
        const res = await bearer(request(h.local).get("/api/settings"))
        expect(res.body).toEqual({
            settings: { "center.provider": "claude-sdk" },
        })
    })

    test("settings as an array of rows are normalized", async () => {
        h.settingsRepo.all = () => [{ key: "a", value: 1 }]
        const res = await bearer(request(h.local).get("/api/settings"))
        expect(res.body.settings).toEqual({ a: 1 })
        h.settingsRepo.all = () => null
        expect(
            (await bearer(request(h.local).get("/api/settings"))).body.settings
        ).toEqual({})
    })

    test("patch whitelisted keys emits settings.updated", async () => {
        const events = []
        h.bus.subscribe((e) => events.push(e))
        const res = await patch({
            "center.provider": "codex",
            "center.fallback_provider": null,
            "center.auto_fallback": true,
            "workers.default_kind": "codex",
        })
        expect(res.status).toBe(200)
        expect(res.body.settings).toEqual({
            "center.provider": "codex",
            "center.fallback_provider": null,
            "center.auto_fallback": true,
            "workers.default_kind": "codex",
        })
        expect(events).toHaveLength(1)
        expect(events[0].type).toBe("settings.updated")
        expect(events[0].data.settings["center.provider"]).toBe("codex")
    })

    test("center.models merges per provider", async () => {
        h.settingsRepo.set("center.models", {
            codex: { light: "a", heavy: "b" },
        })
        const res = await patch({
            "center.models": { "claude-sdk": { light: "h", heavy: "s" } },
        })
        expect(res.body.settings["center.models"]).toEqual({
            codex: { light: "a", heavy: "b" },
            "claude-sdk": { light: "h", heavy: "s" },
        })
        h.settingsRepo.map.delete("center.models")
        h.settingsRepo.get = () => null
        const fresh = await patch({
            "center.models": { codex: { light: "x", heavy: "y" } },
        })
        expect(fresh.body.settings["center.models"]).toEqual({
            codex: { light: "x", heavy: "y" },
        })
    })

    test("rejects unknown keys and bad values, sets nothing", async () => {
        const unk = await patch({ "center.provider": "codex", "x.y": 1 })
        expect(unk.status).toBe(400)
        expect(unk.body.details).toEqual({ keys: ["x.y"] })
        expect(h.settingsRepo.get("center.provider")).toBe("claude-sdk")
        expect((await patch({ "center.provider": "gpt" })).status).toBe(400)
        expect((await patch({ "center.auto_fallback": "yes" })).status).toBe(
            400
        )
        expect(
            (
                await patch({
                    "center.models": { other: { light: "a", heavy: "b" } },
                })
            ).status
        ).toBe(400)
        expect((await patch({})).status).toBe(400)
        expect((await patch([1])).status).toBe(400)
        const noBody = await bearer(request(h.local).patch("/api/settings"))
        expect(noBody.status).toBe(400)
    })

    test("devices list hides hashes; revoke errors", async () => {
        await pairDevice(h)
        const res = await bearer(request(h.local).get("/api/devices"))
        expect(res.body.devices).toHaveLength(1)
        expect(res.body.devices[0]).not.toHaveProperty("token_hash")
        expect(
            (await bearer(request(h.local).delete("/api/devices/9"))).status
        ).toBe(404)
        expect(
            (await bearer(request(h.local).delete("/api/devices/a.b"))).status
        ).toBe(400)
        h.devicesRepo.list = () => null
        expect(
            (await bearer(request(h.local).get("/api/devices"))).body.devices
        ).toEqual([])
    })

    test("string device ids are passed through", async () => {
        const seen = []
        h.devicesRepo.revoke = (id) => {
            seen.push(id)
            return undefined
        }
        const res = await bearer(request(h.local).delete("/api/devices/dev_x"))
        expect(res.body).toEqual({ ok: true })
        expect(seen).toEqual(["dev_x"])
    })
})

describe("errors, health, static, mcp", () => {
    test("healthz and security headers", async () => {
        const h = createHarness()
        const res = await request(h.tailnet).get("/healthz")
        expect(res.body).toEqual({ ok: true })
        expect(res.headers["x-content-type-options"]).toBe("nosniff")
        expect(res.headers["x-frame-options"]).toBe("DENY")
        expect(res.headers["referrer-policy"]).toBe("no-referrer")
        expect(res.headers["x-powered-by"]).toBeUndefined()
    })

    test("malformed JSON, too large, unknown route, internal error", async () => {
        const errors = []
        const h = createHarness({
            deps: {
                log: { error: (o) => errors.push(o), info() {}, warn() {} },
            },
        })
        const bad = await bearer(
            request(h.local)
                .post("/api/command")
                .set("Content-Type", "application/json")
                .send("{bad")
        )
        expect(bad.status).toBe(400)
        expect(bad.body.error).toBe("bad_json")
        const big = await bearer(
            request(h.local)
                .post("/api/command")
                .send({ text: "x".repeat(1100000) })
        )
        expect(big.status).toBe(413)
        const unknown = await bearer(request(h.local).get("/api/nope"))
        expect(unknown.status).toBe(404)
        expect((await request(h.local).get("/nope")).status).toBe(404)
        h.store.board = async () => {
            throw new Error("db path /secret")
        }
        const boom = await bearer(request(h.local).get("/api/board"))
        expect(boom.status).toBe(500)
        expect(boom.body).toEqual({
            error: "internal",
            message: "internal error",
        })
        expect(errors[0].err).toBe("db path /secret")
    })

    test("static web/dist with SPA fallback", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-web-"))
        try {
            fs.writeFileSync(path.join(dir, "index.html"), "<html>spa</html>")
            fs.mkdirSync(path.join(dir, "assets"))
            fs.writeFileSync(path.join(dir, "assets", "a.js"), "console.log(1)")
            const h = createHarness({ config: { webDist: dir } })
            const root = await request(h.tailnet).get("/")
            expect(root.status).toBe(200)
            expect(root.text).toBe("<html>spa</html>")
            const deep = await request(h.local).get("/t/12")
            expect(deep.text).toBe("<html>spa</html>")
            const asset = await request(h.local).get("/assets/a.js")
            expect(asset.text).toBe("console.log(1)")
            const api = await bearer(request(h.local).get("/api/nope"))
            expect(api.body.error).toBe("not_found")
            const auth = await request(h.local).get("/auth/other")
            expect(auth.status).toBe(404)
            expect(auth.body.error).toBe("not_found")
            const post = await request(h.local).post("/t/12")
            expect(post.status).toBe(404)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    test("no static when web/dist is missing", async () => {
        const h = createHarness({ config: { webDist: "/nonexistent/dist" } })
        expect((await request(h.local).get("/")).status).toBe(404)
    })

    test("mcp handler: local bearer only", async () => {
        const mcpHandler = jest.fn((req, res) => res.json({ mcp: true }))
        const h = createHarness({ deps: { mcpHandler } })
        const ok = await bearer(request(h.local).post("/mcp").send({}))
        expect(ok.body).toEqual({ mcp: true })
        expect((await request(h.local).post("/mcp")).status).toBe(401)
        const { cookie } = await localSession(h)
        const s = await request(h.local).post("/mcp").set("Cookie", cookie)
        expect(s.status).toBe(403)
        const t = await request(h.tailnet)
            .post("/mcp")
            .set("Tailscale-User-Login", OWNER)
        expect(t.status).toBe(404)
        expect(mcpHandler).toHaveBeenCalledTimes(1)
    })

    test("error after headers were sent ends the response", async () => {
        const errors = []
        const h = createHarness({
            deps: {
                log: { error: (o) => errors.push(o), info() {}, warn() {} },
            },
        })
        void h
        const late = createHarness({
            deps: {
                log: { error: (o) => errors.push(o), info() {}, warn() {} },
                mcpHandler: (req, res) => {
                    res.status(200)
                    res.write("partial")
                    throw new Error("late failure")
                },
            },
        })
        const res = await bearer(request(late.local).post("/mcp"))
        expect(res.status).toBe(200)
        expect(res.text).toBe("partial")
        expect(errors[0].err).toBe("late failure")
    })
})

describe("repos: list and PATCH validation", () => {
    const table = [
        { name: "aws-batch", description: "game processing" },
        { name: "web-trace" },
    ]
    function withRepos(repoTable) {
        const h = createHarness({ deps: { repoTable } })
        h.store.seed(makeTask(1))
        return h
    }

    test("GET /api/repos lists the table (re-read each call); owner only", async () => {
        const repoTable = { list: jest.fn(() => table), reset: jest.fn() }
        const h = withRepos(repoTable)
        const res = await bearer(request(h.local).get("/api/repos"))
        expect(res.status).toBe(200)
        expect(res.body.repos).toEqual([
            { name: "aws-batch", description: "game processing" },
            { name: "web-trace", description: null },
        ])
        expect(repoTable.reset).toHaveBeenCalled()
        const viewer = await request(h.tailnet)
            .get("/api/repos")
            .set("Tailscale-User-Login", "bob@x")
        expect(viewer.status).toBe(403)
    })

    test("no table, or a failing one, lists nothing", async () => {
        const h = withRepos(null)
        expect(
            (await bearer(request(h.local).get("/api/repos"))).body.repos
        ).toEqual([])
        const broken = withRepos({
            list() {
                throw new Error("boom")
            },
        })
        expect(
            (await bearer(request(broken.local).get("/api/repos"))).body.repos
        ).toEqual([])
    })

    test("PATCH repos: canonical names, duplicates dropped, unknown / two mains rejected", async () => {
        const h = withRepos({ list: () => table })
        const ok = await bearer(request(h.local).patch("/api/tasks/1")).send({
            patch: {
                repos: [
                    { name: "AWS-Batch", role: "main" },
                    { name: "aws-batch", role: "ref" },
                    { name: "web-trace", role: "ref" },
                ],
            },
        })
        expect(ok.status).toBe(200)
        expect(ok.body.task.repos).toEqual([
            { name: "aws-batch", role: "main" },
            { name: "web-trace", role: "ref" },
        ])
        const unknown = await bearer(
            request(h.local).patch("/api/tasks/1")
        ).send({
            patch: { repos: [{ name: "nope", role: "main" }] },
        })
        expect(unknown.status).toBe(400)
        expect(unknown.body.details).toEqual({ repos: ["nope"] })
        const twoMains = await bearer(
            request(h.local).patch("/api/tasks/1")
        ).send({
            patch: {
                repos: [
                    { name: "aws-batch", role: "main" },
                    { name: "web-trace", role: "main" },
                ],
            },
        })
        expect(twoMains.status).toBe(400)
        // clearing is allowed
        const cleared = await bearer(
            request(h.local).patch("/api/tasks/1")
        ).send({
            patch: { repos: [] },
        })
        expect(cleared.body.task.repos).toEqual([])
    })

    test("normalizeRepos without a table keeps names as typed", () => {
        expect(normalizeRepos([{ name: " x ", role: "work" }], [])).toEqual([
            { name: "x", role: "work" },
        ])
    })
})
