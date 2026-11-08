/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { openDb } from "../store/db.js"
import { createFakeClock } from "../util/clock.js"
import { createPush, SubscriptionSchema } from "./push.js"

const FILE = "/cfg/command-center/vapid.json"
const SUB = (n) => ({
    endpoint: `https://push.example.com/${n}`,
    keys: { p256dh: `p256-${n}`, auth: `auth${n}` },
})

/** Minimal in-memory fs with modes. */
function memFs(files = {}) {
    const data = new Map(
        Object.entries(files).map(([k, v]) => [k, { text: v, mode: 0o644 }])
    )
    const enoent = (p) =>
        Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" })
    return {
        data,
        mkdirSync: jest.fn(),
        readFileSync: jest.fn((p) => {
            if (!data.has(p)) throw enoent(p)
            return data.get(p).text
        }),
        writeFileSync: jest.fn((p, text, opts = {}) => {
            if (opts.flag === "wx" && data.has(p))
                throw Object.assign(new Error("EEXIST"), { code: "EEXIST" })
            data.set(p, { text, mode: opts.mode ?? 0o644 })
        }),
        statSync: jest.fn((p) => ({ mode: 0o100000 | data.get(p).mode })),
        chmodSync: jest.fn((p, mode) => {
            data.get(p).mode = mode
        }),
    }
}

function fakeWebpush() {
    return {
        generateVAPIDKeys: jest.fn(() => ({
            publicKey: "PUB_key-1",
            privateKey: "PRIV_key-1",
        })),
        sendNotification: jest.fn(async () => ({ statusCode: 201 })),
    }
}

function setup({ files, devices, ...over } = {}) {
    const db = openDb(":memory:")
    const fs = memFs(files)
    const webpush = fakeWebpush()
    const clock = createFakeClock("2026-11-07T12:00:00.000Z")
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const devicesRepo =
        devices === null
            ? null
            : { get: jest.fn((id) => (devices || {})[id] || null) }
    const push = createPush({
        db,
        config: { vapidFile: FILE, subject: "mailto:leo@example.com" },
        devicesRepo,
        fs,
        webpush,
        clock,
        log,
        ...over,
    })
    return { db, fs, webpush, clock, log, push, devicesRepo }
}

describe("VAPID keys", () => {
    test("created once with mode 0600, then loaded", () => {
        const { push, fs, webpush, log } = setup()
        expect(push.init()).toEqual({ publicKey: "PUB_key-1" })
        expect(fs.mkdirSync).toHaveBeenCalledWith("/cfg/command-center", {
            recursive: true,
            mode: 0o700,
        })
        expect(fs.data.get(FILE).mode).toBe(0o600)
        expect(JSON.parse(fs.data.get(FILE).text)).toEqual({
            publicKey: "PUB_key-1",
            privateKey: "PRIV_key-1",
        })
        expect(log.info).toHaveBeenCalled()
        expect(push.publicKey()).toBe("PUB_key-1")
        expect(webpush.generateVAPIDKeys).toHaveBeenCalledTimes(1)
    })

    test("existing file is loaded and tightened to 0600", () => {
        const file = JSON.stringify({ publicKey: "AAA", privateKey: "BBB" })
        const { push, fs, webpush } = setup({ files: { [FILE]: file } })
        expect(push.publicKey()).toBe("AAA")
        expect(fs.chmodSync).toHaveBeenCalledWith(FILE, 0o600)
        expect(webpush.generateVAPIDKeys).not.toHaveBeenCalled()
    })

    test("a 0600 file is left alone", () => {
        const file = JSON.stringify({ publicKey: "AAA", privateKey: "BBB" })
        const s = setup({ files: { [FILE]: file } })
        s.fs.data.get(FILE).mode = 0o600
        s.push.init()
        expect(s.fs.chmodSync).not.toHaveBeenCalled()
    })

    test("a corrupt file throws instead of being replaced", () => {
        const a = setup({ files: { [FILE]: JSON.stringify({ x: 1 }) } })
        expect(() => a.push.init()).toThrow(/invalid VAPID key file/)
        const b = setup({ files: { [FILE]: "{" } })
        expect(() => b.push.init()).toThrow(SyntaxError)
        expect(b.webpush.generateVAPIDKeys).not.toHaveBeenCalled()
    })

    test("a racing writer wins: EEXIST reloads its keys", () => {
        const s = setup()
        const real = s.fs.readFileSync
        let first = true
        s.fs.readFileSync = jest.fn((p) => {
            if (first) {
                first = false
                // another process writes between our read and write
                s.fs.data.set(FILE, {
                    text: JSON.stringify({
                        publicKey: "OTHER",
                        privateKey: "K",
                    }),
                    mode: 0o600,
                })
                throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
            }
            return real(p)
        })
        expect(s.push.publicKey()).toBe("OTHER")
    })

    test("other write errors propagate", () => {
        const s = setup()
        s.fs.writeFileSync = () => {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" })
        }
        expect(() => s.push.init()).toThrow("EACCES")
    })
})

