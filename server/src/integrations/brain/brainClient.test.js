/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import {
    createBrainClient,
    extractJobId,
    normalizeJobResult,
    brainOutput,
    normalizeStatus,
} from "./brainClient.js"

const JOB = "j_0123456789abcdef01234567"
const CONFIG = JSON.stringify({
    mcpServers: {
        "tracebot-mcp": {
            type: "http",
            url: "https://tracebot.example/mcp",
            headers: { Authorization: "Bearer tb-secret" },
        },
        other: { type: "stdio", command: "x" },
        nourl: { type: "http" },
    },
})

const text = (t, extra = {}) => ({
    content: [{ type: "text", text: t }],
    ...extra,
})

function fakeFactory(responder) {
    const clients = []
    const factory = jest.fn(async (server) => {
        const client = {
            server,
            calls: [],
            closed: false,
            callTool: jest.fn(async (req) => {
                client.calls.push(req)
                return responder(req, clients.length)
            }),
            close: jest.fn(async () => {
                client.closed = true
            }),
        }
        clients.push(client)
        return client
    })
    factory.clients = clients
    return factory
}

function make(responder, overrides = {}) {
    const mcpClientFactory = fakeFactory(responder)
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn() }
    const readFile = jest.fn(async () => CONFIG)
    const brain = createBrainClient({
        readFile,
        claudeConfigPath: "/fake/.claude.json",
        serverName: "tracebot-mcp",
        mcpClientFactory,
        log,
        ...overrides,
    })
    return { brain, mcpClientFactory, log, readFile }
}

describe("start", () => {
    test("calls brain_do lazily and extracts the job id from text", async () => {
        const { brain, mcpClientFactory, log, readFile } = make(() =>
            text(`Started job ${JOB}. Call brain_job_result.`)
        )
        expect(mcpClientFactory).not.toHaveBeenCalled()
        const id = await brain.start({
            prompt: "Summarize thread",
            title: "x".repeat(200),
            idempotencyKey: "cc-enrich-123-abc",
        })
        expect(id).toBe(JOB)
        expect(readFile).toHaveBeenCalledWith("/fake/.claude.json", "utf8")
        expect(mcpClientFactory).toHaveBeenCalledWith({
            url: "https://tracebot.example/mcp",
            headers: { Authorization: "Bearer tb-secret" },
        })
        const call = mcpClientFactory.clients[0].calls[0]
        expect(call.name).toBe("brain_do")
        expect(call.arguments).toEqual({
            prompt: "Summarize thread",
            title: "x".repeat(120),
            idempotency_key: "cc-enrich-123-abc",
        })
        expect(JSON.stringify(log.debug.mock.calls)).not.toContain("tb-secret")
        expect(JSON.stringify(log.info.mock.calls)).not.toContain("tb-secret")
        // second call reuses the connection
        await brain.start({ prompt: "again" })
        expect(mcpClientFactory).toHaveBeenCalledTimes(1)
    })

    test("generates an idempotency key when missing or invalid, from structuredContent", async () => {
        const { brain, mcpClientFactory } = make(() => ({
            content: [],
            structuredContent: { job_id: JOB },
        }))
        await brain.start({ prompt: "p", idempotencyKey: "bad key!" })
        const args = mcpClientFactory.clients[0].calls[0].arguments
        expect(args.idempotency_key).toMatch(/^[0-9a-f-]{36}$/)
        expect(args.title).toBeUndefined()
    })

    test("job id from JSON text and nested job", async () => {
        const { brain } = make(() => text(JSON.stringify({ job: { id: JOB } })))
        await expect(brain.start({ prompt: "p" })).resolves.toBe(JOB)
    })

    test("isError and missing job id", async () => {
        const { brain } = make(() =>
            text("prompt too large", { isError: true })
        )
        await expect(brain.start({ prompt: "p" })).rejects.toMatchObject({
            code: "brain_error",
            message: expect.stringContaining("prompt too large"),
        })
        const b2 = make(() => text("ok but nothing")).brain
        await expect(b2.start({ prompt: "p" })).rejects.toThrow("no job id")
        const b3 = make(() => ({})).brain
        await expect(b3.start({ prompt: "p" })).rejects.toThrow("no job id")
    })

    test("requires a prompt", async () => {
        const { brain } = make(() => text(JOB))
        await expect(brain.start({})).rejects.toThrow("prompt required")
        await expect(brain.start()).rejects.toThrow("prompt required")
    })
})

