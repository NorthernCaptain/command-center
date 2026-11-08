/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import express from "express"
import request from "supertest"
import { jest } from "@jest/globals"
import { mapError } from "../http/app.js"
import { ValidationError } from "../util/errors.js"
import { mountPhase3 } from "./routes.js"

const parse = (schema, value, what = "request") => {
    const r = schema.safeParse(value)
    if (!r.success)
        throw new ValidationError(`invalid ${what}`, { issues: r.error.issues })
    return r.data
}

const EVIDENCE = {
    generated_at: "2026-11-07T12:00:00.000Z",
    from: "2026-11-01T00:00:00.000Z",
    to: "2026-11-08T00:00:00.000Z",
    areas: ["infra"],
    tasks: [],
}

function build({ tailnet = false, auth = {}, deps } = {}) {
    const soc2 = { exportEvidence: jest.fn(async () => EVIDENCE) }
    const push = {
        publicKey: jest.fn(() => "PUB"),
        subscribe: jest.fn((body) => ({ endpoint: body.endpoint })),
        unsubscribe: jest.fn(() => true),
    }
    const digest = {
        latest: jest.fn(() => null),
        run: jest.fn(async () => ({ summary: "Morning: all clear" })),
    }
    const app = express()
    const api = express.Router()
    api.use((req, res, next) => {
        req.auth = { role: "owner", ...auth }
        next()
    })
    api.use(express.json())
    mountPhase3(
        api,
        { parse, tailnet, isViewer: () => false },
        deps || { soc2, push, digest }
    )
    app.use("/api", api)
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        const { status, body } = mapError(err)
        res.status(status).json(body)
    })
    return { app, soc2, push, digest }
}

describe("soc2 export", () => {
    test("json with areas", async () => {
        const { app, soc2 } = build()
        const res = await request(app).get(
            "/api/soc2/export?from=2026-11-01&to=2026-11-07&areas=infra, access,"
        )
        expect(res.status).toBe(200)
        expect(res.body).toEqual(EVIDENCE)
        expect(soc2.exportEvidence).toHaveBeenCalledWith({
            from: "2026-11-01",
            to: "2026-11-07",
            areas: ["infra", "access"],
        })
    })

    test("markdown download", async () => {
        const { app, soc2 } = build()
        const res = await request(app).get("/api/soc2/export?format=md")
        expect(res.status).toBe(200)
        expect(res.headers["content-type"]).toMatch(/^text\/markdown/)
        expect(res.headers["content-disposition"]).toBe(
            'attachment; filename="soc2-evidence-2026-11-01-2026-11-08.md"'
        )
        expect(res.text).toMatch(/^# SOC2 change evidence/)
        expect(soc2.exportEvidence).toHaveBeenCalledWith({
            from: undefined,
            to: undefined,
            areas: undefined,
        })
    })

    test("bad format is 400", async () => {
        const { app } = build()
        const res = await request(app).get("/api/soc2/export?format=pdf")
        expect(res.status).toBe(400)
        expect(res.body.error).toBe("validation")
    })
})

describe("push", () => {
    const SUB = { endpoint: "https://push/1", keys: { p256dh: "a", auth: "b" } }

    test("key, subscribe (local owner), unsubscribe", async () => {
        const { app, push } = build()
        expect((await request(app).get("/api/push/key")).body).toEqual({
            publicKey: "PUB",
        })
        const sub = await request(app).post("/api/push/subscribe").send(SUB)
        expect(sub.status).toBe(201)
        expect(sub.body).toEqual({ ok: true, endpoint: "https://push/1" })
        expect(push.subscribe).toHaveBeenCalledWith(SUB, { deviceId: null })
        const del = await request(app)
            .delete("/api/push/subscribe")
            .send({ endpoint: "https://push/1" })
        expect(del.body).toEqual({ ok: true, removed: true })
        const bad = await request(app).delete("/api/push/subscribe").send({})
        expect(bad.status).toBe(400)
    })

    test("tailnet: the owner subscribes without a device; a paired device id is stored", async () => {
        const noDevice = build({ tailnet: true })
        const res = await request(noDevice.app)
            .post("/api/push/subscribe")
            .send(SUB)
        expect(res.status).toBe(201)
        expect(noDevice.push.subscribe).toHaveBeenCalledWith(SUB, {
            deviceId: null,
        })

        const paired = build({
            tailnet: true,
            auth: { via: "device", device: { id: "dev-1" } },
        })
        const ok = await request(paired.app)
            .post("/api/push/subscribe")
            .send(SUB)
        expect(ok.status).toBe(201)
        expect(paired.push.subscribe).toHaveBeenCalledWith(SUB, {
            deviceId: "dev-1",
        })
    })

    test("subscribe without a body passes an empty object", async () => {
        const { app, push } = build()
        push.subscribe.mockImplementationOnce(() => {
            throw new ValidationError("invalid push subscription")
        })
        const res = await request(app).post("/api/push/subscribe")
        expect(res.status).toBe(400)
        expect(push.subscribe).toHaveBeenCalledWith({}, { deviceId: null })
    })
})

describe("digest", () => {
    test("latest and run", async () => {
        const { app, digest } = build()
        expect((await request(app).get("/api/digest")).body).toEqual({
            digest: null,
        })
        const run = await request(app).post("/api/digest/run").send({})
        expect(run.body).toEqual({ digest: { summary: "Morning: all clear" } })
        expect(digest.run).toHaveBeenCalledWith({ notify: false })
        await request(app).post("/api/digest/run").send({ notify: true })
        expect(digest.run).toHaveBeenLastCalledWith({ notify: true })
        await request(app).post("/api/digest/run")
        expect(digest.run).toHaveBeenLastCalledWith({ notify: false })
    })
})

test("modules are optional", async () => {
    const { app } = build({ deps: {} })
    expect((await request(app).get("/api/digest")).status).toBe(404)
    const none = express.Router()
    expect(() => mountPhase3(none, { parse })).not.toThrow()
})
