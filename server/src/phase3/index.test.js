/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import express from "express"
import request from "supertest"
import { jest } from "@jest/globals"
import { openDb } from "../store/db.js"
import { createFakeClock } from "../util/clock.js"
import * as phase3 from "./index.js"

function memFs() {
    const data = new Map()
    return {
        data,
        mkdirSync: jest.fn(),
        readFileSync: jest.fn((p) => {
            if (!data.has(p))
                throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
            return data.get(p)
        }),
        writeFileSync: jest.fn((p, t) => data.set(p, t)),
        renameSync: jest.fn((a, b) => data.set(b, data.get(a))),
        statSync: jest.fn(() => ({ mode: 0o100600 })),
        chmodSync: jest.fn(),
    }
}

test("re-exports the module API and shared defaults", () => {
    for (const name of [
        "assertChangeRecord",
        "assertTaskChangeRecord",
        "createSoc2",
        "parseChangeRecord",
        "requiresChangeRecord",
        "toMarkdown",
        "createPush",
        "createDigest",
        "localParts",
        "summaryLine",
        "createStaleSweep",
        "mountPhase3",
        "createPhase3",
    ])
        expect(typeof phase3[name]).toBe("function")
    expect(phase3.PHASE3_DEFAULTS).toEqual({
        "digest.enabled": true,
        "digest.time": "08:30",
        "stale.days": 7,
        "push.enabled": false,
    })
    expect(Object.isFrozen(phase3.PHASE3_DEFAULTS)).toBe(true)
})

test("createPhase3 wires push, digest and routes", async () => {
    const fs = memFs()
    const clock = createFakeClock("2026-11-07T12:00:00.000Z")
    const notifier = { notify: jest.fn(async () => true), setPush: jest.fn() }
    const settingsRepo = { get: jest.fn(async (k, d) => d) }
    const store = {
        query: jest.fn(async () => ({ tasks: [], total: 0 })),
    }
    const webpush = {
        generateVAPIDKeys: () => ({ publicKey: "PUB", privateKey: "PRIV" }),
        sendNotification: jest.fn(),
    }
    const p3 = phase3.createPhase3({
        db: openDb(":memory:"),
        store,
        settingsRepo,
        devicesRepo: { get: () => null },
        notifier,
        config: {
            push: { vapidFile: "/cfg/vapid.json", subject: "mailto:x@y" },
            dataDir: "/data",
            timezone: "UTC",
        },
        clock,
        fs,
        webpush,
    })
    p3.start()
    expect(notifier.setPush).toHaveBeenCalledWith(p3.push, settingsRepo)
    expect(fs.data.has("/cfg/vapid.json")).toBe(true)
    await clock.advance(0) // first digest check (12:00 UTC > 08:30)
    expect(fs.data.has("/data/digest.json")).toBe(true)
    p3.setWorkerService({ states: async () => ({}) })
    await p3.stop()

    const app = express()
    const api = express.Router()
    api.use((req, res, next) => {
        req.auth = { role: "owner" }
        next()
    })
    p3.mount(api, { parse: (s, v) => s.parse(v), tailnet: false })
    app.use("/api", api)
    expect((await request(app).get("/api/push/key")).body).toEqual({
        publicKey: "PUB",
    })
    expect((await request(app).get("/api/digest")).body.digest.date).toBe(
        "2026-11-07"
    )
})

test("createPhase3 without notifier or dataDir", async () => {
    const p3 = phase3.createPhase3({
        db: openDb(":memory:"),
        store: { query: async () => ({ tasks: [], total: 0 }) },
        settingsRepo: { get: async () => false },
        config: {
            push: { vapidFile: "/cfg/vapid.json", subject: "mailto:x@y" },
        },
        fs: memFs(),
        webpush: {
            generateVAPIDKeys: () => ({ publicKey: "A", privateKey: "B" }),
        },
        clock: createFakeClock("2026-11-07T12:00:00.000Z"),
    })
    p3.start()
    expect(p3.push.publicKey()).toBe("A")
    await p3.stop()
    const p4 = phase3.createPhase3({
        db: openDb(":memory:"),
        store: {},
        settingsRepo: null,
        notifier: { notify: jest.fn() },
        config: { push: { vapidFile: "/x", subject: "s" } },
        fs: memFs(),
        webpush: {
            generateVAPIDKeys: () => ({ publicKey: "A", privateKey: "B" }),
        },
        clock: createFakeClock("2026-11-07T00:00:00.000Z"),
    })
    p4.start() // notifier without setPush is fine
    await p4.stop()
})
