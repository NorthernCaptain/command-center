/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { spawn as nodeSpawn } from "node:child_process"
import { fakeSpawn, waitFor } from "../testing/fakes.js"
import {
    deltaText,
    killAll,
    liveProcessCount,
    looksLikeLimit,
    runProcess,
    safeDelta,
    tail,
} from "./common.js"

describe("provider common helpers", () => {
    test("looksLikeLimit", () => {
        expect(looksLikeLimit("Rate limit exceeded")).toBe(true)
        expect(looksLikeLimit("insufficient_quota")).toBe(true)
        expect(looksLikeLimit("HTTP 429 Too Many Requests")).toBe(true)
        expect(looksLikeLimit("You've hit your usage limit")).toBe(true)
        expect(looksLikeLimit("syntax error")).toBe(false)
        expect(looksLikeLimit(null)).toBe(false)
    })

    test("deltaText", () => {
        expect(deltaText(null)).toBeNull()
        expect(deltaText({ type: "message_start" })).toBeNull()
        expect(
            deltaText({
                type: "content_block_delta",
                delta: { type: "thinking_delta" },
            })
        ).toBeNull()
        expect(
            deltaText({
                type: "content_block_delta",
                delta: { type: "text_delta", text: "" },
            })
        ).toBeNull()
    })

    test("safeDelta swallows listener errors", () => {
        expect(() =>
            safeDelta(() => {
                throw new Error("x")
            }, "t")
        ).not.toThrow()
        safeDelta(null, "t")
    })

    test("tail", () => {
        expect(tail("abc")).toBe("abc")
        expect(tail("x".repeat(10), 3)).toBe("…xxx")
        expect(tail(undefined)).toBe("")
    })

    test("runProcess caps output and handles stdin errors", async () => {
        const spawn = fakeSpawn((child) => {
            child.stdout.write("0123456789")
            child.stdout.write("more")
            child.stderr.write("e1")
            child.stderr.write("e2")
            child.stdin.emit("error", new Error("EPIPE"))
            child.finish(0)
        })
        const res = await runProcess({
            spawn,
            bin: "x",
            args: [],
            stdin: "in",
            maxBytes: 5,
        })
        expect(res.stdout).toBe("0123456789")
        expect(res.stderr).toBe("e1e2")
        expect(res.code).toBe(0)
    })

    test("runProcess joins UTF-8 characters split across chunks", async () => {
        const out = Buffer.from('{"reply":"café"}\n', "utf8")
        const cut = out.indexOf(0xc3) + 1 // between the two bytes of "é"
        const err = Buffer.from("naïve", "utf8")
        const ecut = err.indexOf(0xc3) + 1
        const spawn = fakeSpawn((child) => {
            child.stdout.write(out.subarray(0, cut))
            child.stdout.write(out.subarray(cut))
            child.stderr.write(err.subarray(0, ecut))
            child.stderr.write(err.subarray(ecut))
            child.finish(0)
        })
        const lines = []
        const res = await runProcess({
            spawn,
            bin: "x",
            args: [],
            onLine: (l) => lines.push(l),
        })
        expect(res.stdout).toBe('{"reply":"café"}\n')
        expect(lines).toEqual(['{"reply":"café"}'])
        expect(res.stderr).toBe("naïve")
    })

    test("runProcess with already aborted signal kills immediately", async () => {
        const spawn = fakeSpawn(() => {})
        const ac = new AbortController()
        ac.abort()
        const res = await runProcess({
            spawn,
            bin: "x",
            args: [],
            signal: ac.signal,
        })
        expect(res.aborted).toBe(true)
    })

    test("runProcess ignores kill errors", async () => {
        const spawn = fakeSpawn((child) => {
            child.kill = () => {
                throw new Error("ESRCH")
            }
            child.finish(0)
        })
        const ac = new AbortController()
        const p = runProcess({ spawn, bin: "x", args: [], signal: ac.signal })
        await new Promise((r) => setImmediate(r))
        ac.abort()
        const res = await p
        expect(res.aborted).toBe(true)
    })

    test("runProcess force-settles when the child never dies", async () => {
        const spawn = fakeSpawn((child) => {
            child.kill = () => {} // ignores every signal
        })
        const res = await runProcess({
            spawn,
            bin: "x",
            args: [],
            timeoutMs: 20,
            killGraceMs: 30,
        })
        expect(res).toMatchObject({ timedOut: true, forced: true })
    })

    test("runProcess falls back to child.kill when the group kill fails", async () => {
        const spawn = fakeSpawn((child) => {
            child.pid = 999999
        })
        const killed = []
        const res = await runProcess({
            spawn,
            bin: "x",
            args: [],
            timeoutMs: 10,
            killProcess: (pid, sig) => {
                killed.push([pid, sig])
                throw new Error("ESRCH")
            },
        })
        expect(killed[0]).toEqual([-999999, "SIGTERM"])
        expect(res.timedOut).toBe(true)
        expect(spawn.calls[0].child.killed).toBe("SIGTERM")
    })

    test("killAll signals every live child group (registry tracks running children)", async () => {
        const killed = []
        const killProcess = (pid, sig) => {
            killed.push([pid, sig])
            if (sig === "SIGKILL") {
                const c = spawn.calls.find((x) => x.child.pid === -pid)
                setImmediate(() => c.child.emit("close", null, sig))
            }
        }
        let next = 4242
        const spawn = (bin, args, opts) => {
            const child = fakeSpawn(() => {})(bin, args, opts)
            child.pid = next++
            spawn.calls.push({ child })
            return child
        }
        spawn.calls = []
        const before = liveProcessCount()
        const runs = [1, 2].map(() =>
            runProcess({ spawn, bin: "x", args: [], killProcess })
        )
        expect(liveProcessCount()).toBe(before + 2)
        expect(killAll()).toBe(before + 2)
        const res = await Promise.all(runs)
        expect(res.map((r) => r.signal)).toEqual(["SIGKILL", "SIGKILL"])
        expect(killed).toEqual(
            expect.arrayContaining([
                [-4242, "SIGKILL"],
                [-4243, "SIGKILL"],
            ])
        )
        // settled children leave the registry
        expect(liveProcessCount()).toBe(before)
        expect(killAll("SIGTERM")).toBe(before)
    })
})