describe("subscriptions", () => {
    test("subscribe upserts, unsubscribe removes, list hides keys", () => {
        const { push, clock } = setup()
        expect(push.subscribe(SUB(1), { deviceId: "d1" })).toEqual({
            endpoint: SUB(1).endpoint,
        })
        clock.set("2026-11-07T13:00:00.000Z")
        push.subscribe(SUB(1), { deviceId: "d2" })
        push.subscribe(SUB(2))
        expect(push.list()).toEqual([
            {
                endpoint: SUB(1).endpoint,
                device_id: "d2",
                created_at: "2026-11-07T12:00:00.000Z",
                last_ok_at: null,
                failures: 0,
            },
            {
                endpoint: SUB(2).endpoint,
                device_id: null,
                created_at: "2026-11-07T13:00:00.000Z",
                last_ok_at: null,
                failures: 0,
            },
        ])
        expect(push.unsubscribe(SUB(1).endpoint)).toBe(true)
        expect(push.unsubscribe(SUB(1).endpoint)).toBe(false)
        expect(() => push.unsubscribe("")).toThrow("endpoint is required")
        expect(() => push.unsubscribe(5)).toThrow("endpoint is required")
    })

    test("invalid subscriptions are rejected", () => {
        const { push } = setup()
        expect(() =>
            push.subscribe({ ...SUB(1), endpoint: "http://insecure/x" })
        ).toThrow("invalid push subscription")
        expect(() => push.subscribe({ endpoint: SUB(1).endpoint })).toThrow(
            "invalid push subscription"
        )
        expect(
            SubscriptionSchema.safeParse({
                ...SUB(1),
                keys: { p256dh: "bad key!", auth: "a" },
            }).success
        ).toBe(false)
    })

    test("removeForDevice drops every subscription of a device", () => {
        const { push } = setup()
        push.subscribe(SUB(1), { deviceId: "d1" })
        push.subscribe(SUB(2), { deviceId: "d1" })
        push.subscribe(SUB(3), { deviceId: "d2" })
        push.subscribe(SUB(4))
        expect(push.removeForDevice("d1")).toBe(2)
        expect(push.removeForDevice(null)).toBe(0)
        expect(push.removeForDevice(undefined)).toBe(0)
        expect(push.removeForDevice("")).toBe(0)
        expect(push.list().map((s) => s.endpoint)).toEqual([
            SUB(3).endpoint,
            SUB(4).endpoint,
        ])
    })
})

