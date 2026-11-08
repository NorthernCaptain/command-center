/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createFakeClock } from "../../util/clock.js"
import { fakeSpawn, waitFor } from "../testing/fakes.js"
import {
    buildCodexArgs,
    codexConfigToml,
    DISABLED_FEATURES,
    createCodexProvider,
    ensureCodexHome,
    STALE_AUTH_BACKUP,
} from "./codex.js"

const schema = { type: "object", properties: { a: { type: "string" } } }
let root
let tmpDir
let codexHome
let authFile

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-agent-codex-test-"))
    tmpDir = path.join(root, "work")
    codexHome = path.join(root, "codex-home")
    authFile = path.join(root, "auth.json")
    await fs.mkdir(tmpDir)
    await fs.writeFile(authFile, "{}")
})
afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
})

/** Provider with temp dirs only (never the real ~/.codex). */
const mk = (opts) =>
    createCodexProvider({ fs, tmpDir, codexHome, authFile, ...opts })

const outFileOf = (args) => args[args.indexOf("-o") + 1]
const schemaFileOf = (args) => args[args.indexOf("--output-schema") + 1]

describe("codex provider", () => {
    test("runs codex exec with the prompt on stdin, a dedicated CODEX_HOME and parses the output file", async () => {
        let schemaSeen
        const spawn = fakeSpawn(async (child, bin, args) => {
            schemaSeen = JSON.parse(
                await fs.readFile(schemaFileOf(args), "utf8")
            )
            await fs.writeFile(outFileOf(args), JSON.stringify({ a: "done" }))
            child.stderr.write("tokens used: 1,234\n")
            child.finish(0)
        })
        const p = mk({
            spawn,
            codexSettings: { model_reasoning_effort: "low" },
        })
        const res = await p.run({
            system: "SYS",
            prompt: "PROMPT",
            schema,
            model: "gpt-6-luna",
        })
        expect(p.name).toBe("codex")
        expect(res).toEqual({
            output: { a: "done" },
            usage: { total_tokens: 1234 },
            model: "gpt-6-luna",
        })
        expect(schemaSeen).toEqual(schema)
        const { bin, args, opts } = spawn.calls[0]
        expect(bin).toBe("codex")
        // prompt via stdin ("-"), stream ended after writing
        expect(opts.stdio[0]).toBe("pipe")
        expect(spawn.calls[0].child.stdinText).toBe("SYS\n\n---\n\nPROMPT")
        expect(spawn.calls[0].child.stdin.writableEnded).toBe(true)
        expect(args[args.length - 1]).toBe("-")
        expect(args.join(" ")).not.toMatch(/PROMPT/)
        // no MCP servers: dedicated CODEX_HOME with a minimal config
        expect(opts.env.CODEX_HOME).toBe(codexHome)
        const toml = await fs.readFile(
            path.join(codexHome, "config.toml"),
            "utf8"
        )
        expect(toml).not.toMatch(/^\[?mcp_servers/m)
        expect(toml).toMatch(/^model_reasoning_effort = "low"$/m)
        expect(await fs.readlink(path.join(codexHome, "auth.json"))).toBe(
            authFile
        )
        expect(args.slice(0, 8)).toEqual([
            "exec",
            "-m",
            "gpt-6-luna",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--ephemeral",
            "--color",
        ])
        // temp dir cleaned up
        expect(await fs.readdir(tmpDir)).toEqual([])
    })

    test("prompt without system goes to stdin as is", async () => {
        const spawn = fakeSpawn(async (child, bin, args) => {
            await fs.writeFile(outFileOf(args), JSON.stringify({ a: "x" }))
            child.finish(0)
        })
        await mk({ spawn }).run({ prompt: "p", schema, model: "m" })
        expect(spawn.calls[0].child.stdinText).toBe("p")
        expect(
            buildCodexArgs({ model: "m", schemaFile: "s", outFile: "o" })
        ).toContain("-")
    })

    test("a large prompt never lands on argv", async () => {
        const big = "x".repeat(2 * 1024 * 1024)
        const spawn = fakeSpawn(async (child, bin, args) => {
            await fs.writeFile(outFileOf(args), JSON.stringify({ a: "x" }))
            child.finish(0)
        })
        await mk({ spawn }).run({ prompt: big, schema, model: "m" })
        const { args, child } = spawn.calls[0]
        expect(args.join(" ").length).toBeLessThan(10000)
        expect(child.stdinText.length).toBe(big.length)
    })

    describe("ensureCodexHome", () => {
        const link = () => path.join(codexHome, "auth.json")
        const cfg = () => path.join(codexHome, "config.toml")
        const leftovers = async (dir) =>
            (await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"))
        const spyLog = () => {
            const calls = { warn: [], info: [] }
            return {
                calls,
                warn: (o, m) => calls.warn.push(m),
                info: (o, m) => calls.info.push(m),
                error() {},
                debug() {},
            }
        }
        const setMtime = (file, sec) => fs.utimes(file, sec, sec)

        test("config.toml is written atomically and only when it changed", async () => {
            await ensureCodexHome(fs, { codexHome, authFile, settings: {} })
            const st1 = await fs.stat(cfg())
            expect(st1.mode & 0o777).toBe(0o600)
            await ensureCodexHome(fs, { codexHome, authFile, settings: {} })
            const st2 = await fs.stat(cfg())
            expect(st2.ino).toBe(st1.ino) // untouched
            await ensureCodexHome(fs, {
                codexHome,
                authFile,
                settings: { model_reasoning_effort: "low" },
            })
            expect(await fs.readFile(cfg(), "utf8")).toMatch(
                /model_reasoning_effort = "low"/
            )
            expect(await leftovers(codexHome)).toEqual([])
        })

        test("parallel first use on a fresh home: all succeed, one link", async () => {
            const res = await Promise.allSettled(
                [1, 2, 3, 4].map(() =>
                    ensureCodexHome(fs, { codexHome, authFile, settings: {} })
                )
            )
            expect(res.map((r) => r.status)).toEqual([
                "fulfilled",
                "fulfilled",
                "fulfilled",
                "fulfilled",
            ])
            expect(await fs.readlink(link())).toBe(authFile)
            expect(await leftovers(codexHome)).toEqual([])
        })

        test("the link is replaced by rename, never removed first", async () => {
            const other = path.join(root, "other.json")
            await fs.writeFile(other, "{}")
            await fs.mkdir(codexHome, { recursive: true })
            await fs.symlink(other, link())
            const seen = []
            const spyFs = {
                ...fs,
                rm: async (p, o) => {
                    seen.push(["rm", path.basename(p)])
                    return fs.rm(p, o)
                },
                rename: async (a, b) => {
                    seen.push(["rename", path.basename(b)])
                    return fs.rename(a, b)
                },
            }
            await ensureCodexHome(spyFs, {
                codexHome,
                authFile,
                settings: {},
            })
            expect(await fs.readlink(link())).toBe(authFile)
            expect(seen).toContainEqual(["rename", "auth.json"])
            expect(seen.filter(([op]) => op === "rm")).toEqual([])
        })

        test("a plain file newer than authFile is moved over authFile, then relinked", async () => {
            await fs.writeFile(authFile, '{"old":true}')
            await setMtime(authFile, 1000)
            await fs.mkdir(codexHome, { recursive: true })
            await fs.writeFile(link(), '{"refreshed":true}')
            await setMtime(link(), 2000)
            const log = spyLog()
            await ensureCodexHome(
                fs,
                { codexHome, authFile, settings: {} },
                log
            )
            expect(await fs.readFile(authFile, "utf8")).toBe(
                '{"refreshed":true}'
            )
            expect((await fs.stat(authFile)).mode & 0o777).toBe(0o600)
            expect(await fs.readlink(link())).toBe(authFile)
            expect(log.calls.info.join()).toMatch(/moved to authFile/)
            expect(await leftovers(root)).toEqual([])
        })

        test("a plain file with authFile missing is moved there too", async () => {
            await fs.rm(authFile)
            await fs.mkdir(codexHome, { recursive: true })
            await fs.writeFile(link(), '{"only":true}')
            await ensureCodexHome(fs, { codexHome, authFile, settings: {} })
            expect(await fs.readFile(authFile, "utf8")).toBe('{"only":true}')
            expect(await fs.readlink(link())).toBe(authFile)
        })

        test("a plain file not newer than authFile is backed up and relinked", async () => {
            await fs.writeFile(authFile, '{"real":true}')
            await setMtime(authFile, 3000)
            await fs.mkdir(codexHome, { recursive: true })
            await fs.writeFile(link(), '{"stale":true}')
            await setMtime(link(), 2000)
            const log = spyLog()
            await ensureCodexHome(
                fs,
                { codexHome, authFile, settings: {} },
                log
            )
            // the newer main login is used again...
            expect(await fs.readlink(link())).toBe(authFile)
            expect(await fs.readFile(link(), "utf8")).toBe('{"real":true}')
            expect(await fs.readFile(authFile, "utf8")).toBe('{"real":true}')
            // ...and the older isolated tokens are kept as a backup
            const backup = path.join(codexHome, STALE_AUTH_BACKUP)
            expect(await fs.readFile(backup, "utf8")).toBe('{"stale":true}')
            expect((await fs.stat(backup)).mode & 0o777).toBe(0o600)
            expect(log.calls.warn.join()).toMatch(/backed up, link restored/)
            // the next run leaves the restored link alone
            await ensureCodexHome(fs, { codexHome, authFile, settings: {} })
            expect(await fs.readlink(link())).toBe(authFile)
        })

        test("something else at auth.json (a dir) is left in place and logged", async () => {
            await fs.mkdir(link(), { recursive: true })
            const log = spyLog()
            await ensureCodexHome(
                fs,
                { codexHome, authFile, settings: {} },
                log
            )
            expect((await fs.lstat(link())).isDirectory()).toBe(true)
            expect(log.calls.warn.join()).toMatch(
                /neither a file nor a symlink/
            )
        })

        test("a correct link is kept; no authFile means no link", async () => {
            await ensureCodexHome(fs, { codexHome, authFile, settings: {} })
            const ino = (await fs.lstat(link())).ino
            await ensureCodexHome(fs, { codexHome, authFile, settings: {} })
            expect((await fs.lstat(link())).ino).toBe(ino)
            const home2 = path.join(root, "h2")
            await ensureCodexHome(fs, { codexHome: home2, authFile: null })
            expect(await fs.readdir(home2)).toEqual(["config.toml"])
        })

        test("failures reject, remove the temp file and do not block later calls", async () => {
            let failRename = true
            const flaky = {
                ...fs,
                rename: async (a, b) => {
                    if (failRename) {
                        failRename = false
                        throw Object.assign(new Error("boom"), {
                            code: "EIO",
                        })
                    }
                    return fs.rename(a, b)
                },
            }
            await expect(
                ensureCodexHome(flaky, { codexHome, authFile, settings: {} })
            ).rejects.toThrow(/boom/)
            expect(await leftovers(codexHome)).toEqual([])
            await ensureCodexHome(flaky, { codexHome, authFile, settings: {} })
            expect(await fs.readlink(link())).toBe(authFile)

            const denied = {
                ...fs,
                lstat: async () => {
                    throw Object.assign(new Error("denied"), {
                        code: "EACCES",
                    })
                },
            }
            await expect(
                ensureCodexHome(denied, { codexHome, authFile, settings: {} })
            ).rejects.toThrow(/denied/)
            const statDenied = {
                ...fs,
                stat: async () => {
                    throw Object.assign(new Error("nostat"), {
                        code: "EACCES",
                    })
                },
            }
            await fs.rm(link())
            await fs.writeFile(link(), "{}")
            await expect(
                ensureCodexHome(statDenied, {
                    codexHome,
                    authFile,
                    settings: {},
                })
            ).rejects.toThrow(/nostat/)
        })
    })

    test("codexConfigToml keeps scalar settings only, never mcp_servers", () => {
        const toml = codexConfigToml({
            model_reasoning_effort: "high",
            hide_agent_reasoning: true,
            n: 3,
            mcp_servers: "x",
            nested: { a: 1 },
            "bad key": "x",
            empty: null,
        })
        expect(toml).toMatch(/^model_reasoning_effort = "high"$/m)
        expect(toml).toMatch(/^hide_agent_reasoning = true$/m)
        expect(toml).toMatch(/^n = 3$/m)
        expect(toml).not.toMatch(/mcp_servers =|nested|bad key|empty/)
        expect(codexConfigToml()).toMatch(/^# Managed/)
        // tool-capable features are always disabled
        expect(toml).toMatch(/^\[features\]$/m)
        for (const feat of DISABLED_FEATURES)
            expect(toml.split("\n")).toContain(`${feat} = false`)
        expect(DISABLED_FEATURES).toEqual(
            expect.arrayContaining(["shell_tool", "apps", "plugins"])
        )
    })

    test("usage limit exit -> LimitError", async () => {
        const spawn = fakeSpawn((child) => {
            child.stderr.write(
                "ERROR: You've hit your usage limit. Upgrade or try again later."
            )
            child.finish(1)
        })
        await expect(
            mk({ spawn }).run({
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toMatchObject({ code: "provider_limit" })
    })

    test("other non-zero exit -> provider_failed", async () => {
        const spawn = fakeSpawn((child) => {
            child.stdout.write("something broke")
            child.finish(3)
        })
        await expect(
            mk({ spawn }).run({
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toThrow(/exited with code 3/)
    })

    test("missing output file -> provider_failed", async () => {
        const spawn = fakeSpawn((child) => child.finish(0))
        await expect(
            mk({ spawn }).run({
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toThrow(/no output file/)
    })

    test("non-JSON output -> provider_failed", async () => {
        const spawn = fakeSpawn(async (child, bin, args) => {
            await fs.writeFile(outFileOf(args), "hello")
            child.finish(0)
        })
        await expect(
            mk({ spawn }).run({
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toThrow(/not JSON/)
    })

    test("non-object output -> provider_failed", async () => {
        const spawn = fakeSpawn(async (child, bin, args) => {
            await fs.writeFile(outFileOf(args), "42")
            child.finish(0)
        })
        await expect(
            mk({ spawn }).run({
                prompt: "p",
                schema,
                model: "m",
            })
        ).rejects.toThrow(/not an object/)
    })

    test("timeout and abort", async () => {
        const clock = createFakeClock()
        const spawn = fakeSpawn(() => {})
        const run = mk({ spawn, clock }).run({
            prompt: "p",
            schema,
            model: "m",
            timeoutMs: 100,
        })
        await waitFor(() => spawn.calls.length === 1)
        await clock.advance(100)
        await expect(run).rejects.toThrow(/timed out/)

        const ac = new AbortController()
        const run2 = mk({ spawn }).run({
            prompt: "p",
            schema,
            model: "m",
            signal: ac.signal,
        })
        await waitFor(() => spawn.calls.length === 2)
        ac.abort()
        await expect(run2).rejects.toMatchObject({ code: "cancelled" })
        // temp dirs (schema/output) are removed even on abort/timeout
        expect(
            (await fs.readdir(tmpDir)).filter((n) => n.startsWith("cc-codex-"))
        ).toEqual([])

        const ac3 = new AbortController()
        ac3.abort()
        await expect(
            mk({ spawn }).run({
                signal: ac3.signal,
            })
        ).rejects.toMatchObject({ code: "cancelled" })
    })

    test("requires spawn, fs, tmpDir and codexHome", () => {
        expect(() => createCodexProvider({})).toThrow(/spawn/)
        expect(() => createCodexProvider({ spawn: () => {} })).toThrow(/tmpDir/)
        expect(() =>
            createCodexProvider({ spawn: () => {}, fs, tmpDir: "/x" })
        ).toThrow(/codexHome/)
    })
})
