/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { createHarness, request, TOKEN } from "../http/testing/fakes.js"
import { AppError } from "../util/errors.js"
import { mountAgentTools } from "./routes.js"
import { TOOL_NAMES } from "./tools.js"

function setup() {
    const tools = Object.fromEntries(
        TOOL_NAMES.map((n) => [n, jest.fn(async () => ({ ok: true, tool: n }))])
    )
    const h = createHarness({
        deps: {
            mounts: [
                (api, helpers) => mountAgentTools(api, helpers, { tools }),
            ],
        },
    })
    return { h, tools }
}

const bearer = (r) => r.set("Authorization", `Bearer ${TOKEN}`)

describe("POST /api/agent/:tool", () => {
    test("calls the tool with the body and header ctx", async () => {
        const { h, tools } = setup()
        const r = await bearer(request(h.local).post("/api/agent/cc_report"))
            .set("X-CC-Task", "12")
            .set("X-CC-Agent", "t12-x")
            .send({ task_id: 12, status: "progress", summary: "s" })
        expect(r.status).toBe(200)
        expect(r.body).toEqual({ ok: true, tool: "cc_report" })
        expect(tools.cc_report).toHaveBeenCalledWith(
            { task_id: 12, status: "progress", summary: "s" },
            { callerTaskId: "12", agent: "t12-x" }
        )
    })

    test("empty body becomes {}", async () => {
        const { h, tools } = setup()
        await bearer(request(h.local).post("/api/agent/cc_get_task"))
        expect(tools.cc_get_task).toHaveBeenCalledWith(
            {},
            { callerTaskId: null, agent: null }
        )
    })

    test("unknown tool is 404", async () => {
        const { h } = setup()
        const r = await bearer(request(h.local).post("/api/agent/rm_rf")).send(
            {}
        )
        expect(r.status).toBe(404)
        expect(r.body.error).toBe("not_found")
    })

    test("tool errors map to their status", async () => {
        const { h, tools } = setup()
        tools.cc_update_artifact.mockRejectedValueOnce(
            new AppError("stale_revision", "stale", {
                status: 409,
                details: { revision: "r2", content: "c" },
            })
        )
        const r = await bearer(
            request(h.local).post("/api/agent/cc_update_artifact")
        ).send({})
        expect(r.status).toBe(409)
        expect(r.body).toEqual({
            error: "stale_revision",
            message: "stale",
            details: { revision: "r2", content: "c" },
        })
    })

    test("requires auth", async () => {
        const { h } = setup()
        const r = await request(h.local).post("/api/agent/cc_get_task")
        expect(r.status).toBe(401)
    })
})
