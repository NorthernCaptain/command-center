/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { z } from "zod"
import { createBus } from "../events/bus.js"
import { createFakeClock } from "../util/clock.js"
import { AppError, LimitError, StaleRevisionError } from "../util/errors.js"
import { fromRow, createJobRunner, publicJob } from "./jobRunner.js"
import { createProviderRegistry } from "./providers/registry.js"
import { createLockManager } from "../store/mutex.js"
import {
    createFakeStore,
    createMemoryJobsRepo,
    createMemorySettingsRepo,
    fakeProvider,
    flush,
    makeTask,
    waitFor,
} from "./testing/fakes.js"

const waitForCalls = (provider, n) => waitFor(() => provider.calls.length >= n)
const flushAll = () => flush(10)

function mod(overrides = {}) {
    return {
        type: "t",
        lane: "interactive",
        weight: "light",
        lock: false,
        needsTask: false,
        outputSchema: z.object({ v: z.string() }),
        buildPrompt: () => ({ system: "S", prompt: "P" }),
        apply: async (ctx, out) => ({ summary: `got ${out.v}` }),
        ...overrides,
    }
}

function gate() {
    let open
    const p = new Promise((r) => (open = r))
    return { p, open }
}

function setup({
    modules = [mod()],
    handler = () => ({ v: "x" }),
    fallbackHandler = () => ({ v: "fb" }),
    settings = {},
    concurrency = { interactive: 2, background: 1 },
    jobsAsObject = false,
    pollMs = 0,
    maxParkMs,
    runnerOpts = {},
} = {}) {
    const clock = createFakeClock()
    const bus = createBus({ clock })
    const events = []
    bus.subscribe((e) => events.push(e))
    const jobsRepo = createMemoryJobsRepo()
    const settingsRepo = createMemorySettingsRepo(settings)
    const primary = fakeProvider("claude-sdk", handler)
    const fallback = fakeProvider("codex", fallbackHandler)
    const registry = createProviderRegistry({
        providers: [primary, fallback],
        settingsRepo,
    })
    const store = createFakeStore({ tasks: [makeTask({ id: 1 })], clock })
    const jobs = jobsAsObject
        ? Object.fromEntries(modules.map((m) => [m.type, m]))
        : new Map(modules.map((m) => [m.type, m]))
    const log = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }
    let n = 0
    const runner = createJobRunner({
        jobsRepo,
        store,
        bus,
        registry,
        jobs,
        clock,
        log,
        concurrency,
        timeoutMs: 1234,
        deps: { marker: true },
        pollMs,
        ...(maxParkMs ? { maxParkMs } : {}),
        idGen: () => `j${++n}`,
        ...runnerOpts,
    })
    const statuses = (id) =>
        events
            .filter((e) => e.type === "job.updated" && e.data.job.id === id)
            .map((e) => e.data.job.status)
    return {
        runner,
        jobsRepo,
        settingsRepo,
        store,
        bus,
        events,
        clock,
        primary,
        fallback,
        log,
        statuses,
    }
}

