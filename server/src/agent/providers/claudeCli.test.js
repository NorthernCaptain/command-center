/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createFakeClock } from "../../util/clock.js"
import { fakeSpawn, flush, waitFor } from "../testing/fakes.js"
import { buildClaudeArgs, createClaudeCliProvider } from "./claudeCli.js"

const schema = { type: "object", properties: { a: { type: "string" } } }
const line = (o) => `${JSON.stringify(o)}\n`

describe("claudeCli provider", () => {
    test("builds args, writes prompt to stdin, parses stream-json", async () => {
        const spawn = fakeSpawn((child) => {
            child.stdout.write(line({ type: "system", subtype: "init" }))
            child.stdout.write("not json\n")
            child.stdout.write(
                line({
                    type: "stream_event",
                    event: {
                        type: "content_block_delta",
                        delta: { type: "text_delta", text: "he" },
                    },
                })
            )
            // final line without trailing newline
            child.stdout.write(
                JSON.stringify({
                    type: "result",
                    subtype: "success",
                    is_error: false,
                    structured_output: { a: "ok" },
                    usage: {},
                })
            )
            child.finish(0)
        })
        const deltas = []
        const p = createClaudeCliProvider({ spawn, cwd: "/w" })
        const res = await p.run({
            system: "sys",
            prompt: "the prompt",
            schema,
            model: "claude-haiku-5-5",
            onDelta: (t) => deltas.push(t),
        })
        expect(p.name).toBe("claude-cli")
        expect(res.output).toEqual({ a: "ok" })
        expect(deltas).toEqual(["he"])
        const call = spawn.calls[0]
        expect(call.bin).toBe("claude")
        expect(call.opts.cwd).toBe("/w")
        expect(call.opts.stdio[0]).toBe("pipe")
        expect(call.child.stdinText).toBe("the prompt")
        expect(call.args).toEqual(
            expect.arrayContaining([
                "-p",
                "--model",
                "claude-haiku-5-5",
                "--output-format",
                "stream-json",
                "--verbose",
                "--json-schema",
                JSON.stringify(schema),
                "--system-prompt",
                "sys",
                "--include-partial-messages",
                "--no-session-persistence",
            ])
        )
    })

    test("args with mcp servers: config file path, exact tools, deny list", () => {
        const args = buildClaudeArgs({
            system: "s",
            schema,
            model: "m",
            mcpServers: { tb: { type: "http", url: "u" } },
            allowedTools: [
                "mcp__tb__brain_do",
                "mcp__tb__wiki_read",
                "mcp__tb",
            ],
            stream: false,
            mcpConfigFile: "/tmp/x/mcp.json",
        })
        expect(args).not.toContain("--include-partial-messages")
        expect(args[args.indexOf("--mcp-config") + 1]).toBe("/tmp/x/mcp.json")
        // brain_do acts as Leo and the CLI cannot rewrite its input: denied
        expect(args[args.indexOf("--allowedTools") + 1]).toBe(
            "mcp__tb__wiki_read"
        )
        expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk")
        const deny = args[args.indexOf("--disallowedTools") + 1].split(",")
        expect(deny).toContain("mcp__tb__slack_post_message")
        expect(deny).toContain("mcp__tb__brain_do")
        expect(deny).not.toContain("mcp__tb__wiki_read")
        // only brain_do requested: no --allowedTools at all
        const only = buildClaudeArgs({
            system: "s",
            schema,
            model: "m",
            mcpServers: { tb: { type: "http", url: "u" } },
            allowedTools: ["mcp__tb__brain_do"],
            mcpConfigFile: "/tmp/x/mcp.json",
        })
        expect(only).not.toContain("--allowedTools")
        expect(() =>
            buildClaudeArgs({
                system: "s",
                schema,
                model: "m",
                mcpServers: { tb: { type: "http", url: "u" } },
            })
        ).toThrow(/mcpConfigFile/)
        // no allowed tools -> no --allowedTools flag at all
        const none = buildClaudeArgs({
            system: "s",
            schema,
            model: "m",
            mcpServers: { tb: { type: "http", url: "u" } },
            mcpConfigFile: "/f",
        })
        expect(none).not.toContain("--allowedTools")
    })

    test("MCP headers go to a 0600 temp file, never argv; file removed after", async () => {
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-cli-test-"))
        try {
            let seen = null
            const spawn = fakeSpawn(async (child, bin, args) => {
                const file = args[args.indexOf("--mcp-config") + 1]
                const st = await fsp.stat(file)
                seen = {
                    file,
                    mode: st.mode & 0o777,
                    json: JSON.parse(await fsp.readFile(file, "utf8")),
                }
                child.stdout.write(
                    line({
                        type: "result",
                        subtype: "success",
                        is_error: false,
                        structured_output: { a: "ok" },
                        usage: {},
                    })
                )
                child.finish(0)
            })
            const mcpServers = {
                tb: {
                    type: "http",
                    url: "u",
                    headers: { "x-api-key": "SECRET" },
                },
            }
            await createClaudeCliProvider({ spawn, tmpDir }).run({
                system: "s",
                prompt: "p",
                schema,
                model: "m",
                mcpServers,
                allowedTools: ["mcp__tb__brain_do"],
            })
            expect(seen.mode).toBe(0o600)
            expect(seen.json).toEqual({ mcpServers })
            expect(spawn.calls[0].args.join(" ")).not.toMatch(/SECRET/)
            expect(await fsp.readdir(tmpDir)).toEqual([])

            // removed on failure too
            const failing = fakeSpawn((child) => child.finish(2))
            await expect(
                createClaudeCliProvider({ spawn: failing, tmpDir }).run({
                    system: "s",
                    prompt: "p",
                    schema,
                    model: "m",
                    mcpServers,
                })
            ).rejects.toThrow(/exited with code 2/)
            expect(await fsp.readdir(tmpDir)).toEqual([])

            // and on abort (service stop): the 0600 key file never lingers
            const hanging = fakeSpawn(() => {})
            const ac = new AbortController()
            const aborted = createClaudeCliProvider({
                spawn: hanging,
                tmpDir,
            }).run({
                system: "s",
                prompt: "p",
                schema,
                model: "m",
                mcpServers,
                signal: ac.signal,
            })
            await waitFor(() => hanging.calls.length === 1)
            expect(await fsp.readdir(tmpDir)).toHaveLength(1)
            ac.abort()
            await expect(aborted).rejects.toMatchObject({ code: "cancelled" })
            expect(await fsp.readdir(tmpDir)).toEqual([])
        } finally {
            await fsp.rm(tmpDir, { recursive: true, force: true })
        }
    })

    test("no output + limit text on stderr -> LimitError", async () => {
        const spawn = fakeSpawn((child) => {
            child.stderr.write(
                "Error: Claude usage limit reached. Try again at 5pm"
            )
            child.finish(1)
        })
        await expect(
            createClaudeCliProvider({ spawn }).run({
                system: "s",
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toMatchObject({ code: "provider_limit" })
    })

    test("no output + other error -> provider_failed", async () => {
        const spawn = fakeSpawn((child) => {
            child.stderr.write("boom")
            child.finish(2)
        })
        await expect(
            createClaudeCliProvider({ spawn }).run({
                system: "s",
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toThrow(/exited with code 2: boom/)
    })

    test("error result -> provider_failed", async () => {
        const spawn = fakeSpawn((child) => {
            child.stdout.write(
                line({
                    type: "result",
                    subtype: "error_max_turns",
                    is_error: true,
                    errors: ["x"],
                })
            )
            child.finish(1)
        })
        await expect(
            createClaudeCliProvider({ spawn }).run({
                system: "s",
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toMatchObject({ code: "provider_failed" })
    })

    test("timeout kills the process", async () => {
        const clock = createFakeClock()
        const spawn = fakeSpawn(() => {})
        const run = createClaudeCliProvider({ spawn, clock }).run({
            system: "s",
            prompt: "p",
            schema,
            model: "m",
            timeoutMs: 500,
        })
        await flush()
        await clock.advance(500)
        await expect(run).rejects.toThrow(/timed out after 500 ms/)
        expect(spawn.calls[0].child.killed).toBe("SIGTERM")
    })

    test("abort kills the process", async () => {
        const spawn = fakeSpawn(() => {})
        const ac = new AbortController()
        const run = createClaudeCliProvider({ spawn }).run({
            system: "s",
            prompt: "p",
            schema,
            model: "m",
            signal: ac.signal,
        })
        await flush()
        ac.abort()
        await expect(run).rejects.toMatchObject({ code: "cancelled" })
        const ac2 = new AbortController()
        ac2.abort()
        await expect(
            createClaudeCliProvider({ spawn }).run({ signal: ac2.signal })
        ).rejects.toMatchObject({ code: "cancelled" })
    })

    test("spawn error event -> provider_failed", async () => {
        const spawn = fakeSpawn((child) =>
            child.emit("error", new Error("ENOENT"))
        )
        await expect(
            createClaudeCliProvider({ spawn }).run({
                system: "s",
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toThrow(/failed to run claude: ENOENT/)
    })

    test("spawn throwing -> provider_failed", async () => {
        const spawn = () => {
            throw new Error("bad")
        }
        await expect(
            createClaudeCliProvider({ spawn }).run({
                system: "s",
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toThrow(/failed to start claude: bad/)
    })

    test("requires spawn", () => {
        expect(() => createClaudeCliProvider({})).toThrow(/spawn/)
    })
})