describe("sendAll", () => {
    test("no subscriptions: nothing to do, keys not touched", async () => {
        const { push, webpush, fs } = setup()
        expect(await push.sendAll({ title: "x" })).toEqual({
            sent: 0,
            removed: 0,
            failed: 0,
            skipped: 0,
        })
        expect(webpush.sendNotification).not.toHaveBeenCalled()
        expect(fs.writeFileSync).not.toHaveBeenCalled()
    })

    test("sends the payload with VAPID details; records success", async () => {
        const { push, webpush, clock } = setup({
            devices: { d1: { id: "d1", revoked_at: null } },
        })
        push.subscribe(SUB(1), { deviceId: "d1" })
        push.subscribe(SUB(2))
        clock.set("2026-11-07T14:00:00.000Z")
        const res = await push.sendAll({
            title: "Reminder",
            body: "T-1 call",
            url: "/tasks/1",
        })
        expect(res).toEqual({ sent: 2, removed: 0, failed: 0, skipped: 0 })
        expect(webpush.sendNotification).toHaveBeenCalledWith(
            { endpoint: SUB(1).endpoint, keys: SUB(1).keys },
            JSON.stringify({
                title: "Reminder",
                body: "T-1 call",
                url: "/tasks/1",
            }),
            {
                vapidDetails: {
                    subject: "mailto:leo@example.com",
                    publicKey: "PUB_key-1",
                    privateKey: "PRIV_key-1",
                },
                TTL: 21600,
                timeout: 10000,
            }
        )
        expect(push.list()[0].last_ok_at).toBe("2026-11-07T14:00:00.000Z")
    })

    test("defaults title/body/url", async () => {
        const { push, webpush } = setup()
        push.subscribe(SUB(1))
        await push.sendAll()
        expect(webpush.sendNotification.mock.calls[0][1]).toBe(
            JSON.stringify({ title: "Command Center", body: "", url: "/" })
        )
        await push.sendAll({ title: null, body: null, url: "" })
        expect(webpush.sendNotification.mock.calls[1][1]).toBe(
            JSON.stringify({ title: "Command Center", body: "", url: "/" })
        )
    })

    test("404/410 drop the subscription; other errors count failures", async () => {
        const { push, webpush, log } = setup()
        for (const n of [1, 2, 3, 4]) push.subscribe(SUB(n))
        webpush.sendNotification.mockImplementation(async (sub) => {
            const n = sub.endpoint.slice(-1)
            if (n === "1")
                throw Object.assign(new Error("gone"), { statusCode: 410 })
            if (n === "2")
                throw Object.assign(new Error("nf"), { statusCode: 404 })
            if (n === "3")
                throw Object.assign(new Error("boom"), { statusCode: 500 })
            throw null
        })
        expect(await push.sendAll({ title: "x" })).toEqual({
            sent: 0,
            removed: 2,
            failed: 2,
            skipped: 0,
        })
        expect(push.list().map((s) => [s.endpoint, s.failures])).toEqual([
            [SUB(3).endpoint, 1],
            [SUB(4).endpoint, 1],
        ])
        expect(log.warn).toHaveBeenCalled()
        // a later success resets the counter
        webpush.sendNotification.mockResolvedValue({})
        await push.sendAll({ title: "x" })
        expect(push.list().every((s) => s.failures === 0)).toBe(true)
    })

    test("revoked or unknown devices are deleted before sending", async () => {
        const { push, webpush, devicesRepo } = setup({
            devices: {
                ok: { id: "ok", revoked_at: null },
                lost: { id: "lost", revoked_at: "2026-11-06T00:00:00Z" },
            },
        })
        push.subscribe(SUB(1), { deviceId: "ok" })
        push.subscribe(SUB(2), { deviceId: "lost" })
        push.subscribe(SUB(3), { deviceId: "lost" })
        push.subscribe(SUB(4), { deviceId: "gone" })
        const res = await push.sendAll({ title: "x" })
        // each device is checked once; all 3 subscriptions are deleted
        expect(res).toEqual({ sent: 1, removed: 3, failed: 0, skipped: 0 })
        expect(webpush.sendNotification).toHaveBeenCalledTimes(1)
        expect(webpush.sendNotification.mock.calls[0][0].endpoint).toBe(
            SUB(1).endpoint
        )
        expect(devicesRepo.get).toHaveBeenCalledWith("lost")
        expect(devicesRepo.get).toHaveBeenCalledTimes(3)
        expect(push.list().map((s) => s.endpoint)).toEqual([SUB(1).endpoint])
    })

    test("without a devicesRepo device-bound subscriptions are skipped", async () => {
        const { push, webpush } = setup({ devices: null })
        push.subscribe(SUB(1), { deviceId: "d1" })
        push.subscribe(SUB(2))
        push.subscribe(SUB(3), { deviceId: "d1" })
        expect(await push.sendAll({ title: "x" })).toEqual({
            sent: 1,
            removed: 0,
            failed: 0,
            skipped: 2,
        })
        expect(webpush.sendNotification).toHaveBeenCalledTimes(1)
        expect(push.list()).toHaveLength(3)
    })

    test("corrupt stored keys drop the row", async () => {
        const { push, db } = setup()
        push.subscribe(SUB(1))
        db.prepare("UPDATE push_subscriptions SET keys_json = '{'").run()
        expect((await push.sendAll({ title: "x" })).removed).toBe(1)
        expect(push.list()).toEqual([])
    })

    test("missing subject is a configuration error", async () => {
        const { push } = setup({
            config: { vapidFile: FILE, subject: "" },
        })
        push.subscribe(SUB(1))
        await expect(push.sendAll({ title: "x" })).rejects.toMatchObject({
            code: "not_configured",
            status: 503,
        })
    })

    test("uses the real web-push module by default", () => {
        const db = openDb(":memory:")
        const push = createPush({
            db,
            config: { vapidFile: FILE, subject: "mailto:x@y" },
            fs: memFs(),
        })
        expect(push.publicKey()).toMatch(/^[A-Za-z0-9_-]+$/)
    })
})