describe("connection handling", () => {
    test("reconnects once after a failed call", async () => {
        let n = 0
        const { brain, mcpClientFactory, log } = make(() => {
            n++
            if (n === 1) throw new Error("session expired")
            return text(JOB)
        })
        await expect(brain.start({ prompt: "p" })).resolves.toBe(JOB)
        expect(mcpClientFactory).toHaveBeenCalledTimes(2)
        expect(mcpClientFactory.clients[0].closed).toBe(true)
        expect(log.warn).toHaveBeenCalled()
    })

    test("gives up after the second failure", async () => {
        const { brain, mcpClientFactory } = make(() => {
            throw new Error("down")
        })
        await expect(brain.start({ prompt: "p" })).rejects.toMatchObject({
            code: "brain_error",
            message: "Brain brain_do failed: down",
        })
        expect(mcpClientFactory).toHaveBeenCalledTimes(2)
    })

    test("factory failure is retried and the next call reconnects", async () => {
        let attempts = 0
        const mcpClientFactory = jest.fn(async () => {
            attempts++
            if (attempts <= 2) throw new Error("connect refused")
            return { callTool: async () => text(JOB) }
        })
        const brain = createBrainClient({
            readFile: async () => CONFIG,
            claudeConfigPath: "/x",
            serverName: "tracebot-mcp",
            mcpClientFactory,
        })
        await expect(brain.start({ prompt: "p" })).rejects.toThrow(
            "connect refused"
        )
        await expect(brain.start({ prompt: "p" })).resolves.toBe(JOB)
        expect(mcpClientFactory).toHaveBeenCalledTimes(3)
        await brain.close() // client without close()
    })

    test("close closes the client and is safe to repeat", async () => {
        const { brain, mcpClientFactory } = make(() => text(JOB))
        await brain.close()
        await brain.start({ prompt: "p" })
        await brain.close()
        expect(mcpClientFactory.clients[0].close).toHaveBeenCalledTimes(1)
        await brain.close()
        await brain.start({ prompt: "p" })
        expect(mcpClientFactory).toHaveBeenCalledTimes(2)
    })

    test("close tolerates a failing close", async () => {
        const mcpClientFactory = async () => ({
            callTool: async () => text(JOB),
            close: async () => {
                throw new Error("already closed")
            },
        })
        const brain = createBrainClient({
            readFile: async () => CONFIG,
            claudeConfigPath: "/x",
            serverName: "tracebot-mcp",
            mcpClientFactory,
        })
        await brain.start({ prompt: "p" })
        await expect(brain.close()).resolves.toBeUndefined()
    })
})

describe("configuration errors", () => {
    test.each([
        ["missing server", { serverName: "nope" }, /not found/],
        ["non-http server", { serverName: "other" }, /must be type "http"/],
        ["server without url", { serverName: "nourl" }, /has no url/],
        [
            "unreadable file",
            {
                readFile: async () => {
                    const e = new Error("ENOENT: no such file")
                    e.code = "ENOENT"
                    throw e
                },
            },
            /cannot read Claude config: ENOENT/,
        ],
        [
            "invalid json",
            { readFile: async () => "{oops" },
            /cannot read Claude config/,
        ],
        ["no mcpServers", { readFile: async () => "{}" }, /not found/],
    ])("%s", async (_name, overrides, re) => {
        const { brain, mcpClientFactory } = make(() => text(JOB), overrides)
        const err = await brain.start({ prompt: "p" }).catch((e) => e)
        expect(err.code).toBe("brain_not_configured")
        expect(err.message).toMatch(re)
        expect(mcpClientFactory).not.toHaveBeenCalled()
    })

    test("headers default to {} and type may be omitted", async () => {
        const cfg = JSON.stringify({
            mcpServers: { tb: { url: "https://x/mcp" } },
        })
        const { brain, mcpClientFactory } = make(() => text(JOB), {
            readFile: async () => cfg,
            serverName: "tb",
        })
        await brain.start({ prompt: "p" })
        expect(mcpClientFactory).toHaveBeenCalledWith({
            url: "https://x/mcp",
            headers: {},
        })
    })
})

describe("result", () => {
    test("calls brain_job_result with clamped wait", async () => {
        const { brain, mcpClientFactory } = make(() => ({
            content: [],
            structuredContent: {
                status: "done",
                phase: null,
                answer: "The answer",
            },
        }))
        await expect(brain.result(JOB, { waitSeconds: 99 })).resolves.toEqual({
            status: "done",
            answer: "The answer",
            phase: null,
            error: null,
        })
        expect(mcpClientFactory.clients[0].calls[0]).toEqual({
            name: "brain_job_result",
            arguments: { job_id: JOB, wait_seconds: 40 },
        })
        await brain.result(JOB)
        await brain.result(JOB, { waitSeconds: -5 })
        await brain.result(JOB, { waitSeconds: "abc" })
        const waits = mcpClientFactory.clients[0].calls.map(
            (c) => c.arguments.wait_seconds
        )
        expect(waits).toEqual([40, 0, 0, 0])
    })

    test("running with phase from JSON text", async () => {
        const { brain } = make(() =>
            text(
                JSON.stringify({
                    job_id: JOB,
                    status: "running",
                    phase: "parked",
                })
            )
        )
        await expect(brain.result(JOB, { waitSeconds: 30 })).resolves.toEqual({
            status: "running",
            answer: null,
            phase: "parked",
            error: null,
        })
    })

    test("rejects invalid job ids", async () => {
        const { brain } = make(() => text(""))
        await expect(brain.result("j_123")).rejects.toThrow(
            "invalid Brain job id"
        )
        await expect(brain.result(`${JOB}0`)).rejects.toThrow(
            "invalid Brain job id"
        )
    })
})