describe("job runner", () => {
    test("a job enqueued while holding the task lock waits for that lock", async () => {
        const applied = []
        const s = setup({
            modules: [
                mod({
                    lock: true,
                    needsTask: true,
                    apply: async () => {
                        applied.push("apply")
                        return { summary: "ok" }
                    },
                }),
            ],
        })
        const locks = createLockManager()
        s.store.withTaskLock = (id, fn) => locks.withLock(id, fn)
        s.store.outsideLocks = (fn) => locks.outside(fn)
        s.runner.start()
        const hold = gate()
        const parent = s.store.withTaskLock(1, async () => {
            s.runner.enqueue("t", {}, { task_id: 1 })
            await hold.p
            applied.push("parent done")
        })
        await waitForCalls(s.primary, 1)
        await flushAll()
        // the job is ready to apply but the parent still holds the lock
        expect(applied).toEqual([])
        hold.open()
        await parent
        await waitFor(() => applied.length === 2)
        expect(applied).toEqual(["parent done", "apply"])
        await s.runner.stop()
    })

    test("afterApply runs outside the task lock and its result wins", async () => {
        const seen = []
        const locks = createLockManager()
        const s = setup({
            modules: [
                mod({
                    lock: true,
                    needsTask: true,
                    apply: async (ctx, out, context) => {
                        context.fromApply = true
                        return { summary: "apply" }
                    },
                    afterApply: async (ctx, out, context) => {
                        seen.push(context.fromApply)
                        // another holder (no lock context of ours) can take
                        // the task lock now; inside the lock this would hang
                        await locks.outside(() =>
                            locks.withLock(1, async () => seen.push("lock"))
                        )
                        return { summary: "after" }
                    },
                }),
            ],
        })
        s.store.withTaskLock = (id, fn) => locks.withLock(id, fn)
        s.store.outsideLocks = (fn) => locks.outside(fn)
        s.runner.start()
        const job = s.runner.enqueue("t", {}, { task_id: 1 })
        await waitFor(() => s.runner.get(job.id)?.status === "done")
        expect(seen).toEqual([true, "lock"])
        expect(s.runner.get(job.id).summary).toBe("after")
        await s.runner.stop()
    })

    test("runs a job to done, persists and emits", async () => {
        const deltaMod = mod({
            buildPrompt: (ctx) => {
                expect(ctx.deps).toEqual({ marker: true })
                expect(ctx.actor).toBe("center")
                return {
                    system: "S",
                    prompt: "P",
                    mcpServers: { a: {} },
                    allowedTools: ["mcp__a__read"],
                }
            },
        })
        const s = setup({
            modules: [deltaMod],
            handler: (args) => {
                args.onDelta("chunk")
                return { v: "hello" }
            },
        })
        s.runner.start()
        const job = s.runner.enqueue("t", { q: 1 })
        expect(job).toMatchObject({
            id: "j1",
            status: "queued",
            lane: "interactive",
            task_id: null,
        })
        await s.runner.idle()
        const done = s.runner.get("j1")
        expect(done).toMatchObject({
            status: "done",
            summary: "got hello",
            provider: "claude-sdk",
            model: "claude-haiku-5-5",
            error: null,
        })
        expect(done.started_at).toBeTruthy()
        expect(done.ended_at).toBeTruthy()
        expect(s.statuses("j1")).toEqual(["queued", "running", "done"])
        const delta = s.events.find((e) => e.type === "job.delta")
        expect(delta.data).toEqual({ job_id: "j1", text: "chunk" })
        const call = s.primary.calls[0]
        expect(call).toMatchObject({
            system: "S",
            prompt: "P",
            timeoutMs: 1234,
            mcpServers: { a: {} },
            allowedTools: ["mcp__a__read"],
        })
        expect(call.schema).toEqual({
            type: "object",
            properties: { v: { type: "string" } },
            required: ["v"],
            additionalProperties: false,
        })
        const row = s.jobsRepo.rows.get("j1")
        expect(row.input).toEqual({ q: 1 })
        expect(row.output).toEqual({
            result: { v: "hello" },
            summary: "got hello",
        })
        expect(fromRow(row).output).toEqual({ v: "hello" })
        expect(s.runner.list({}).map((j) => j.id)).toEqual(["j1"])
        expect(s.runner.get("missing")).toBeNull()
    })

    test("unknown type and missing task_id fail immediately", () => {
        const s = setup({ modules: [mod({ type: "needs", needsTask: true })] })
        s.runner.start()
        expect(s.runner.enqueue("nope", {})).toMatchObject({
            status: "failed",
            error: "unknown job type: nope",
            lane: "background",
        })
        expect(s.runner.enqueue("needs")).toMatchObject({
            status: "failed",
            error: "needs requires a task_id",
        })
        expect(s.jobsRepo.rows.size).toBe(2)
    })

    test("concurrency limits and FIFO order", async () => {
        const gates = {}
        const started = []
        const pm = (type, lane) =>
            mod({
                type,
                lane,
                buildPrompt: (ctx) => ({ system: "S", prompt: ctx.input.name }),
            })
        const s = setup({
            modules: [pm("i", "interactive"), pm("b", "background")],
            concurrency: { interactive: 1, background: 1 },
            handler: async (args) => {
                started.push(args.prompt)
                const g = (gates[args.prompt] = gate())
                await g.p
                return { v: args.prompt }
            },
        })
        s.runner.start()
        s.runner.enqueue("i", { name: "i1" })
        s.runner.enqueue("i", { name: "i2" })
        s.runner.enqueue("b", { name: "b1" })
        s.runner.enqueue("i", { name: "i3" })
        await new Promise((r) => setImmediate(r))
        expect(started).toEqual(["i1", "b1"])
        expect(s.runner.stats()).toEqual({
            interactive: { running: 1, queued: 2 },
            background: { running: 1, queued: 0 },
        })
        gates.i1.open()
        await new Promise((r) => setImmediate(r))
        await new Promise((r) => setImmediate(r))
        expect(started).toEqual(["i1", "b1", "i2"])
        gates.i2.open()
        await new Promise((r) => setImmediate(r))
        await new Promise((r) => setImmediate(r))
        gates.i3.open()
        gates.b1.open()
        await s.runner.idle()
        expect(started).toEqual(["i1", "b1", "i2", "i3"])
    })

    test("invalid output fails with a clear error and calls onFailure", async () => {
        const onFailure = jest.fn()
        const s = setup({
            modules: [mod({ onFailure })],
            handler: () => ({ v: 3 }),
        })
        s.runner.start()
        s.runner.enqueue("t", {})
        await s.runner.idle()
        const job = s.runner.get("j1")
        expect(job.status).toBe("failed")
        expect(job.error).toMatch(
            /claude-sdk returned output that does not match the t schema/
        )
        expect(onFailure).toHaveBeenCalledWith(
            expect.objectContaining({ actor: "center" }),
            expect.objectContaining({ code: "invalid_output" }),
            { cancelled: false }
        )
    })

    test("provider failure -> failed; onFailure errors are swallowed", async () => {
        const s = setup({
            modules: [
                mod({
                    onFailure: () => {
                        throw new Error("hook broke")
                    },
                }),
            ],
            handler: () => {
                throw new AppError("provider_failed", "boom")
            },
        })
        s.runner.start()
        s.runner.enqueue("t", {})
        await s.runner.idle()
        expect(s.runner.get("j1")).toMatchObject({
            status: "failed",
            error: "boom",
        })
        expect(s.log.warn).toHaveBeenCalledWith(
            expect.anything(),
            "job onFailure hook failed"
        )
    })

    test("LimitError without auto_fallback fails", async () => {
        const s = setup({
            handler: () => {
                throw new LimitError("claude limit")
            },
        })
        s.runner.start()
        s.runner.enqueue("t", {})
        await s.runner.idle()
        expect(s.runner.get("j1")).toMatchObject({
            status: "failed",
            error: "claude limit",
        })
        expect(s.fallback.calls).toHaveLength(0)
    })

    test("LimitError with auto_fallback retries once on the fallback", async () => {
        const s = setup({
            settings: { "center.auto_fallback": true },
            handler: () => {
                throw new LimitError("claude limit")
            },
        })
        s.runner.start()
        s.runner.enqueue("t", {})
        await s.runner.idle()
        const job = s.runner.get("j1")
        expect(job).toMatchObject({
            status: "done",
            provider: "codex",
            model: "gpt-6-luna",
            fallback_from: "claude-sdk",
            summary: "got fb",
        })
        expect(s.jobsRepo.rows.get("j1").usage.fallback_from).toBe("claude-sdk")
    })

    test("fallback failure reports both errors", async () => {
        const s = setup({
            settings: { "center.auto_fallback": true },
            handler: () => {
                throw new LimitError("claude limit")
            },
            fallbackHandler: () => {
                throw new Error("codex down")
            },
        })
        s.runner.start()
        s.runner.enqueue("t", {})
        await s.runner.idle()
        expect(s.runner.get("j1").error).toBe(
            "claude limit; fallback codex failed: codex down"
        )
    })

    test("lock wraps apply only and stale revision retries once", async () => {
        const attempts = []
        const s = setup({
            modules: [
                mod({
                    lock: true,
                    needsTask: true,
                    apply: async (ctx) => {
                        attempts.push(ctx.attempt)
                        if (ctx.attempt === 1) throw new StaleRevisionError({})
                        return { summary: "ok" }
                    },
                }),
            ],
        })
        s.runner.start()
        s.runner.enqueue("t", {}, { task_id: 1 })
        await s.runner.idle()
        expect(attempts).toEqual([1, 2])
        expect(s.runner.get("j1").status).toBe("done")
        expect(s.store.calls.filter((c) => c[0] === "lock")).toEqual([
            ["lock", 1],
        ])
    })

    test("stale twice fails", async () => {
        const s = setup({
            modules: [
                mod({
                    apply: async () => {
                        throw new StaleRevisionError({})
                    },
                }),
            ],
        })
        s.runner.start()
        s.runner.enqueue("t", {})
        await s.runner.idle()
        expect(s.runner.get("j1")).toMatchObject({ status: "failed" })
        expect(s.runner.get("j1").error).toMatch(/base_revision/)
    })

    test("cancel queued, running, parked, done and unknown jobs", async () => {
        const g = gate()
        const onFailure = jest.fn()
        const s = setup({
            modules: [
                mod({ onFailure }),
                mod({
                    type: "p",
                    prepare: async () => ({ park: { kind: "x", ref: "r" } }),
                    resume: async () => ({}),
                }),
            ],
            concurrency: { interactive: 1, background: 1 },
            handler: async (args) => {
                await new Promise((resolve, reject) => {
                    args.signal.addEventListener("abort", () =>
                        reject(new AppError("cancelled", "aborted"))
                    )
                    g.p.then(resolve)
                })
                return { v: "x" }
            },
        })
        s.runner.start()
        s.runner.enqueue("t", {}) // j1 running
        s.runner.enqueue("t", {}) // j2 queued
        await new Promise((r) => setImmediate(r))
        expect(s.runner.cancel("j2")).toBe(true)
        expect(s.runner.get("j2").status).toBe("cancelled")
        expect(s.runner.cancel("j2")).toBe(false)
        expect(s.runner.cancel("j1")).toBe(true)
        await s.runner.idle()
        expect(s.runner.get("j1").status).toBe("cancelled")
        expect(s.statuses("j1")).toEqual(["queued", "running", "cancelled"])
        expect(onFailure).toHaveBeenCalledWith(expect.anything(), null, {
            cancelled: true,
        })

        s.runner.enqueue("p", {}) // j3 parks
        await s.runner.idle()
        expect(s.runner.get("j3").status).toBe("parked")
        expect(s.runner.cancel("j3")).toBe(true)
        expect(s.runner.get("j3").status).toBe("cancelled")
        expect(s.runner.cancel("nope")).toBe(false)
    })

    test("cancel during apply is refused", async () => {
        const g = gate()
        let runner
        const s = setup({
            modules: [
                mod({
                    apply: async () => {
                        expect(runner.cancel("j1")).toBe(false)
                        await g.p
                        return { summary: "applied" }
                    },
                }),
            ],
        })
        runner = s.runner
        s.runner.start()
        s.runner.enqueue("t", {})
        await new Promise((r) => setImmediate(r))
        g.open()
        await s.runner.idle()
        expect(s.runner.get("j1").status).toBe("done")
    })

    test("cancel a job while prepare runs: failure hook runs after prepare", async () => {
        const g = gate()
        const order = []
        const s = setup({
            modules: [
                mod({
                    prepare: async () => {
                        await g.p
                        order.push("prepare done (comment working)")
                        return { context: {} }
                    },
                    onFailure: async (ctx, err, opts) => {
                        order.push(`onFailure ${JSON.stringify(opts)}`)
                    },
                }),
            ],
        })
        s.runner.start()
        s.runner.enqueue("t", {})
        await new Promise((r) => setImmediate(r))
        expect(s.runner.cancel("j1")).toBe(true)
        // not yet: prepare is still running
        expect(order).toEqual([])
        g.open()
        await s.runner.idle()
        expect(s.runner.get("j1").status).toBe("cancelled")
        expect(s.primary.calls).toHaveLength(0)
        expect(order).toEqual([
            "prepare done (comment working)",
            'onFailure {"cancelled":true}',
        ])
    })

    test("park, poll, re-park quietly, resume and finish", async () => {
        let ready = false
        const resume = jest.fn(async (ctx, park) => {
            expect(park).toMatchObject({
                kind: "brain",
                ref: "b1",
                expired: false,
            })
            return ready
                ? { context: { from: "resume" } }
                : { park: { kind: "brain", ref: "b1" } }
        })
        const s = setup({
            modules: [
                mod({
                    lane: "background",
                    prepare: async () => ({
                        park: { kind: "brain", ref: "b1" },
                    }),
                    resume,
                    buildPrompt: (ctx, context) => ({
                        system: "S",
                        prompt: context.from,
                    }),
                }),
            ],
        })
        s.runner.start()
        s.runner.enqueue("t", {})
        await s.runner.idle()
        expect(s.runner.get("j1").status).toBe("parked")
        const parkedAt = s.jobsRepo.rows.get("j1").park.parked_at
        expect(parkedAt).toBe("2026-11-07T12:00:00.000Z")
        expect(s.runner.poll()).toBe(1)
        await s.runner.idle()
        expect(resume).toHaveBeenCalledTimes(1)
        expect(s.statuses("j1")).toEqual(["queued", "running", "parked"])
        await s.clock.advance(60000)
        ready = true
        expect(s.runner.poll()).toBe(1)
        await s.runner.idle()
        expect(s.runner.get("j1").status).toBe("done")
        expect(s.primary.calls[0].prompt).toBe("resume")
        expect(s.statuses("j1")).toEqual([
            "queued",
            "running",
            "parked",
            "running",
            "done",
        ])
        expect(s.jobsRepo.rows.get("j1").park.parked_at).toBe(parkedAt)
    })

    test("poll skips parked jobs with a future until", async () => {
        const s = setup({
            modules: [
                mod({
                    prepare: async () => ({
                        park: {
                            kind: "wait",
                            ref: "x",
                            until: "2026-11-07T13:00:00.000Z",
                        },
                    }),
                    resume: async () => ({ context: {} }),
                }),
            ],
        })
        s.runner.start()
        s.runner.enqueue("t", {})
        await s.runner.idle()
        expect(s.runner.poll()).toBe(0)
        s.clock.set("2026-11-07T13:00:01.000Z")
        expect(s.runner.poll()).toBe(1)
        await s.runner.idle()
        expect(s.runner.get("j1").status).toBe("done")
    })

    test("expired park: resume sees expired; parking again fails", async () => {
        const seen = []
        const s = setup({
            maxParkMs: 1000,
            modules: [
                mod({
                    prepare: async () => ({
                        park: { kind: "brain", ref: "r" },
                    }),
                    resume: async (ctx, park) => {
                        seen.push(park.expired)
                        return { park: { kind: "brain", ref: "r" } }
                    },
                }),
            ],
        })
        s.runner.start()
        s.runner.enqueue("t", {})
        await s.runner.idle()
        await s.clock.advance(2000)
        s.runner.poll()
        await s.runner.idle()
        expect(seen).toEqual([true])
        expect(s.runner.get("j1")).toMatchObject({
            status: "failed",
            error: "timed out waiting for brain",
        })
    })

    test("module without resume fails when polled", async () => {
        const s = setup({
            modules: [
                mod({
                    prepare: async () => ({ park: { kind: "k", ref: "r" } }),
                }),
            ],
        })
        s.runner.start()
        s.runner.enqueue("t", {})
        await s.runner.idle()
        s.runner.poll()
        await s.runner.idle()
        expect(s.runner.get("j1")).toMatchObject({
            status: "failed",
            error: "t cannot resume",
        })
    })

    test("start(): interrupts stale running, resumes queued in order, polls on a timer", async () => {
        const onFailure = jest.fn()
        const prompts = []
        const s = setup({
            jobsAsObject: true,
            pollMs: 1000,
            concurrency: { interactive: 1, background: 1 },
            modules: [
                mod({
                    onFailure,
                    buildPrompt: (ctx) => ({
                        system: "S",
                        prompt: ctx.input.n,
                    }),
                    resume: async () => ({ context: {} }),
                }),
            ],
            handler: (args) => {
                prompts.push(args.prompt)
                return { v: "x" }
            },
        })
        const base = {
            type: "t",
            lane: "interactive",
            task_id: null,
            provider: null,
            model: null,
            output_json: null,
            park_json: null,
            error: null,
            usage_json: null,
            started_at: null,
            ended_at: null,
        }
        s.jobsRepo.insert({
            ...base,
            id: "r1",
            status: "running",
            input_json: "{}",
            created_at: "2026-11-07T11:00:00.000Z",
        })
        s.jobsRepo.insert({
            ...base,
            id: "q2",
            status: "queued",
            input_json: '{"n":"second"}',
            created_at: "2026-11-07T11:02:00.000Z",
        })
        s.jobsRepo.insert({
            ...base,
            id: "q1",
            status: "queued",
            input_json: '{"n":"first"}',
            created_at: "2026-11-07T11:01:00.000Z",
        })
        s.jobsRepo.insert({
            ...base,
            id: "p1",
            status: "parked",
            input_json: '{"n":"parked"}',
            park_json: JSON.stringify({
                kind: "k",
                ref: "r",
                until: "2026-11-07T12:00:00.500Z",
                parked_at: "2026-11-07T11:59:00.000Z",
            }),
            created_at: "2026-11-07T11:03:00.000Z",
        })
        s.runner.start()
        s.runner.start() // idempotent
        await s.runner.idle()
        expect(s.runner.get("r1")).toMatchObject({
            status: "failed",
            error: "interrupted (service restarted)",
        })
        expect(onFailure).toHaveBeenCalledTimes(1)
        expect(prompts).toEqual(["first", "second"])
        expect(s.runner.get("p1").status).toBe("parked")
        await s.clock.advance(1000)
        await s.runner.idle()
        expect(prompts).toEqual(["first", "second", "parked"])
        expect(s.runner.get("p1").status).toBe("done")
        s.runner.stop()
        expect(s.clock.pending()).toBe(0)
        expect(s.runner.poll()).toBe(0)
    })

    test("enqueue before start waits for start; stop halts pumping", async () => {
        const s = setup()
        s.runner.enqueue("t", {})
        await new Promise((r) => setImmediate(r))
        expect(s.runner.get("j1").status).toBe("queued")
        s.runner.start()
        await s.runner.idle()
        expect(s.runner.get("j1").status).toBe("done")
        s.runner.stop()
        s.runner.enqueue("t", {})
        await s.runner.idle()
        expect(s.runner.get("j2").status).toBe("queued")
    })

    describe("stop()", () => {
        /** Provider handler that only ends when its signal aborts. */
        const untilAborted = ({ signal }) =>
            new Promise((resolve, reject) => {
                signal.addEventListener("abort", () =>
                    reject(new AppError("cancelled", "aborted"))
                )
            })

        test("aborts running jobs, waits for them, leaves queued jobs queued", async () => {
            const onFailure = jest.fn()
            const s = setup({
                modules: [mod({ onFailure })],
                handler: untilAborted,
                concurrency: { interactive: 1, background: 1 },
            })
            s.runner.start()
            s.runner.enqueue("t", {})
            s.runner.enqueue("t", {})
            await waitForCalls(s.primary, 1)
            const res = await s.runner.stop()
            expect(res).toEqual({ idle: true, aborted: 1, killed: 0 })
            expect(s.runner.get("j1")).toMatchObject({
                status: "failed",
                error: "interrupted (service stopped)",
            })
            expect(onFailure).toHaveBeenCalledTimes(1)
            expect(onFailure.mock.calls[0][1].message).toBe(
                "interrupted (service stopped)"
            )
            expect(s.runner.get("j2").status).toBe("queued")
            expect(s.primary.calls).toHaveLength(1)
        })

        test("nothing running: resolves at once", async () => {
            const killChildren = jest.fn()
            const s = setup({ runnerOpts: { killChildren } })
            s.runner.start()
            expect(await s.runner.stop()).toEqual({
                idle: true,
                aborted: 0,
                killed: 0,
            })
            expect(killChildren).not.toHaveBeenCalled()
        })

        test("after the cap, kills child groups and waits a little more", async () => {
            const g = gate()
            const killChildren = jest.fn(() => {
                g.open()
                return 2
            })
            const s = setup({
                handler: async () => {
                    await g.p // ignores abort until its child is killed
                    throw new AppError("cancelled", "killed")
                },
                runnerOpts: { stopTimeoutMs: 500, killChildren },
            })
            s.runner.start()
            s.runner.enqueue("t", {})
            await waitForCalls(s.primary, 1)
            const stopping = s.runner.stop()
            await flushAll()
            expect(killChildren).not.toHaveBeenCalled()
            await s.clock.advance(500)
            expect(killChildren).toHaveBeenCalledWith("SIGKILL")
            expect(await stopping).toEqual({
                idle: true,
                aborted: 1,
                killed: 2,
            })
            expect(s.runner.get("j1").status).toBe("failed")
            expect(s.log.warn).toHaveBeenCalledWith(
                expect.objectContaining({ killed: 2 }),
                expect.stringMatching(/stop timeout/)
            )
        })

        test("a job that never ends: stop still returns (idle: false)", async () => {
            const g = gate()
            const s = setup({
                handler: () => g.p,
                runnerOpts: {
                    stopTimeoutMs: 300,
                    killChildren: () => {
                        throw new Error("no kill")
                    },
                },
            })
            s.runner.start()
            s.runner.enqueue("t", {})
            await waitForCalls(s.primary, 1)
            const stopping = s.runner.stop({ timeoutMs: 100 })
            await flushAll()
            await s.clock.advance(100)
            await flushAll()
            await s.clock.advance(100)
            expect(await stopping).toEqual({
                idle: false,
                aborted: 1,
                killed: 0,
            })
            expect(s.log.error).toHaveBeenCalledWith(
                expect.anything(),
                "killing center job children failed"
            )
            g.open({ v: "late" })
            await s.runner.idle()
        })

        test("jobs in their apply phase are not aborted", async () => {
            const g = gate()
            let applySignal
            const s = setup({
                modules: [
                    mod({
                        apply: async (ctx, out) => {
                            applySignal = ctx.signal
                            await g.p
                            return { summary: out.v }
                        },
                    }),
                ],
            })
            s.runner.start()
            s.runner.enqueue("t", {})
            await waitFor(() => applySignal)
            const stopping = s.runner.stop()
            g.open()
            expect(await stopping).toEqual({
                idle: true,
                aborted: 0,
                killed: 0,
            })
            expect(applySignal.aborted).toBe(false)
            expect(s.runner.get("j1").status).toBe("done")
        })
    })

    test("poll errors in timer are logged", async () => {
        const s = setup({ pollMs: 10 })
        s.jobsRepo.listByStatus = (st) => {
            if (st.includes("parked") && s.started) throw new Error("db gone")
            return []
        }
        s.runner.start()
        s.started = true
        await s.clock.advance(10)
        expect(s.log.error).toHaveBeenCalledWith(
            expect.anything(),
            "job poll failed"
        )
        s.runner.stop()
    })

    test("fromRow / publicJob accept parsed objects and legacy shapes", () => {
        const job = fromRow({
            id: "x",
            type: "t",
            lane: "background",
            status: "done",
            input: { a: 1 },
            output: { raw: true },
            summary: "s",
            usage: { fallback_from: "claude-sdk" },
            park_json: "not json",
            created_at: "c",
        })
        expect(job).toMatchObject({
            input: { a: 1 },
            output: { raw: true },
            summary: "s",
            park: null,
            fallback_from: "claude-sdk",
            task_id: null,
        })
        expect(publicJob(job)).not.toHaveProperty("input")
        expect(publicJob(job)).not.toHaveProperty("comment_id")
        // an assist job names the comment thread it answers, nothing more
        const assist = publicJob({
            ...job,
            input: { comment_id: "c_1", message: "hi" },
        })
        expect(assist.comment_id).toBe("c_1")
        expect(assist).not.toHaveProperty("input")
        expect(fromRow({ id: "y", status: "queued" }).input).toEqual({})
    })

    test("long error messages are truncated", async () => {
        const s = setup({
            handler: () => {
                throw new Error("e".repeat(3000))
            },
        })
        s.runner.start()
        s.runner.enqueue("t", {})
        await s.runner.idle()
        expect(s.runner.get("j1").error.length).toBe(2001)
    })
})
