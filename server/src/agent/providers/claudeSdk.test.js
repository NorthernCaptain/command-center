/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { createFakeClock } from "../../util/clock.js"
import { createClaudeSdkProvider, guardHooks } from "./claudeSdk.js"
import { READ_ONLY_PREFIX, resolveToolPolicy } from "./toolPolicy.js"

const schema = { type: "object", properties: { a: { type: "string" } } }

function fakeQuery(messages, { throwAfter = null, hang = false } = {}) {
    const calls = []
    const query = (args) => {
        calls.push(args)
        return (async function* gen() {
            for (const m of messages) yield m
            if (hang) {
                await new Promise((resolve, reject) => {
                    args.options.abortController.signal.addEventListener(
                        "abort",
                        () => reject(new Error("aborted by controller"))
                    )
                })
            }
            if (throwAfter) throw throwAfter
        })()
    }
    query.calls = calls
    return query
}

const success = (extra = {}) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    structured_output: { a: "x" },
    total_cost_usd: 0.001,
    duration_ms: 1200,
    num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...extra,
})

describe("claudeSdk provider", () => {
    test("passes options and returns structured output with usage", async () => {
        const query = fakeQuery([
            { type: "system", subtype: "init", apiKeySource: "none" },
            {
                type: "stream_event",
                event: {
                    type: "content_block_delta",
                    delta: { type: "text_delta", text: "hi" },
                },
            },
            {
                type: "stream_event",
                event: {
                    type: "content_block_delta",
                    delta: { type: "input_json_delta", partial_json: '{"a"' },
                },
            },
            { type: "stream_event", event: { type: "message_start" } },
            success(),
        ])
        const p = createClaudeSdkProvider({ query, cwd: "/tmp/x" })
        const deltas = []
        const res = await p.run({
            system: "sys",
            prompt: "do it",
            schema,
            model: "claude-haiku-5-5",
            onDelta: (t) => deltas.push(t),
            timeoutMs: 0,
        })
        expect(p.name).toBe("claude-sdk")
        expect(res.output).toEqual({ a: "x" })
        expect(res.model).toBe("claude-haiku-5-5")
        expect(res.usage).toMatchObject({
            input_tokens: 10,
            output_tokens: 5,
            cost_usd: 0.001,
        })
        expect(deltas).toEqual(["hi", '{"a"'])
        const { prompt, options } = query.calls[0]
        expect(prompt).toBe("do it")
        expect(options).toMatchObject({
            model: "claude-haiku-5-5",
            maxTurns: 3,
            systemPrompt: "sys",
            tools: [],
            allowedTools: [],
            disallowedTools: [],
            permissionMode: "dontAsk",
            settingSources: [],
            strictMcpConfig: true,
            persistSession: false,
            outputFormat: { type: "json_schema", schema },
            includePartialMessages: true,
            cwd: "/tmp/x",
        })
        expect(options.mcpServers).toBeUndefined()
    })

    test("mcp servers: only the exact allowed tools, never the whole server", async () => {
        const query = fakeQuery([success()])
        const p = createClaudeSdkProvider({ query, env: { A: "1" } })
        const mcpServers = {
            "tracebot-mcp": { type: "http", url: "http://x", headers: {} },
        }
        await p.run({
            system: "s",
            prompt: "p",
            schema,
            model: "m",
            mcpServers,
            allowedTools: [
                "mcp__tracebot-mcp__brain_do",
                "mcp__tracebot-mcp__brain_job_result",
                "mcp__tracebot-mcp", // server-wide grant: dropped
                "mcp__other__x", // server not passed: dropped
                "Bash",
            ],
        })
        const { options } = query.calls[0]
        expect(options.mcpServers).toBe(mcpServers)
        expect(options.allowedTools).toEqual([
            "mcp__tracebot-mcp__brain_do",
            "mcp__tracebot-mcp__brain_job_result",
        ])
        expect(options.permissionMode).toBe("dontAsk")
        expect(options.disallowedTools).toEqual(
            expect.arrayContaining([
                "mcp__tracebot-mcp__slack_post_message",
                "mcp__tracebot-mcp__deploy_app",
                "mcp__tracebot-mcp__worker_deploy",
                "mcp__tracebot-mcp__run_query",
                "mcp__tracebot-mcp__delete_query",
                "mcp__tracebot-mcp__qa_set_game_param",
            ])
        )
        expect(options.disallowedTools).not.toContain(
            "mcp__tracebot-mcp__brain_do"
        )
        const allow = await options.canUseTool(
            "mcp__tracebot-mcp__brain_do",
            { prompt: "post the summary to #general", title: "t" },
            {}
        )
        expect(allow).toEqual({
            behavior: "allow",
            updatedInput: {
                prompt: `${READ_ONLY_PREFIX}post the summary to #general`,
                title: "t",
            },
        })
        expect(
            await options.canUseTool(
                "mcp__tracebot-mcp__brain_job_result",
                { job_id: "b1" },
                {}
            )
        ).toEqual({ behavior: "allow", updatedInput: { job_id: "b1" } })
        // PreToolUse hook rewrites brain_do even when pre-approved
        expect(options.hooks.PreToolUse).toHaveLength(1)
        const m = options.hooks.PreToolUse[0]
        expect(m.matcher).toBeUndefined()
        expect(m.onFailure).toBe("block")
        const hook = m.hooks[0]
        expect(
            await hook(
                {
                    hook_event_name: "PreToolUse",
                    tool_name: "mcp__tracebot-mcp__brain_do",
                    tool_input: { prompt: "deploy it", idempotency_key: "k" },
                },
                "tu1",
                { signal: new AbortController().signal }
            )
        ).toEqual({
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                updatedInput: {
                    prompt: `${READ_ONLY_PREFIX}deploy it`,
                    idempotency_key: "k",
                },
            },
        })
        expect(
            await hook({
                tool_name: "mcp__tracebot-mcp__wiki_read",
                tool_input: {},
            })
        ).toEqual({})
        expect(await hook(null)).toEqual({})
        expect(
            await hook({ tool_name: "mcp__evil__brain_do", tool_input: {} })
        ).toMatchObject({
            hookSpecificOutput: { permissionDecision: "deny" },
        })
        for (const name of [
            "mcp__tracebot-mcp__slack_post_message",
            "mcp__tracebot-mcp__some_new_tool",
            "Bash",
        ]) {
            expect(await options.canUseTool(name, {}, {})).toMatchObject({
                behavior: "deny",
            })
        }
        expect(options.maxTurns).toBe(10)
        expect(options.includePartialMessages).toBe(false)
        expect(options.env).toEqual({ A: "1" })
    })

    test("no guarded tool allowed -> no hooks", async () => {
        expect(guardHooks(resolveToolPolicy())).toBeNull()
        expect(
            guardHooks(
                resolveToolPolicy({
                    mcpServers: { tb: {} },
                    allowedTools: ["mcp__tb__wiki_read"],
                })
            )
        ).toBeNull()
        const query = fakeQuery([success()])
        await createClaudeSdkProvider({ query }).run({
            system: "s",
            prompt: "p",
            schema,
            model: "m",
            mcpServers: { tb: {} },
            allowedTools: ["mcp__tb__wiki_read"],
        })
        expect(query.calls[0].options.hooks).toBeUndefined()
    })

    test("mcp servers without allowedTools allow nothing (fail closed)", async () => {
        const query = fakeQuery([success()])
        await createClaudeSdkProvider({ query }).run({
            system: "s",
            prompt: "p",
            schema,
            model: "m",
            mcpServers: { tb: { type: "http", url: "u" } },
        })
        const { options } = query.calls[0]
        expect(options.allowedTools).toEqual([])
        expect(options.disallowedTools).toContain("mcp__tb__slack_post_message")
    })

    test("falls back to parsing result text when structured_output is missing", async () => {
        const query = fakeQuery([
            success({ structured_output: undefined, result: '{"a":"y"}' }),
        ])
        const res = await createClaudeSdkProvider({ query }).run({
            prompt: "p",
            schema,
            model: "m",
        })
        expect(res.output).toEqual({ a: "y" })
    })

    test("no structured output -> provider_failed", async () => {
        const query = fakeQuery([
            success({ structured_output: undefined, result: "not json" }),
        ])
        await expect(
            createClaudeSdkProvider({ query }).run({
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toMatchObject({ code: "provider_failed" })
    })

    test("rate limit assistant error -> LimitError", async () => {
        const query = fakeQuery([
            { type: "assistant", error: "rate_limit", message: {} },
            {
                type: "result",
                subtype: "success",
                is_error: true,
                result: "API Error",
            },
        ])
        await expect(
            createClaudeSdkProvider({ query }).run({
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toMatchObject({ code: "provider_limit" })
    })

    test("rate_limit_event rejected without result -> LimitError", async () => {
        const query = fakeQuery([
            {
                type: "rate_limit_event",
                rate_limit_info: {
                    status: "rejected",
                    rateLimitType: "five_hour",
                    resetsAt: 1800000000,
                },
            },
        ])
        await expect(
            createClaudeSdkProvider({ query }).run({
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toThrow(/five_hour/)
    })

    test("limit text in result errors -> LimitError", async () => {
        const query = fakeQuery([
            {
                type: "result",
                subtype: "error_during_execution",
                is_error: true,
                errors: ["Claude AI usage limit reached"],
            },
        ])
        await expect(
            createClaudeSdkProvider({ query }).run({
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toMatchObject({ code: "provider_limit" })
    })

    test("other error result -> provider_failed", async () => {
        const query = fakeQuery([
            {
                type: "result",
                subtype: "error_max_structured_output_retries",
                is_error: true,
                errors: [],
            },
        ])
        await expect(
            createClaudeSdkProvider({ query }).run({
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toMatchObject({
            code: "provider_failed",
            message: expect.stringContaining(
                "error_max_structured_output_retries"
            ),
        })
    })

    test("no result at all -> provider_failed", async () => {
        const query = fakeQuery([{ type: "system" }, null])
        await expect(
            createClaudeSdkProvider({ query }).run({
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toThrow(/no result/)
    })

    test("thrown error after a result still returns the result", async () => {
        const query = fakeQuery([success()], {
            throwAfter: new Error("exit 1"),
        })
        const res = await createClaudeSdkProvider({ query }).run({
            prompt: "p",
            schema,
            model: "m",
        })
        expect(res.output).toEqual({ a: "x" })
    })

    test("thrown error after a limit message -> LimitError", async () => {
        const query = fakeQuery(
            [{ type: "assistant", error: "billing_error" }],
            {
                throwAfter: new Error("exit 1"),
            }
        )
        await expect(
            createClaudeSdkProvider({ query }).run({
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toMatchObject({ code: "provider_limit" })
    })

    test("thrown error without result -> provider_failed", async () => {
        const query = fakeQuery([], { throwAfter: new Error("spawn ENOENT") })
        await expect(
            createClaudeSdkProvider({ query }).run({
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toThrow(/spawn ENOENT/)
    })

    test("timeout aborts the query", async () => {
        const clock = createFakeClock()
        const query = fakeQuery([], { hang: true })
        const p = createClaudeSdkProvider({ query, clock })
        const run = p.run({ prompt: "p", schema, model: "m", timeoutMs: 1000 })
        await new Promise((r) => setImmediate(r))
        await clock.advance(1000)
        await expect(run).rejects.toThrow(/timed out after 1000 ms/)
    })

    test("external abort -> cancelled", async () => {
        const query = fakeQuery([], { hang: true })
        const ac = new AbortController()
        const run = createClaudeSdkProvider({ query }).run({
            prompt: "p",
            schema,
            model: "m",
            signal: ac.signal,
        })
        await new Promise((r) => setImmediate(r))
        ac.abort()
        await expect(run).rejects.toMatchObject({ code: "cancelled" })
    })

    test("already aborted signal rejects immediately", async () => {
        const ac = new AbortController()
        ac.abort()
        await expect(
            createClaudeSdkProvider({ query: fakeQuery([]) }).run({
                signal: ac.signal,
            })
        ).rejects.toMatchObject({ code: "cancelled" })
    })

    test("generator ending normally after abort/timeout flags", async () => {
        // query that ignores abort and finishes without throwing
        const clock = createFakeClock()
        let release
        const gate = new Promise((r) => (release = r))
        const query = () =>
            (async function* gen() {
                await gate
                yield success()
            })()
        const p = createClaudeSdkProvider({ query, clock })
        const run = p.run({ prompt: "p", schema, model: "m", timeoutMs: 10 })
        await new Promise((r) => setImmediate(r))
        await clock.advance(10)
        release()
        await expect(run).rejects.toThrow(/timed out/)

        const ac = new AbortController()
        let release2
        const gate2 = new Promise((r) => (release2 = r))
        const q2 = () =>
            (async function* gen() {
                await gate2
                yield success()
            })()
        const run2 = createClaudeSdkProvider({ query: q2 }).run({
            prompt: "p",
            schema,
            model: "m",
            signal: ac.signal,
        })
        ac.abort()
        release2()
        await expect(run2).rejects.toMatchObject({ code: "cancelled" })
    })

    test("requires query", () => {
        expect(() => createClaudeSdkProvider({})).toThrow(/query/)
    })
})