// Real tiny child processes (node -e ...): process-group kill, SIGKILL
// escalation and settling on 'exit' when a grandchild holds the pipes.
describe("runProcess with real processes", () => {
    const node = process.execPath
    const alive = (pid) => {
        try {
            process.kill(pid, 0)
            return true
        } catch {
            return false
        }
    }
    const firstLine = () => {
        let resolveLine
        const p = new Promise((r) => (resolveLine = r))
        return { p, onLine: (l) => resolveLine(l) }
    }

    test("a SIGTERM-ignoring child is SIGKILLed after the grace period", async () => {
        const start = Date.now()
        const res = await runProcess({
            spawn: nodeSpawn,
            bin: node,
            args: [
                "-e",
                "process.on('SIGTERM',()=>{});console.log('up');setInterval(()=>{},1000)",
            ],
            timeoutMs: 300,
            killGraceMs: 300,
            drainMs: 100,
        })
        expect(res.timedOut).toBe(true)
        expect(Date.now() - start).toBeLessThan(4000)
    }, 10000)

    test("abort kills grandchildren holding the pipes (sh -c 'sleep & wait')", async () => {
        const ac = new AbortController()
        const { p, onLine } = firstLine()
        const run = runProcess({
            spawn: nodeSpawn,
            bin: node,
            args: [
                "-e",
                "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log(c.pid);setInterval(()=>{},1000)",
            ],
            signal: ac.signal,
            killGraceMs: 2000,
            onLine,
        })
        const grandchild = Number(await p)
        expect(alive(grandchild)).toBe(true)
        ac.abort()
        const res = await run
        expect(res.aborted).toBe(true)
        await waitFor(() => !alive(grandchild))
    }, 10000)

    // The direct child exits right away (unref), its child keeps stdout open.
    test("settles on exit + drain when a straggler keeps stdout open", async () => {
        const { p, onLine } = firstLine()
        const res = await runProcess({
            spawn: nodeSpawn,
            bin: node,
            args: [
                "-e",
                "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});c.unref();console.log(c.pid)",
            ],
            drainMs: 100,
            onLine,
        })
        const straggler = Number(await p)
        expect(res).toMatchObject({ code: 0, forced: true })
        expect(res.stdout.trim()).toBe(String(straggler))
        await waitFor(() => !alive(straggler))
    }, 10000)

    test("killAll reaches a running real child (detached group)", async () => {
        const { p, onLine } = firstLine()
        const run = runProcess({
            spawn: nodeSpawn,
            bin: node,
            args: ["-e", "console.log(process.pid);setInterval(()=>{},1000)"],
            onLine,
        })
        const pid = Number(await p)
        expect(alive(pid)).toBe(true)
        expect(killAll("SIGKILL")).toBeGreaterThanOrEqual(1)
        const res = await run
        expect(res.signal).toBe("SIGKILL")
        await waitFor(() => !alive(pid))
        expect(liveProcessCount()).toBe(0)
    }, 10000)

    test("normal exit settles with code and output", async () => {
        const res = await runProcess({
            spawn: nodeSpawn,
            bin: node,
            args: ["-e", "process.stdin.pipe(process.stdout)"],
            stdin: "hello",
        })
        expect(res).toMatchObject({ code: 0, stdout: "hello", forced: false })
    }, 10000)
})
