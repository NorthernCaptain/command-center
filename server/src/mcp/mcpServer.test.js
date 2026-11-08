/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import http from "node:http"
import { jest } from "@jest/globals"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createHarness, request, TOKEN } from "../http/testing/fakes.js"
import { AppError } from "../util/errors.js"
import {
    buildMcpServer,
    createMcpHandler,
    toErrorResult,
    toResult,
} from "./mcpServer.js"
import { createAgentTools, TOOL_NAMES } from "./tools.js"

const TASK = {
    id: 7,
    title: "Fix upload retry",
    status: "active",
    links: [],
    deliverables: [],
    asana: { url: null },
}

function fakeStore() {
    return {
        getTask: jest.fn(async (id) => {
            if (id !== 7)
                throw new AppError("not_found", "task not found", {
                    status: 404,
                })
            return { task: TASK, revision: "t1" }
        }),
        getArtifact: jest.fn(async () => ({
            content: "# T-7 — Fix upload retry\n",
            revision: "a1",
        })),
        listComments: jest.fn(async () => []),
        listFeedback: jest.fn(async () => []),
    }
}

function makeTools() {
    const workerService = { agentState: jest.fn(async () => null) }
    return createAgentTools({
        store: fakeStore(),
        scheduler: {},
        dateParser: {},
        workerService,
    })
}

let server
let baseUrl
let log

beforeEach(async () => {
    log = {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    }
    const tools = makeTools()
    const h = createHarness({
        deps: { mcpHandler: createMcpHandler({ tools, log }) },
    })
    server = http.createServer(h.local)
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
})

async function connect(headers = {}) {
    const client = new Client({ name: "test", version: "1.0.0" })
    const transport = new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/mcp`),
        {
            requestInit: {
                headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
            },
        }
    )
    await client.connect(transport)
    return client
}

const parse = (res) => JSON.parse(res.content[0].text)

describe("MCP over Streamable HTTP (stateless)", () => {
    test("lists every tool with an input schema", async () => {
        const client = await connect()
        const { tools } = await client.listTools()
        expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
        const upd = tools.find((t) => t.name === "cc_update_artifact")
        expect(upd.description).toMatch(/base_revision/)
        expect(upd.inputSchema.properties).toHaveProperty("base_revision")
        expect(upd.inputSchema.required).toEqual(
            expect.arrayContaining(["task_id", "section", "op", "content"])
        )
        await client.close()
    })

    test("cc_get_task returns the brief as JSON text", async () => {
        const client = await connect({ "X-CC-Task": "7" })
        const res = await client.callTool({
            name: "cc_get_task",
            arguments: { task_id: 7 },
        })
        expect(res.isError).toBeFalsy()
        const body = parse(res)
        expect(body.task.title).toBe("Fix upload retry")
        expect(body.revision).toBe("a1")
        expect(body.artifact).toMatch(/^# T-7/)
        await client.close()
    })

    test("wrong task (X-CC-Task header) is an isError result", async () => {
        const client = await connect({ "X-CC-Task": "8" })
        const res = await client.callTool({
            name: "cc_get_task",
            arguments: { task_id: "T-7" },
        })
        expect(res.isError).toBe(true)
        expect(parse(res)).toMatchObject({ error: "wrong_task" })
        await client.close()
    })

    test("store errors map to { error, message }", async () => {
        const client = await connect()
        const res = await client.callTool({
            name: "cc_get_task",
            arguments: { task_id: 99 },
        })
        expect(res.isError).toBe(true)
        expect(parse(res)).toEqual({
            error: "not_found",
            message: "task not found",
        })
        await client.close()
    })

    test("GET and DELETE are 405; no bearer is 401", async () => {
        const get = await fetch(`${baseUrl}/mcp`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        })
        expect(get.status).toBe(405)
        expect(get.headers.get("allow")).toBe("POST")
        const del = await fetch(`${baseUrl}/mcp`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${TOKEN}` },
        })
        expect(del.status).toBe(405)
        const anon = await fetch(`${baseUrl}/mcp`, { method: "POST" })
        expect(anon.status).toBe(401)
    })
})

describe("helpers", () => {
    test("toResult / toErrorResult", () => {
        expect(toResult({ a: 1 })).toEqual({
            content: [{ type: "text", text: '{"a":1}' }],
        })
        const log = { error: jest.fn() }
        const e = toErrorResult(new Error("boom"), log)
        expect(e.isError).toBe(true)
        expect(JSON.parse(e.content[0].text)).toEqual({
            error: "internal",
            message: "internal error",
        })
        expect(log.error).toHaveBeenCalled()
        const v = toErrorResult(
            new AppError("stale_revision", "stale", {
                status: 409,
                details: { revision: "r", content: "c" },
            })
        )
        expect(JSON.parse(v.content[0].text).details).toEqual({
            revision: "r",
            content: "c",
        })
    })

    test("buildMcpServer passes the ctx to every tool", async () => {
        const calls = []
        const tools = Object.fromEntries(
            TOOL_NAMES.map((n) => [
                n,
                async (args, ctx) => {
                    calls.push([n, args, ctx])
                    return { ok: true }
                },
            ])
        )
        const ctx = { callerTaskId: "3", agent: "t3-x" }
        const server = buildMcpServer({ tools, ctx })
        const [a, b] = InMemoryTransport.createLinkedPair()
        await server.connect(a)
        const client = new Client({ name: "t", version: "1" })
        await client.connect(b)
        const res = await client.callTool({
            name: "cc_log_decision",
            arguments: { task_id: 3, decision: "d", rationale: "r" },
        })
        expect(parse(res)).toEqual({ ok: true })
        expect(calls).toEqual([
            [
                "cc_log_decision",
                { task_id: 3, decision: "d", rationale: "r" },
                ctx,
            ],
        ])
        await client.close()
    })

    test("request() still reaches the API without /mcp interference", async () => {
        const h = createHarness({
            deps: { mcpHandler: createMcpHandler({ tools: makeTools() }) },
        })
        const r = await request(h.local)
            .get("/mcp")
            .set("Authorization", `Bearer ${TOKEN}`)
        expect(r.status).toBe(405)
    })
})