describe("normalizeJobResult", () => {
    test("structured payloads", () => {
        expect(
            normalizeJobResult({
                structuredContent: {
                    job: { status: "completed", result: { a: 1 }, phase: "x" },
                },
            })
        ).toEqual({
            status: "done",
            answer: '{"a":1}',
            phase: "x",
            error: null,
        })
        expect(
            normalizeJobResult({
                structuredContent: { status: "error", error: "boom" },
            })
        ).toEqual({
            status: "failed",
            answer: null,
            phase: null,
            error: "boom",
        })
        expect(
            normalizeJobResult({ structuredContent: { status: "weird" } })
                .status
        ).toBe("running")
        expect(
            normalizeJobResult({
                structuredContent: { status: "weird" },
                isError: true,
            }).status
        ).toBe("failed")
        expect(
            normalizeJobResult({
                structuredContent: { output: "o", status: "done" },
            }).answer
        ).toBe("o")
    })

    test("text with status/phase lines", () => {
        expect(
            normalizeJobResult(text("Job j_x\nstatus: running\nphase: Queued"))
        ).toEqual({
            status: "running",
            answer: null,
            phase: "queued",
            error: null,
        })
        expect(
            normalizeJobResult(
                text("**status**: done\n**answer**:\nThe thread says X.\nMore.")
            )
        ).toEqual({
            status: "done",
            answer: "The thread says X.\nMore.",
            phase: null,
            error: null,
        })
        expect(
            normalizeJobResult(text("status: failed\nreason: crashed"))
        ).toEqual({
            status: "failed",
            answer: null,
            phase: null,
            error: "status: failed\nreason: crashed",
        })
    })

    test("Brain's own words out of the output markers, and the transcript", () => {
        const raw = [
            "Brain job j_1",
            "status: done",
            "tool calls: 9",
            "transcript (Brain admins): https://brain.example.com/chat/1",
            "",
            "Everything between the two markers tagged ab12 below was written by Brain's model ...",
            "<<<BRAIN OUTPUT ab12 (untrusted)>>>",
            "title: cc T-16 Asana link to Slack",
            "RESULT: NOT POSTED - Slack returned `not_in_channel`.",
            "<<<END BRAIN OUTPUT ab12>>>",
        ].join("\n")
        expect(normalizeJobResult(text(raw))).toEqual({
            status: "done",
            answer: "RESULT: NOT POSTED - Slack returned `not_in_channel`.",
            phase: null,
            error: null,
            transcript: "https://brain.example.com/chat/1",
        })
        const failed = raw.replace("status: done", "status: failed")
        expect(normalizeJobResult(text(failed)).error).toBe(
            "RESULT: NOT POSTED - Slack returned `not_in_channel`."
        )
        // only a title, a mismatched tag, nothing at all
        expect(
            brainOutput(
                "<<<BRAIN OUTPUT x1>>>\ntitle: t\n<<<END BRAIN OUTPUT x1>>>"
            )
        ).toEqual({ output: null, transcript: null })
        expect(
            brainOutput("<<<BRAIN OUTPUT x1>>>\nhi\n<<<END BRAIN OUTPUT y2>>>")
                .output
        ).toBeNull()
        expect(brainOutput(null)).toEqual({ output: null, transcript: null })
    })

    test("text without a status field", () => {
        expect(normalizeJobResult(text("Plain answer"))).toMatchObject({
            status: "done",
            answer: "Plain answer",
        })
        expect(normalizeJobResult(text("   "))).toMatchObject({
            status: "running",
            answer: null,
        })
        expect(
            normalizeJobResult(text("no such job", { isError: true }))
        ).toMatchObject({
            status: "failed",
            error: "no such job",
        })
        expect(normalizeJobResult(text("", { isError: true }))).toMatchObject({
            status: "failed",
            error: null,
        })
        expect(
            normalizeJobResult(text("status: done\nanswer:   "))
        ).toMatchObject({
            status: "done",
            answer: null,
        })
        expect(
            normalizeJobResult({ content: [{ type: "image" }, null] })
        ).toMatchObject({
            status: "running",
        })
        expect(normalizeJobResult(text("{not json"))).toMatchObject({
            status: "done",
        })
    })

    test("helpers", () => {
        expect(normalizeStatus("Succeeded")).toBe("done")
        expect(normalizeStatus("cancelled")).toBe("failed")
        expect(normalizeStatus("queued")).toBe("running")
        expect(normalizeStatus(undefined)).toBeNull()
        expect(extractJobId(text("nothing"))).toBeNull()
        expect(extractJobId({ structuredContent: { jobId: JOB } })).toBe(JOB)
    })
})
