/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import express from "express"
import supertest from "supertest"
import { jest } from "@jest/globals"
import { mapError, parseTaskId } from "../http/app.js"
import { AppError, ValidationError } from "../util/errors.js"
import * as workers from "./index.js"
import { mountWorkers, workerBoardExtras, workerTaskExtras } from "./routes.js"

function parse(schema, value, what = "request") {
    const r = schema.safeParse(value)
    if (!r.success)
        throw new ValidationError(`invalid ${what}`, { issues: r.error.issues })
    return r.data
}

function makeApp(workerService, helpers = {}) {
    const app = express()
    const api = express.Router()
    api.use(express.json())
    mountWorkers(
        api,
        { parse, parseTaskId, ACTOR: "me", ...helpers },
        {
            workerService,
        }
    )
    app.use("/api", api)
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        const { status, body } = mapError(err)
        res.status(status).json(body)
    })
    return supertest(app)
}

function fakeService() {
    return {
        startTask: jest.fn(async () => ({
            session: { id: 1, name: "t1-x" },
            warnings: [],
            status: "ok",
        })),
        action: jest.fn(async (id, name) => ({ ok: true, name })),
        agentState: jest.fn(async () => ({ state: "idle", outbox: 0 })),
        queued: jest.fn(async () => [{ id: 3, text: "q" }]),
        states: jest.fn(async () => ({ 1: "working" })),
    }
}

test("index re-exports the module API", () => {
    for (const k of [
        "createIdentity",
        "createWorkerService",
        "folderName",
        "kickoffPrompt",
        "mountWorkers",
        "workerTaskExtras",
        "workerBoardExtras",
        "ACTIONS",
    ])
        expect(workers[k]).toBeDefined()
})

test("POST start -> 202 with the session; kind validated", async () => {
    const svc = fakeService()
    const api = makeApp(svc)
    const r = await api.post("/api/tasks/T-1/start").send({ kind: "codex" })
    expect(r.status).toBe(202)
    expect(r.body.session.name).toBe("t1-x")
    expect(svc.startTask).toHaveBeenCalledWith(1, {
        kind: "codex",
        actor: "me",
    })
    const empty = await api.post("/api/tasks/1/start")
    expect(empty.status).toBe(202)
    expect(svc.startTask).toHaveBeenLastCalledWith(1, {
        kind: undefined,
        actor: "me",
    })
    const bad = await api.post("/api/tasks/1/start").send({ kind: "gpt" })
    expect(bad.status).toBe(400)
    const badId = await api.post("/api/tasks/abc/start")
    expect(badId.status).toBe(400)
})

test("start errors map to their status (409 branch_conflict)", async () => {
    const svc = fakeService()
    svc.startTask.mockRejectedValueOnce(
        new AppError("branch_conflict", "taken", {
            status: 409,
            details: { suggestion: "t1-x-2" },
        })
    )
    const r = await makeApp(svc).post("/api/tasks/1/start").send({})
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({
        error: "branch_conflict",
        details: { suggestion: "t1-x-2" },
    })
})

test("POST actions/:name validates name and body", async () => {
    const svc = fakeService()
    const api = makeApp(svc, { ACTOR: undefined })
    const r = await api
        .post("/api/tasks/1/actions/send")
        .send({ text: "hi", quote: "q" })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, name: "send" })
    expect(svc.action).toHaveBeenCalledWith(
        1,
        "send",
        { text: "hi", quote: "q" },
        { actor: "me" }
    )
    await api.post("/api/tasks/1/actions/retry").send({ id: "4" })
    expect(svc.action.mock.calls.at(-1)[2]).toEqual({ id: 4 })
    await api.post("/api/tasks/1/actions/stop")
    expect(svc.action.mock.calls.at(-1)[2]).toEqual({})
    expect((await api.post("/api/tasks/1/actions/dance")).status).toBe(400)
    expect(
        (await api.post("/api/tasks/1/actions/send").send({ text: 5 })).status
    ).toBe(400)
})

test("GET agent returns the state (or null)", async () => {
    const svc = fakeService()
    const api = makeApp(svc)
    const r = await api.get("/api/tasks/1/agent")
    expect(r.body).toEqual({ state: "idle", outbox: 0 })
    svc.agentState.mockResolvedValueOnce(null)
    const none = await api.get("/api/tasks/1/agent")
    expect(none.status).toBe(200)
    expect(none.body).toBeNull()
})

test("task extras prefer outboxView (pending + failed)", async () => {
    const svc = {
        ...fakeService(),
        outboxView: async () => [
            { id: 3, status: "pending" },
            { id: 4, status: "failed" },
        ],
    }
    expect((await workerTaskExtras(svc)(1, {})).outbox).toEqual([
        { id: 3, status: "pending" },
        { id: 4, status: "failed" },
    ])
})

test("task and board extras", async () => {
    const svc = fakeService()
    expect(await workerTaskExtras(svc)(1, {})).toEqual({
        agent: { state: "idle", outbox: 0 },
        outbox: [{ id: 3, text: "q" }],
    })
    expect(await workerBoardExtras(svc)()).toEqual({
        agents: { 1: "working" },
    })
})
