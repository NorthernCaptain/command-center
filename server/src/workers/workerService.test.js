/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { EventEmitter } from "node:events"
import { jest } from "@jest/globals"
import { canTransition } from "../contracts/lifecycle.js"
import { createFakeClock } from "../util/clock.js"
import { AppError, NotFoundError } from "../util/errors.js"
import { openDb } from "../store/db.js"
import { createOutboxRepo } from "../herdr/outboxRepo.js"
import {
    BLOCKED_REASON,
    CLEAN_LEFT_REASON,
    createWorkerService,
    parseCloseAfter,
    isServerError,
    isTransportError,
    START_FAILED_REASON,
    UNAVAILABLE_REASON,
    UNCERTAIN_REASON,
} from "./workerService.js"

// ---- fakes (follow phase2-contracts.md A) ----------------------------------

function herdrErr(code, { server = true } = {}) {
    const e = new AppError(code, `herdr ${code}`, {
        status: 502,
        details: server ? { code, message: code } : undefined,
    })
    return e
}

function makeTask(id, over = {}) {
    return {
        id,
        title: `Fix upload retry ${id}`,
        kind: "agent_task",
        area: "backend",
        status: "ready",
        repos: [{ name: "aws-lambda", role: "main" }],
        branch: null,
        slug: null,
        deliverables: [],
        asana: { gid: null },
        wants_asana: false,
        worker_kind: null,
        flags: { enriching: false, now: false, now_reason: null, error: null },
        ...over,
    }
}

function fakeStore() {
    const tasks = new Map()
    const events = []
    const feedback = new Map()
    const store = {
        tasks,
        events,
        feedback,
        seed(t) {
            tasks.set(t.id, structuredClone(t))
            return t
        },
        task: (id) => tasks.get(id),
        async getTask(id) {
            const t = tasks.get(Number(id))
            if (!t) throw new NotFoundError("task")
            return { task: structuredClone(t), revision: "r" }
        },
        updateTask: jest.fn(async (id, patch) => {
            const prev = tasks.get(Number(id))
            if (!prev) throw new NotFoundError("task")
            const next = { ...prev }
            for (const [k, v] of Object.entries(patch)) {
                const plain = (x) =>
                    x && typeof x === "object" && !Array.isArray(x)
                next[k] = plain(v) && plain(prev[k]) ? { ...prev[k], ...v } : v
            }
            if (!canTransition(prev.status, next.status))
                throw new AppError("illegal_transition", "nope", {
                    status: 409,
                })
            tasks.set(Number(id), next)
            return { task: structuredClone(next), revision: "r2" }
        }),
        async withTaskLock(id, fn) {
            return fn()
        },
        async appendEvent(id, ev, actor) {
            events.push({ task_id: id, ...ev, actor })
            return ev
        },
        async listFeedback(id) {
            return feedback.get(id) || []
        },
        async getArtifact() {
            return { content: "# artifact body", revision: "a1" }
        },
        eventTypes: () => events.map((e) => e.type),
    }
    return store
}

function fakeSessions(clock) {
    const rows = []
    let seq = 0
    const now = () => clock.now().toISOString()
    const copy = (r) => (r ? { ...r } : null)
    return {
        rows,
        create(input) {
            for (const r of rows)
                if (r.task_id === input.task_id && !r.ended_at) {
                    r.ended_at = now()
                    r.state = "replaced"
                }
            const row = {
                id: ++seq,
                session_id: null,
                ...input,
                started_at: now(),
                last_seen_at: now(),
                ended_at: null,
            }
            rows.push(row)
            return copy(row)
        },
        current(taskId) {
            return copy(
                rows.filter((r) => r.task_id === taskId && !r.ended_at).pop()
            )
        },
        byPane(paneId) {
            return copy(rows.find((r) => r.pane_id === paneId && !r.ended_at))
        },
        live() {
            return rows.filter((r) => !r.ended_at).map(copy)
        },
        update(id, patch) {
            const r = rows.find((x) => x.id === id)
            Object.assign(r, patch, { last_seen_at: now() })
            return copy(r)
        },
        end(id, state = "gone") {
            const r = rows.find((x) => x.id === id)
            if (!r.ended_at) Object.assign(r, { state, ended_at: now() })
            return copy(r)
        },
        history(taskId) {
            return rows.filter((r) => r.task_id === taskId).map(copy)
        },
    }
}

function fakeOutbox() {
    const rows = []
    let seq = 0
    const copy = (r) => (r ? { ...r } : null)
    const ob = {
        rows,
        enqueue({ task_id, text, reason, dedupe_key = null }) {
            if (dedupe_key !== null) {
                const ex = rows.find(
                    (r) => r.task_id === task_id && r.dedupe_key === dedupe_key
                )
                if (ex) return copy(ex)
            }
            const row = {
                id: ++seq,
                task_id,
                text,
                reason,
                dedupe_key,
                status: "pending",
                error: null,
            }
            rows.push(row)
            return copy(row)
        },
        pending(taskId) {
            return rows
                .filter(
                    (r) =>
                        r.status === "pending" &&
                        (taskId === undefined || r.task_id === taskId)
                )
                .map(copy)
        },
        markSent(id) {
            const r = rows.find((x) => x.id === id)
            if (r.status === "pending") r.status = "sent"
        },
        markFailed(id, error) {
            const r = rows.find((x) => x.id === id)
            if (r.status === "pending")
                Object.assign(r, { status: "failed", error })
        },
        cancel(id) {
            const r = rows.find((x) => x.id === id)
            if (r && r.status === "pending") {
                r.status = "cancelled"
                return true
            }
            return false
        },
        requeue(id) {
            const r = rows.find((x) => x.id === id)
            if (r.status === "failed")
                Object.assign(r, { status: "pending", error: null })
            return copy(r)
        },
        list(taskId, { limit = 50 } = {}) {
            return rows
                .filter((r) => r.task_id === taskId)
                .reverse()
                .slice(0, limit)
                .map(copy)
        },
        failed(taskId) {
            return rows
                .filter((r) => r.task_id === taskId && r.status === "failed")
                .map(copy)
        },
        byId(id) {
            const r = rows.find((x) => x.id === Number(id))
            return r ? copy(r) : null
        },
    }
    return ob
}

function fakeHerdr() {
    const agents = new Map()
    let n = 0
    const h = {
        agents,
        workspaceCreate: jest.fn(async () => {
            n++
            return { workspaceId: `w${n}`, tabId: `t${n}`, paneId: `p${n}` }
        }),
        agentStart: jest.fn(async ({ name, kind, paneId }) => {
            agents.set(name, {
                name,
                kind,
                status: "idle",
                sessionId: `sess-${name}-${paneId}`,
                paneId,
                workspaceId: `w${paneId.slice(1)}`,
            })
        }),
        agentPrompt: jest.fn(async () => ({})),
        // by name or by pane id, like herdr
        agentGet: jest.fn(
            async (target) =>
                agents.get(target) ??
                [...agents.values()].find((a) => a.paneId === target) ??
                null
        ),
        workspaceClose: jest.fn(async () => ({})),
        agentList: jest.fn(async () => [...agents.values()]),
        agentFocus: jest.fn(async () => {}),
        agentRead: jest.fn(async () => ""),
        reportMetadata: jest.fn(async () => {}),
        setStatus(name, status) {
            agents.get(name).status = status
        },
    }
    return h
}

function fakeEvents() {
    const ev = new EventEmitter()
    ev.track = jest.fn()
    ev.start = jest.fn()
    ev.stop = jest.fn()
    return ev
}

function setup(over = {}) {
    const clock = createFakeClock()
    const store = fakeStore()
    const sessions = fakeSessions(clock)
    const outbox = fakeOutbox()
    const herdr = fakeHerdr()
    const events = fakeEvents()
    const bus = { emit: jest.fn() }
    const notifier = { notify: jest.fn(async () => {}) }
    const jobRunner = {
        enqueue: jest.fn(() => ({ id: 1, type: "asana_create" })),
        list: jest.fn(() => []),
    }
    const settingsRepo = { get: jest.fn(() => null) }
    const identity = {
        newSlug: jest.fn(async () => "k7q2"),
        checkBranch: jest.fn(async () => ({ ok: true })),
        scanFolders: jest.fn(() => []),
    }
    const config = {
        treeDir: "/tree",
        listeners: { local: { port: 7788 } },
        herdr: { startTimeoutMs: 60000, promptTimeoutMs: 120000, pollMs: 10 },
    }
    const deps = {
        store,
        herdr,
        events,
        sessions,
        outbox,
        identity,
        settingsRepo,
        jobRunner,
        notifier,
        bus,
        config,
        clock,
        localToken: "tok",
        // exact herdr args below; the MCP flags have their own tests
        mcpHeadersHelper: false,
        ...over,
    }
    const svc = createWorkerService(deps)
    return { ...deps, svc }
}

const NAME = "t1-fix-upload-retry-1"

async function started(env, taskOver = {}) {
    env.store.seed(makeTask(1, taskOver))
    const r = await env.svc.startTask(1)
    return r
}

// ---- tests -------------------------------------------------------------------

describe("error classification", () => {
    test("server vs transport", () => {
        expect(isServerError(herdrErr("timeout"))).toBe(true)
        expect(isServerError({ details: { fromServer: true } })).toBe(true)
        expect(isServerError(herdrErr("timeout", { server: false }))).toBe(
            false
        )
        expect(isServerError(null)).toBe(false)
        expect(isTransportError(herdrErr("socket"))).toBe(true)
        expect(isTransportError(herdrErr("timeout", { server: false }))).toBe(
            true
        )
        expect(isTransportError(herdrErr("timeout"))).toBe(false)
        expect(isTransportError(herdrErr("agent_not_ready"))).toBe(false)
        expect(isTransportError(null)).toBe(false)
    })
})

describe("startTask", () => {
    test("happy path: identity, deliverable, herdr launch, status active", async () => {
        const env = setup()
        const r = await started(env, { wants_asana: true })
        expect(r.status).toBe("ok")
        expect(r.delivery).toBe("confirmed")
        expect(r.session).toMatchObject({
            task_id: 1,
            name: NAME,
            kind: "claude",
            pane_id: "p1",
            workspace_id: "w1",
            state: "idle",
            session_id: `sess-${NAME}-p1`,
        })
        const t = env.store.task(1)
        expect(t.status).toBe("active")
        expect(t.slug).toBe("k7q2")
        expect(t.branch).toBe("t1-fix-upload-retry-1")
        expect(t.worker_kind).toBe("claude")
        expect(t.deliverables).toEqual([
            expect.objectContaining({
                repo: "aws-lambda",
                branch: "t1-fix-upload-retry-1",
                role: "work",
                disposition: "pending",
                created_at: "2026-11-07T12:00:00.000Z",
            }),
        ])
        expect(env.jobRunner.enqueue).toHaveBeenCalledWith(
            "asana_create",
            {},
            { task_id: 1 }
        )
        expect(env.herdr.workspaceCreate).toHaveBeenCalledWith({
            cwd: "/tree",
            label: "T-1 Fix upload retry 1",
            env: {
                CC_TASK_ID: "1",
                CC_URL: "http://127.0.0.1:7788",
                CC_TOKEN: "tok",
            },
            focus: false,
        })
        expect(env.herdr.agentStart).toHaveBeenCalledWith({
            name: NAME,
            kind: "claude",
            paneId: "p1",
            args: [],
            timeoutMs: 60000,
        })
        const [target, text, opts] = env.herdr.agentPrompt.mock.calls[0]
        expect(target).toBe(NAME)
        expect(text).toContain("command-center task T-1")
        expect(text).toContain("slug: k7q2")
        expect(opts).toEqual({ wait: true, timeoutMs: 8000 })
        expect(env.herdr.reportMetadata).toHaveBeenCalledWith("w1", {
            task: "T-1",
            status: "active",
        })
        expect(env.events.track).toHaveBeenLastCalledWith(["p1"])
        expect(env.bus.emit).toHaveBeenCalledWith("agent.updated", {
            task_id: 1,
            data: { state: "idle" },
        })
        expect(env.store.eventTypes()).toContain("agent_started")
    })

    test("work repos get deliverables; warnings are returned; existing kept", async () => {
        const env = setup()
        env.identity.checkBranch.mockResolvedValueOnce({
            ok: true,
            warning: "remote check failed: offline",
        })
        env.store.seed(
            makeTask(1, {
                status: "active",
                slug: "abcd",
                branch: "t1-custom",
                worker_kind: "codex",
                repos: [
                    { name: "web", role: "ref" },
                    { name: "api", role: "main" },
                    { name: "infra", role: "work" },
                ],
                deliverables: [
                    {
                        repo: "api",
                        branch: "t1-custom",
                        role: "work",
                        created_at: "2026-01-01T00:00:00.000Z",
                        disposition: "pending",
                        pr: null,
                        claimed_at: null,
                        merged_at: null,
                    },
                ],
            })
        )
        const r = await env.svc.startTask(1)
        expect(r.warnings).toEqual(["remote check failed: offline"])
        expect(env.identity.newSlug).not.toHaveBeenCalled()
        expect(env.identity.checkBranch.mock.calls.map((c) => c[0])).toEqual([
            "api",
            "infra",
        ])
        const t = env.store.task(1)
        expect(t.deliverables.map((d) => d.repo)).toEqual(["api", "infra"])
        expect(t.deliverables[0].created_at).toBe("2026-01-01T00:00:00.000Z")
        expect(env.herdr.agentStart.mock.calls[0][0].kind).toBe("codex")
        const ev = env.store.events.find((e) => e.type === "agent_started")
        expect(ev.data.warnings).toEqual(["remote check failed: offline"])
        // status was already active: no second status update
        expect(
            env.store.updateTask.mock.calls.filter((c) => c[1].status)
        ).toHaveLength(0)
    })

    test("kind: argument > task > setting > claude; invalid kind is 400", async () => {
        const env = setup()
        env.settingsRepo.get.mockReturnValue("codex")
        await started(env)
        expect(env.herdr.agentStart.mock.calls[0][0].kind).toBe("codex")

        const env2 = setup()
        env2.store.seed(makeTask(1))
        await expect(
            env2.svc.startTask(1, { kind: "gpt" })
        ).rejects.toMatchObject({ status: 400 })
        const env3 = setup({
            settingsRepo: {
                get: () => {
                    throw new Error("db")
                },
            },
        })
        await started(env3)
        expect(env3.herdr.agentStart.mock.calls[0][0].kind).toBe("claude")
        const env4 = setup({ settingsRepo: null })
        await started(env4)
        expect(env4.herdr.agentStart.mock.calls[0][0].kind).toBe("claude")
    })

    test("preconditions are 409s", async () => {
        const env = setup()
        env.store.seed(makeTask(1, { status: "pr_open" }))
        await expect(env.svc.startTask(1)).rejects.toMatchObject({
            code: "invalid_state",
            status: 409,
        })
        env.store.seed(makeTask(2, { repos: [] }))
        await expect(env.svc.startTask(2)).rejects.toMatchObject({
            code: "no_repo",
        })
        env.store.seed(makeTask(3))
        await env.svc.startTask(3)
        await expect(env.svc.startTask(3)).rejects.toMatchObject({
            code: "agent_running",
        })
        await expect(env.svc.startTask("x")).rejects.toMatchObject({
            status: 400,
        })
        await expect(env.svc.startTask(99)).rejects.toMatchObject({
            status: 404,
        })
    })

    test("branch conflict is a 409 with the suggestion; nothing launched", async () => {
        const env = setup()
        env.identity.checkBranch.mockResolvedValueOnce({
            ok: false,
            reason: "taken",
            suggestion: "t1-fix-2",
        })
        env.store.seed(makeTask(1))
        await expect(env.svc.startTask(1)).rejects.toMatchObject({
            code: "branch_conflict",
            status: 409,
            details: { repo: "aws-lambda", suggestion: "t1-fix-2" },
        })
        env.identity.checkBranch.mockResolvedValueOnce({
            ok: false,
            reason: "x",
        })
        await expect(env.svc.startTask(1)).rejects.toMatchObject({
            details: { suggestion: null },
        })
        expect(env.herdr.workspaceCreate).not.toHaveBeenCalled()
    })

    test("asana enqueue errors do not block start; gid present skips it", async () => {
        const env = setup()
        env.jobRunner.enqueue.mockImplementation(() => {
            throw new Error("boom")
        })
        await started(env, { wants_asana: true })
        expect(env.store.task(1).status).toBe("active")
        const env2 = setup()
        await started(env2, { wants_asana: true, asana: { gid: "9" } })
        expect(env2.jobRunner.enqueue).not.toHaveBeenCalled()
    })

    test("name taken in herdr -> suffix; all taken -> 409", async () => {
        const env = setup()
        env.herdr.agents.set(NAME, { name: NAME, kind: "claude", paneId: "px" })
        const r = await started(env)
        expect(r.session.name).toBe(`${NAME}-2`)

        const env2 = setup()
        env2.herdr.agentGet.mockResolvedValue({ name: "any" })
        env2.store.seed(makeTask(1))
        await expect(env2.svc.startTask(1)).rejects.toMatchObject({
            code: "agent_name_taken",
        })
    })

    test("workspace create failure flags the task and rethrows", async () => {
        const env = setup()
        env.herdr.workspaceCreate.mockRejectedValueOnce(herdrErr("socket"))
        env.store.seed(makeTask(1))
        await expect(env.svc.startTask(1)).rejects.toMatchObject({
            code: "socket",
        })
        const t = env.store.task(1)
        expect(t.flags.now).toBe(true)
        expect(t.flags.error).toMatch(/workspace create failed/)
        expect(t.status).toBe("ready")
        expect(env.sessions.rows).toHaveLength(0)
    })

    test("agentStart failure records a gone session, never closes the workspace", async () => {
        const env = setup()
        env.herdr.agentStart.mockRejectedValueOnce(herdrErr("agent_not_ready"))
        env.store.seed(makeTask(1))
        await expect(env.svc.startTask(1)).rejects.toMatchObject({
            code: "agent_not_ready",
        })
        expect(env.sessions.rows).toEqual([
            expect.objectContaining({ state: "gone", pane_id: "p1" }),
        ])
        expect(env.sessions.rows[0].ended_at).toBeTruthy()
        expect(env.store.task(1).flags.error).toMatch(
            /herdr: herdr agent_not_ready/
        )
        expect(env.store.eventTypes()).toContain("agent_failed")
        expect(env.bus.emit).toHaveBeenCalledWith("agent.updated", {
            task_id: 1,
            data: { state: "gone" },
        })
        // a retry may start again (no live session)
        await env.svc.startTask(1)
        expect(env.store.task(1).status).toBe("active")
        expect(env.store.task(1).flags.error).toBeNull()
    })

    test("recordGone survives a failing sessions repo", async () => {
        const env = setup()
        env.sessions.create = () => {
            throw new Error("db down")
        }
        env.herdr.agentStart.mockRejectedValueOnce(herdrErr("x"))
        env.store.seed(makeTask(1))
        await expect(env.svc.startTask(1)).rejects.toMatchObject({ code: "x" })
    })

    test("kickoff: herdr's own wait timeout = confirmed (working)", async () => {
        const env = setup()
        env.herdr.agentPrompt.mockRejectedValueOnce(herdrErr("timeout"))
        env.herdr.agentGet.mockImplementation(async (n) =>
            n === NAME && env.herdr.agentStart.mock.calls.length
                ? undefined
                : null
        )
        // agentGet returns null before start, then a throw-less "unknown" (undefined
        // from getAgent's catch path is simulated by a rejected call)
        env.herdr.agentGet.mockReset()
        env.herdr.agentGet
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(herdrErr("socket"))
        const r = await started(env)
        expect(r.status).toBe("ok")
        expect(r.session.state).toBe("working")
        expect(r.session.session_id).toBeNull()
    })

    test("kickoff: stalled = submitted but flagged", async () => {
        const env = setup()
        env.herdr.agentPrompt.mockRejectedValueOnce(
            herdrErr("agent_prompt_stalled")
        )
        const r = await started(env)
        expect(r.status).toBe("stalled")
        const f = env.store.task(1).flags
        expect(f.now).toBe(true)
        expect(f.error).toMatch(/did not start working on the kickoff prompt/)
    })

    test("kickoff: client-side timeout / socket = uncertain, never resent", async () => {
        for (const err of [
            herdrErr("timeout", { server: false }),
            herdrErr("socket", { server: false }),
        ]) {
            const env = setup()
            env.herdr.agentPrompt.mockRejectedValueOnce(err)
            env.herdr.agentGet
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null)
            const r = await started(env)
            expect(r.status).toBe("uncertain")
            expect(r.session.state).toBe("unknown")
            const f = env.store.task(1).flags
            expect(f.now).toBe(true)
            expect(f.now_reason).toBe(UNCERTAIN_REASON)
            expect(f.error).toMatch(/Delivery uncertain — check the agent/)
            expect(env.herdr.agentPrompt).toHaveBeenCalledTimes(1)
            expect(env.store.task(1).status).toBe("active")
        }
    })

    test("kickoff: other server error = gone + rethrow", async () => {
        const env = setup()
        env.herdr.agentPrompt.mockRejectedValueOnce(herdrErr("agent_blocked"))
        env.store.seed(makeTask(1))
        await expect(env.svc.startTask(1)).rejects.toMatchObject({
            code: "agent_blocked",
        })
        expect(env.sessions.current(1)).toBeNull()
    })

    test("metadata, event log and bus failures are tolerated", async () => {
        const env = setup()
        env.herdr.reportMetadata.mockRejectedValueOnce(new Error("meh"))
        env.store.appendEvent = async () => {
            throw new Error("log down")
        }
        env.bus.emit.mockImplementation(() => {
            throw new Error("listener")
        })
        env.events.track.mockImplementation(() => {
            throw new Error("track")
        })
        const r = await started(env)
        expect(r.status).toBe("ok")
    })
})

describe("deliver / flush", () => {
    test("idle -> sent with wait:false; next one waits for a status event", async () => {
        const env = setup()
        await started(env)
        await env.svc.start()
        const a = await env.svc.deliver(1, "first", { reason: "send" })
        expect(a).toEqual({ status: "sent", outbox_id: 1 })
        expect(env.herdr.agentPrompt).toHaveBeenLastCalledWith(NAME, "first", {
            wait: false,
        })
        const b = await env.svc.deliver(1, "second", { reason: "send" })
        expect(b).toEqual({ status: "queued", outbox_id: 2 })
        // agent goes working then idle -> second is sent
        env.events.emit("status", { paneId: "p1", status: "working" })
        await env.svc.idle()
        expect(env.outbox.rows[1].status).toBe("pending")
        env.events.emit("status", { paneId: "p1", status: "idle" })
        await env.svc.idle()
        expect(env.outbox.rows[1].status).toBe("sent")
        expect(env.store.eventTypes()).toContain("agent_prompt_sent")
        await env.svc.stop()
    })

    test("settle window passes without events -> fresh state decides", async () => {
        const env = setup({ settleMs: 1000 })
        await started(env)
        await env.svc.deliver(1, "a")
        expect((await env.svc.deliver(1, "b")).status).toBe("queued")
        await env.clock.advance(2000)
        expect((await env.svc.deliver(1, "c")).status).toBe("queued") // b went
        expect(env.outbox.rows.map((r) => r.status)).toEqual([
            "sent",
            "sent",
            "pending",
        ])
    })

    test("working -> queued; herdr unreachable -> queued", async () => {
        const env = setup()
        await started(env)
        env.herdr.setStatus(NAME, "working")
        expect((await env.svc.deliver(1, "x")).status).toBe("queued")
        expect(env.sessions.current(1).state).toBe("working")
        env.herdr.agentGet.mockRejectedValueOnce(herdrErr("socket"))
        expect((await env.svc.deliver(1, "y")).status).toBe("queued")
    })

    test("blocked -> never sent, Now + one notification", async () => {
        const env = setup()
        await started(env)
        env.herdr.setStatus(NAME, "blocked")
        expect((await env.svc.deliver(1, "x")).status).toBe("blocked")
        expect((await env.svc.deliver(1, "y")).status).toBe("blocked")
        expect(env.notifier.notify).toHaveBeenCalledTimes(1)
        expect(env.store.task(1).flags).toMatchObject({
            now: true,
            now_reason: BLOCKED_REASON,
        })
        expect(env.outbox.pending(1)).toHaveLength(2)
    })

    test("prompt errors: agent_blocked / not_ready keep the row pending", async () => {
        const env = setup()
        await started(env)
        env.herdr.agentPrompt.mockRejectedValueOnce(herdrErr("agent_blocked"))
        expect((await env.svc.deliver(1, "x")).status).toBe("blocked")
        env.herdr.agentPrompt.mockRejectedValueOnce(herdrErr("agent_not_ready"))
        expect((await env.svc.deliver(1, "y")).status).toBe("queued")
        expect(env.outbox.pending(1)).toHaveLength(2)
    })

    test("server error -> failed, flagged, never resent", async () => {
        const env = setup()
        await started(env)
        env.herdr.agentPrompt.mockRejectedValueOnce(herdrErr("boom"))
        const r = await env.svc.deliver(1, "x", { reason: "pr_feedback" })
        expect(r).toEqual({
            status: "failed",
            outbox_id: 1,
            error: "herdr boom",
        })
        expect(env.outbox.rows[0]).toMatchObject({ status: "failed" })
        expect(env.store.task(1).flags.error).toMatch(
            /Prompt not delivered \(pr_feedback\)/
        )
        expect(env.store.eventTypes()).toContain("agent_prompt_failed")
    })

    test("transport error -> uncertain, row failed, flagged, never resent", async () => {
        const env = setup()
        await started(env)
        env.herdr.agentPrompt.mockRejectedValueOnce(
            herdrErr("timeout", { server: false })
        )
        const r = await env.svc.deliver(1, "x", { reason: "send" })
        expect(r.status).toBe("uncertain")
        expect(env.outbox.rows[0].status).toBe("failed")
        expect(env.outbox.rows[0].error).toMatch(/^delivery uncertain: /)
        expect(env.store.task(1).flags).toMatchObject({
            now: true,
            now_reason: UNCERTAIN_REASON,
        })
        expect(env.store.eventTypes()).toContain("agent_prompt_uncertain")
        const calls = env.herdr.agentPrompt.mock.calls.length
        await env.svc.resync()
        expect(env.herdr.agentPrompt.mock.calls.length).toBe(calls)
    })

    test("dedupe: an already delivered key is not re-sent", async () => {
        const env = setup()
        await started(env)
        await env.svc.deliver(1, "x", { dedupeKey: "k" })
        expect(await env.svc.deliver(1, "x", { dedupeKey: "k" })).toEqual({
            status: "sent",
            outbox_id: 1,
            duplicate: true,
        })
    })

    test("validation", async () => {
        const env = setup()
        await started(env)
        await expect(env.svc.deliver(1, "  ")).rejects.toMatchObject({
            status: 400,
        })
        await expect(
            env.svc.deliver(1, "x".repeat(100001))
        ).rejects.toMatchObject({ status: 400 })
        await expect(env.svc.deliver(2, "x")).rejects.toMatchObject({
            status: 404,
        })
    })

    test("agent vanished -> session gone, revived (resume) and flushed right after", async () => {
        const env = setup()
        await started(env)
        env.herdr.agents.delete(NAME)
        const r = await env.svc.deliver(1, "after revive", { reason: "send" })
        expect(r.status).toBe("sent")
        const start2 = env.herdr.agentStart.mock.calls[1][0]
        expect(start2.args).toEqual(["--resume", `sess-${NAME}-p1`])
        expect(start2.paneId).toBe("p2")
        const prompts = env.herdr.agentPrompt.mock.calls.map((c) => c[1])
        expect(prompts[1]).toMatch(/^Resuming T-1\. cd back into aws-lambda--/)
        expect(prompts[1]).toContain("wait for my next message")
        expect(prompts[2]).toBe("after revive")
        expect(env.sessions.current(1).pane_id).toBe("p2")
        expect(env.store.eventTypes()).toContain("agent_revived")
    })

    test("agent_not_found on send -> revive then send", async () => {
        const env = setup()
        await started(env)
        env.herdr.agentPrompt.mockImplementationOnce(async () => {
            env.herdr.agents.delete(NAME)
            throw herdrErr("agent_not_found")
        })
        const r = await env.svc.deliver(1, "x")
        expect(r.status).toBe("sent")
        expect(env.herdr.workspaceCreate).toHaveBeenCalledTimes(2)
    })

    test("agent lost twice in one flush -> queued", async () => {
        const env = setup()
        await started(env)
        env.herdr.agentGet.mockResolvedValue(null)
        // revive's freeName needs some name to be free: all null = free
        const r = await env.svc.deliver(1, "x")
        expect(r.status).toBe("queued")
    })

    test("revive failure -> queued with error; uncertain revive holds the queue", async () => {
        const env = setup()
        await started(env)
        env.herdr.agents.delete(NAME)
        env.herdr.workspaceCreate.mockRejectedValueOnce(herdrErr("socket"))
        const r = await env.svc.deliver(1, "x")
        expect(r).toMatchObject({ status: "queued", error: "herdr socket" })

        const env2 = setup()
        await started(env2)
        env2.herdr.agents.delete(NAME)
        env2.herdr.agentPrompt.mockRejectedValueOnce(
            herdrErr("socket", { server: false })
        )
        const r2 = await env2.svc.deliver(1, "x")
        expect(r2.status).toBe("queued")
        expect(env2.outbox.pending(1)).toHaveLength(1)
    })
})

describe("review while the agent works again", () => {
    // the agent reported review (task review, Now "Ready for review")
    async function inReview(env, now_reason = "Ready for review") {
        await started(env)
        await env.svc.start()
        env.events.emit("status", { paneId: "p1", status: "idle" })
        await env.svc.idle()
        env.store.tasks.get(1).status = "review"
        env.store.tasks.get(1).flags = {
            ...env.store.task(1).flags,
            now: true,
            now_reason,
        }
    }

    test("idle -> working on a review task goes back to active", async () => {
        const env = setup()
        await inReview(env)
        env.events.emit("status", { paneId: "p1", status: "working" })
        await env.svc.idle()
        expect(env.store.task(1).status).toBe("active")
        expect(env.store.task(1).flags).toMatchObject({
            now: false,
            now_reason: null,
        })
        expect(env.store.eventTypes()).toContain("agent_resumed_work")
    })

    test("another Now reason stays; staying working or going idle changes nothing", async () => {
        const env = setup()
        await inReview(env, "Agent needs you")
        env.events.emit("status", { paneId: "p1", status: "working" })
        await env.svc.idle()
        expect(env.store.task(1).status).toBe("active")
        expect(env.store.task(1).flags.now_reason).toBe("Agent needs you")

        // report review while already working: no transition, stays review
        env.store.tasks.get(1).status = "review"
        env.events.emit("status", { paneId: "p1", status: "working" })
        env.events.emit("status", { paneId: "p1", status: "idle" })
        await env.svc.idle()
        expect(env.store.task(1).status).toBe("review")
    })

    test("only review moves: ready_for_pr stays while the agent opens the PR", async () => {
        const env = setup()
        await inReview(env)
        env.store.tasks.get(1).status = "ready_for_pr"
        env.events.emit("status", { paneId: "p1", status: "working" })
        await env.svc.idle()
        expect(env.store.task(1).status).toBe("ready_for_pr")
        expect(env.store.eventTypes()).not.toContain("agent_resumed_work")
    })

    test("the resync / flush path also leaves review", async () => {
        const env = setup()
        await inReview(env)
        env.herdr.setStatus(NAME, "working")
        await env.svc.resync()
        await env.svc.idle()
        expect(env.store.task(1).status).toBe("active")
    })

    test("reviving an exited agent with more work leaves review", async () => {
        const env = setup()
        await inReview(env)
        await env.svc.action(1, "stop")
        env.herdr.agents.delete(NAME)
        const r = await env.svc.revive(1, { action: "address the comments" })
        expect(r).toMatchObject({ revived: true })
        expect(r.adopted).toBeUndefined()
        expect(env.store.task(1).status).toBe("active")
        expect(env.store.task(1).flags.now).toBe(false)
        const types = env.store.eventTypes()
        expect(types.indexOf("agent_resumed_work")).toBeLessThan(
            types.lastIndexOf("agent_revived")
        )
    })

    test("a failed relaunch puts the task back in review", async () => {
        const env = setup()
        await inReview(env)
        await env.svc.action(1, "stop")
        env.herdr.agents.delete(NAME)
        env.herdr.agentStart.mockRejectedValueOnce(herdrErr("agent_not_ready"))
        await expect(
            env.svc.revive(1, { action: "more" })
        ).rejects.toMatchObject({ code: "agent_not_ready" })
        // back in review; the launch failure's own Now flag stays on top
        expect(env.store.task(1).status).toBe("review")
        expect(env.store.task(1).flags.now_reason).toBe(START_FAILED_REASON)
    })

    test("with an open claimed PR it goes to pr_open (still watched), back to review on a failed relaunch", async () => {
        const env = setup()
        await inReview(env)
        const pr = "https://github.com/acme/app/pull/7"
        env.store.tasks.get(1).deliverables = [
            { repo: "app", disposition: "pr", pr, merged_at: null },
        ]
        env.events.emit("status", { paneId: "p1", status: "working" })
        await env.svc.idle()
        expect(env.store.task(1).status).toBe("pr_open")

        // a merged PR does not count: active
        env.store.tasks.get(1).status = "review"
        env.store.tasks.get(1).deliverables[0].merged_at =
            "2026-11-08T12:00:00.000Z"
        env.events.emit("status", { paneId: "p1", status: "idle" })
        env.events.emit("status", { paneId: "p1", status: "working" })
        await env.svc.idle()
        expect(env.store.task(1).status).toBe("active")

        env.events.emit("status", { paneId: "p1", status: "idle" })
        await env.svc.idle()
        env.store.tasks.get(1).status = "review"
        env.store.tasks.get(1).deliverables[0].merged_at = null
        await env.svc.action(1, "stop")
        env.herdr.agents.delete(NAME)
        env.herdr.agentStart.mockRejectedValueOnce(herdrErr("agent_not_ready"))
        await expect(
            env.svc.revive(1, { action: "more" })
        ).rejects.toMatchObject({ code: "agent_not_ready" })
        expect(env.store.task(1).status).toBe("review")
    })

    test("a failed relaunch before the workspace restores the review flag too", async () => {
        const env = setup()
        await inReview(env)
        await env.svc.action(1, "stop")
        env.herdr.agents.delete(NAME)
        // every agent name is taken: fails before launch, no flag of its own
        for (let n = 2; n < 10; n++)
            env.herdr.agents.set(`${NAME}-${n}`, { kind: "codex" })
        env.herdr.agents.set(NAME, { kind: "codex" })
        await expect(
            env.svc.revive(1, { action: "more" })
        ).rejects.toMatchObject({ code: "agent_name_taken" })
        expect(env.store.task(1).status).toBe("review")
        expect(env.store.task(1).flags).toMatchObject({
            now: true,
            now_reason: "Ready for review",
        })
    })

    test("a failed relaunch leaves a task that moved on alone; a store error is logged", async () => {
        const warn = jest.fn()
        const env = setup({ log: { warn, info() {}, error() {}, debug() {} } })
        await inReview(env)
        await env.svc.action(1, "stop")
        env.herdr.agents.delete(NAME)
        env.herdr.agentStart.mockImplementationOnce(async () => {
            env.store.tasks.get(1).status = "waiting"
            throw herdrErr("x")
        })
        await expect(env.svc.revive(1, { action: "more" })).rejects.toThrow()
        expect(env.store.task(1).status).toBe("waiting")

        env.store.tasks.get(1).status = "review"
        const lock = env.store.withTaskLock
        let calls = 0
        env.store.withTaskLock = async (id, fn) => {
            if (++calls > 1) throw new Error("disk")
            return lock(id, fn)
        }
        env.herdr.agentStart.mockRejectedValueOnce(herdrErr("x"))
        await expect(env.svc.revive(1, { action: "more" })).rejects.toThrow()
        expect(env.store.task(1).status).toBe("active")
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ task: 1 }),
            "review not restored"
        )
    })

    test("adopting with an action leaves review; adopting without one does not", async () => {
        const env = setup()
        await inReview(env)
        await env.svc.action(1, "stop")
        await env.svc.revive(1)
        expect(env.store.task(1).status).toBe("review")
        await env.svc.action(1, "stop")
        const r = await env.svc.revive(1, { action: "continue" })
        expect(r).toMatchObject({ adopted: true })
        expect(env.store.task(1).status).toBe("active")
    })

    test("a store failure is logged, the status event still applies", async () => {
        const env = setup()
        await inReview(env)
        env.store.withTaskLock = async () => {
            throw new Error("disk")
        }
        env.events.emit("status", { paneId: "p1", status: "working" })
        await env.svc.idle()
        expect(env.sessions.current(1).state).toBe("working")
        expect(env.store.task(1).status).toBe("review")
    })
})

describe("herdr events", () => {
    test("blocked -> Now + notify once; leaving blocked clears our Now", async () => {
        const env = setup()
        await started(env)
        await env.svc.start()
        env.events.emit("status", { paneId: "p1", status: "blocked" })
        env.events.emit("status", { paneId: "p1", status: "blocked" })
        await env.svc.idle()
        expect(env.notifier.notify).toHaveBeenCalledTimes(1)
        expect(env.store.task(1).flags.now).toBe(true)
        expect(env.sessions.current(1).state).toBe("blocked")
        env.events.emit("status", { paneId: "p1", status: "working" })
        await env.svc.idle()
        expect(env.store.task(1).flags).toMatchObject({
            now: false,
            now_reason: null,
        })
        // another Now reason is left alone
        env.store.tasks.get(1).flags = {
            ...env.store.task(1).flags,
            now: true,
            now_reason: "Ready for PR",
        }
        env.events.emit("status", { paneId: "p1", status: "blocked" })
        await env.svc.idle()
        env.store.tasks.get(1).flags.now_reason = "Ready for PR"
        env.events.emit("status", { paneId: "p1", status: "idle" })
        await env.svc.idle()
        expect(env.store.task(1).flags.now_reason).toBe("Ready for PR")
        await env.svc.stop()
    })

    test("unknown panes and empty events are ignored", async () => {
        const env = setup()
        await started(env)
        await env.svc.start()
        env.events.emit("status", { paneId: "nope", status: "idle" })
        env.events.emit("status")
        env.events.emit("exited", { paneId: "nope" })
        env.events.emit("exited")
        env.events.emit("closed", { workspaceId: "nope" })
        await env.svc.idle()
        expect(env.sessions.current(1)).not.toBeNull()
        await env.svc.stop()
    })

    test("claude usage limit -> flagged, queue held until working again", async () => {
        const env = setup()
        await started(env)
        await env.svc.start()
        env.herdr.setStatus(NAME, "working")
        await env.svc.deliver(1, "queued one")
        env.herdr.agentRead.mockResolvedValue(
            "line\n\n  You've hit your usage limit · resets 5pm\n> "
        )
        env.herdr.setStatus(NAME, "idle")
        env.events.emit("status", { paneId: "p1", status: "idle" })
        await env.svc.idle()
        expect(env.store.task(1).flags).toMatchObject({
            now: true,
            now_reason: UNAVAILABLE_REASON,
        })
        expect(env.store.task(1).flags.error).toMatch(
            /^Claude unavailable: You've hit your usage limit/
        )
        expect(env.outbox.pending(1)).toHaveLength(1)
        expect((await env.svc.agentState(1)).limited).toBe(true)
        expect(env.store.eventTypes()).toContain("agent_unavailable")
        // repeated idle: no second notification
        env.events.emit("status", { paneId: "p1", status: "idle" })
        await env.svc.idle()
        expect(
            env.notifier.notify.mock.calls.filter((c) =>
                c[0].title.includes(UNAVAILABLE_REASON)
            )
        ).toHaveLength(1)
        // deliver while limited stays queued
        expect((await env.svc.deliver(1, "x")).status).toBe("queued")
        // banner gone and working again -> flushes on next idle
        env.herdr.agentRead.mockResolvedValue("all good")
        env.events.emit("status", { paneId: "p1", status: "working" })
        env.events.emit("status", { paneId: "p1", status: "idle" })
        await env.svc.idle()
        expect(env.outbox.rows[0].status).toBe("sent")
        // agentRead failure is ignored
        env.herdr.agentRead.mockRejectedValue(new Error("x"))
        env.events.emit("status", { paneId: "p1", status: "idle" })
        await env.svc.idle()
        await env.svc.stop()
    })

    test("usage banner cleared without a working event", async () => {
        const env = setup()
        await started(env)
        await env.svc.start()
        env.herdr.agentRead.mockResolvedValueOnce("credit balance is too low")
        env.events.emit("status", { paneId: "p1", status: "blocked" })
        await env.svc.idle()
        expect((await env.svc.agentState(1)).limited).toBe(true)
        env.herdr.agentRead.mockResolvedValueOnce(null)
        env.events.emit("status", { paneId: "p1", status: "idle" })
        await env.svc.idle()
        expect((await env.svc.agentState(1)).limited).toBe(false)
        await env.svc.stop()
    })

    test("codex agents are not checked for usage limits", async () => {
        const env = setup()
        await started(env, { worker_kind: "codex" })
        await env.svc.start()
        env.events.emit("status", { paneId: "p1", status: "idle" })
        await env.svc.idle()
        expect(env.herdr.agentRead).not.toHaveBeenCalled()
        await env.svc.stop()
    })

    test("exited / closed end the session", async () => {
        const env = setup()
        await started(env)
        env.store.seed(makeTask(2))
        await env.svc.startTask(2)
        await env.svc.start()
        env.events.emit("exited", { paneId: "p1" })
        await env.svc.idle()
        expect(env.sessions.current(1)).toBeNull()
        expect(env.sessions.rows[0].state).toBe("gone")
        expect(env.store.eventTypes()).toContain("agent_gone")
        env.events.emit("closed", { workspaceId: "w2" })
        await env.svc.idle()
        expect(env.sessions.current(2)).toBeNull()
        expect(env.events.track).toHaveBeenLastCalledWith([])
        await env.svc.stop()
    })

    test("a stale status for an ended session is ignored", async () => {
        const env = setup()
        await started(env)
        const s = env.sessions.current(1)
        env.sessions.end(s.id)
        env.sessions.rows[0].ended_at = null // byPane still finds it ...
        const byPane = env.sessions.byPane
        env.sessions.byPane = () => ({ ...s })
        env.sessions.rows[0].ended_at = "x"
        await env.svc.start()
        env.events.emit("status", { paneId: "p1", status: "idle" })
        env.events.emit("exited", { paneId: "p1" })
        await env.svc.idle()
        env.sessions.byPane = byPane
        expect(env.store.eventTypes()).not.toContain("agent_gone")
        await env.svc.stop()
    })

    test("resync reconciles: vanished, changed status, idle flush", async () => {
        const env = setup()
        await started(env)
        env.store.seed(makeTask(2))
        await env.svc.startTask(2)
        env.store.seed(makeTask(3))
        await env.svc.startTask(3)
        const n2 = "t2-fix-upload-retry-2"
        const n3 = "t3-fix-upload-retry-3"
        env.herdr.agents.delete(NAME)
        env.herdr.setStatus(n2, "working")
        await env.svc.deliver(3, "q") // sent
        env.outbox.enqueue({ task_id: 3, text: "later", reason: "x" })
        await env.clock.advance(20000) // past the settle window
        env.herdr.agents.set("stray", { name: "stray" })
        await env.svc.resync()
        await env.svc.idle()
        expect(env.sessions.current(1)).toBeNull()
        expect(env.sessions.current(2).state).toBe("working")
        expect(env.outbox.pending(3)).toHaveLength(0)
        expect(env.herdr.agentPrompt).toHaveBeenLastCalledWith(n3, "later", {
            wait: false,
        })
        // concurrent resync calls share one run
        const a = env.svc.resync()
        expect(env.svc.resync()).toBe(a)
        await a
        env.herdr.agentList.mockRejectedValueOnce(new Error("down"))
        await env.svc.resync()
        env.herdr.agentList.mockResolvedValueOnce(null)
        await env.svc.resync()
    })

    test("resync revives tasks with queued prompts and no agent, with backoff", async () => {
        const env = setup({ reviveBackoffMs: 60000 })
        await started(env)
        env.herdr.agents.delete(NAME)
        env.herdr.workspaceCreate.mockRejectedValueOnce(herdrErr("socket"))
        expect((await env.svc.deliver(1, "feedback")).status).toBe("queued")
        expect(env.sessions.current(1)).toBeNull()
        const creates = env.herdr.workspaceCreate.mock.calls.length
        // within the backoff: not retried
        await env.svc.resync()
        expect(env.herdr.workspaceCreate.mock.calls.length).toBe(creates)
        // after it: revived and flushed
        await env.clock.advance(61000)
        await env.svc.resync()
        expect(env.herdr.workspaceCreate.mock.calls.length).toBe(creates + 1)
        expect(env.outbox.rows[0].status).toBe("sent")
    })

    test("resync orphans: failures logged, done/cancelled skipped except Clean", async () => {
        const env = setup({ reviveBackoffMs: 0 })
        env.store.seed(makeTask(1, { status: "done", slug: "abcd" }))
        env.store.seed(makeTask(2, { status: "cancelled" }))
        env.store.seed(makeTask(3, { status: "done" }))
        env.outbox.enqueue({ task_id: 1, text: "clean", reason: "clean" })
        env.outbox.enqueue({ task_id: 2, text: "x", reason: "send" })
        env.outbox.enqueue({ task_id: 3, text: "x", reason: "send" })
        env.outbox.enqueue({ task_id: 4, text: "x", reason: "send" }) // no task
        env.herdr.workspaceCreate.mockRejectedValueOnce(herdrErr("socket"))
        await env.svc.resync()
        expect(env.herdr.workspaceCreate).toHaveBeenCalledTimes(1)
        await env.svc.resync()
        expect(env.outbox.rows[0].status).toBe("sent")
        expect(env.herdr.workspaceCreate).toHaveBeenCalledTimes(2)
        // outbox failure is tolerated
        env.outbox.pending = () => {
            throw new Error("db")
        }
        await env.svc.resync()
    })

    test("start/stop: listeners, events lifecycle, periodic tick", async () => {
        const env = setup({ tickMs: 1000 })
        await env.svc.start()
        await env.svc.start() // idempotent
        expect(env.events.start).toHaveBeenCalledTimes(1)
        expect(env.herdr.agentList).toHaveBeenCalledTimes(1)
        await env.clock.advance(1000)
        expect(env.herdr.agentList).toHaveBeenCalledTimes(2)
        env.events.emit("resync", {})
        await env.svc.idle()
        expect(env.herdr.agentList).toHaveBeenCalledTimes(3)
        await env.svc.stop()
        await env.svc.stop()
        expect(env.events.stop).toHaveBeenCalledTimes(1)
        expect(env.clock.pending()).toBe(0)
        env.events.emit("resync", {})
        expect(env.herdr.agentList).toHaveBeenCalledTimes(3)
    })

    test("events without start/stop functions; tick disabled", async () => {
        const env = setup({ tickMs: 0 })
        delete env.events.start
        delete env.events.stop
        await env.svc.start()
        expect(env.clock.pending()).toBe(0)
        await env.svc.stop()
    })
})

describe("revive", () => {
    test("live agent: no-op, or the action is delivered", async () => {
        const env = setup()
        await started(env)
        const a = await env.svc.revive(1)
        expect(a).toMatchObject({ revived: false })
        const b = await env.svc.revive(1, { action: "re-check CI" })
        expect(b).toMatchObject({
            revived: false,
            delivery: "sent",
            status: "sent",
        })
        expect(env.herdr.agentPrompt).toHaveBeenLastCalledWith(
            NAME,
            "re-check CI",
            { wait: false }
        )
    })

    test("every revive path reports delivery status + error the same way", async () => {
        const env = setup()
        await started(env)
        // live agent, prompt rejected by herdr
        env.herdr.agentPrompt.mockRejectedValueOnce(
            Object.assign(new Error("pane went away"), { code: "weird" })
        )
        const live = await env.svc.revive(1, { action: "re-check CI" })
        expect(live).toMatchObject({
            revived: false,
            delivery: "failed",
            status: "failed",
        })
        expect(live.error).toMatch(/pane went away/)
        // adoption path, prompt rejected by herdr
        await env.svc.action(1, "stop")
        env.herdr.agentPrompt.mockRejectedValueOnce(
            Object.assign(new Error("nope"), { code: "weird" })
        )
        const adopted = await env.svc.revive(1, { action: "continue" })
        expect(adopted).toMatchObject({
            adopted: true,
            delivery: "failed",
            status: "failed",
        })
        expect(adopted.error).toMatch(/nope/)
    })

    test("adopts a still-running agent with our name and kind", async () => {
        const env = setup()
        await started(env)
        await env.svc.action(1, "stop")
        expect(env.sessions.current(1)).toBeNull()
        const r = await env.svc.revive(1, { action: "continue" })
        expect(r).toMatchObject({ revived: true, adopted: true })
        expect(r.session).toMatchObject({ name: NAME, pane_id: "p1" })
        expect(env.herdr.workspaceCreate).toHaveBeenCalledTimes(1)
        expect(env.herdr.agentPrompt.mock.calls.at(-1)[1]).toMatch(
            /^Resuming T-1\. .* then: continue$/
        )
        expect(env.store.eventTypes()).toContain("agent_adopted")
        // adopt without action, sparse agent info
        await env.svc.action(1, "stop")
        env.herdr.agents.set(NAME, { kind: "claude", paneId: "p1" })
        const r2 = await env.svc.revive(1)
        expect(r2.session).toMatchObject({
            state: "unknown",
            workspace_id: null,
            session_id: `sess-${NAME}-p1`,
        })
    })

    test("a suffixed launch is revived under its own name, never the base occupant", async () => {
        const env = setup()
        // someone else's agent holds the base name
        const other = {
            name: NAME,
            kind: "claude",
            status: "working",
            sessionId: "sess-other",
            paneId: "p-other",
            workspaceId: "w-other",
        }
        env.herdr.agents.set(NAME, other)
        await started(env)
        const own = env.sessions.current(1).name
        expect(own).not.toBe(NAME)
        expect(own).toMatch(/-2$/)

        // record stopped while our agent still runs: adopt OUR agent
        await env.svc.action(1, "stop")
        const r = await env.svc.revive(1, { action: "continue" })
        expect(r).toMatchObject({ adopted: true })
        expect(r.session.name).toBe(own)
        expect(r.session.pane_id).not.toBe("p-other")
        expect(env.herdr.agentPrompt).not.toHaveBeenCalledWith(
            NAME,
            expect.anything(),
            expect.anything()
        )

        // our agent is gone: resume our session in a new workspace instead
        // of adopting the base-name occupant
        await env.svc.action(1, "stop")
        env.herdr.agents.delete(own)
        const r2 = await env.svc.revive(1, { action: "continue" })
        expect(r2.adopted).toBeUndefined()
        expect(r2).toMatchObject({ revived: true, resumed: true })
        expect(r2.session.name).not.toBe(NAME)
        expect(env.herdr.agentPrompt).not.toHaveBeenCalledWith(
            NAME,
            expect.anything(),
            expect.anything()
        )
        expect(env.herdr.agents.get(NAME)).toBe(other)
    })

    test("an agent under our recorded name but another session is not adopted", async () => {
        const env = setup()
        await started(env)
        await env.svc.action(1, "stop")
        // the name was reused by a different agent meanwhile
        env.herdr.agents.set(NAME, {
            name: NAME,
            kind: "claude",
            status: "idle",
            sessionId: "sess-someone-else",
            paneId: "p9",
        })
        const r = await env.svc.revive(1, { action: "continue" })
        expect(r.adopted).toBeUndefined()
        expect(r.session.name).not.toBe(NAME)
        expect(r.session.pane_id).not.toBe("p9")
    })

    test("fresh context when the kind changed; main folder from the scan", async () => {
        const env = setup()
        await started(env)
        env.herdr.agents.delete(NAME)
        await env.svc.action(1, "stop")
        env.store.tasks.get(1).worker_kind = "codex"
        env.store.feedback.set(1, [
            {
                id: "gh-rc-1",
                kind: "review_comment",
                round: 1,
                status: "open",
                url: "u",
            },
        ])
        env.identity.scanFolders.mockReturnValue([
            { folder: "aws-lambda--b--k7q2", repo: "aws-lambda", role: "main" },
        ])
        const r = await env.svc.revive(1, { action: "fix CI" })
        expect(r).toMatchObject({ revived: true, resumed: false, status: "ok" })
        const start = env.herdr.agentStart.mock.calls.at(-1)[0]
        expect(start).toMatchObject({ kind: "codex", args: [] })
        const text = env.herdr.agentPrompt.mock.calls.at(-1)[1]
        expect(text).toContain("You are taking over command-center task T-1")
        expect(text).toContain("aws-lambda--b--k7q2")
        expect(text).toContain("gh-rc-1")
        expect(text).toContain("# artifact body")
        expect(text.endsWith("Then: fix CI")).toBe(true)
    })

    test("codex resume args; folder found by repo; scan errors tolerated", async () => {
        const env = setup()
        await started(env, { worker_kind: "codex" })
        env.herdr.agents.delete(NAME)
        await env.svc.action(1, "stop")
        env.identity.scanFolders.mockReturnValueOnce([
            { folder: "aws-lambda--x--k7q2", repo: "aws-lambda" },
        ])
        await env.svc.revive(1)
        expect(env.herdr.agentStart.mock.calls.at(-1)[0].args).toEqual([
            "resume",
            `sess-${NAME}-p1`,
        ])
        expect(env.herdr.agentPrompt.mock.calls.at(-1)[1]).toContain(
            "cd back into aws-lambda--x--k7q2"
        )
        env.herdr.agents.clear()
        await env.svc.action(1, "stop")
        env.identity.scanFolders.mockImplementationOnce(() => {
            throw new Error("fs")
        })
        await env.svc.revive(1)
    })

    test("no folders and no slug: generic resume / fresh prompts", async () => {
        const env = setup()
        env.store.seed(makeTask(1, { repos: [], slug: null }))
        env.sessions.create({
            task_id: 1,
            name: "old",
            kind: "claude",
            pane_id: "px",
            session_id: null,
        })
        env.sessions.end(1)
        env.store.getArtifact = async () => {
            throw new Error("no artifact")
        }
        env.store.listFeedback = undefined
        const r = await env.svc.revive(1)
        expect(r.resumed).toBe(false)
        expect(env.herdr.agentPrompt.mock.calls[0][1]).toContain(
            "no folders recorded yet"
        )
    })
})

describe("actions", () => {
    test("create-pr needs ready_for_pr; queued duplicates are reused", async () => {
        const env = setup()
        await started(env)
        await expect(env.svc.action(1, "create-pr")).rejects.toMatchObject({
            code: "invalid_state",
        })
        env.store.tasks.get(1).status = "ready_for_pr"
        env.herdr.setStatus(NAME, "working")
        const a = await env.svc.action(1, "create-pr", {}, { actor: "me" })
        expect(a).toMatchObject({ ok: true, delivery: { status: "queued" } })
        const b = await env.svc.action(1, "create-pr")
        expect(b.delivery).toMatchObject({ duplicate: true })
        expect(env.outbox.rows[0].text).toContain("Command-Center-Task: T-1")
        expect(
            env.store.events.find((e) => e.type === "agent_action").actor
        ).toBe("me")
    })

    test("address-feedback: oldest open round per PR, shared dedupe keys", async () => {
        const env = setup()
        await started(env)
        await expect(
            env.svc.action(1, "address-feedback")
        ).rejects.toMatchObject({ code: "no_open_feedback" })
        const PR1 = "https://github.com/acme/aws-lambda/pull/1"
        const PR2 = "https://github.com/acme/aws-lambda/pull/2"
        const item = (id, pr, round, over = {}) => ({
            id,
            pr,
            round,
            kind: "review",
            status: "open",
            actionable: true,
            url: `u-${id}`,
            ...over,
        })
        env.store.tasks.get(1).deliverables[0].pr = PR1
        env.store.feedback.set(1, [
            item("a", PR1, 1),
            item("b", PR1, 2, {
                kind: "review_comment",
                path: "x.js",
                line: 3,
            }),
            item("c", PR2, 2, { kind: "ci_failure" }),
            item("d", PR1, 1, { status: "fixed" }),
            item("e", PR1, 1, { actionable: false }),
            item("f", "https://example.com/not-a-pr", 1),
        ])
        env.herdr.setStatus(NAME, "working")
        // the watcher already queued PR2 round 2 under the shared key
        env.outbox.enqueue({
            task_id: 1,
            text: "watcher",
            reason: "pr_feedback",
            dedupe_key: "round-aws-lambda-2-2",
        })
        const r = await env.svc.action(1, "address-feedback")
        expect(r.deliveries).toHaveLength(3)
        expect(r.delivery).toEqual(r.deliveries[0])
        expect(r.deliveries[1]).toMatchObject({ duplicate: true, outbox_id: 1 })
        const pr1Row = env.outbox.rows.find(
            (x) => x.dedupe_key === "round-aws-lambda-1-1"
        )
        expect(pr1Row.text).toContain("(round 1)")
        expect(pr1Row.text).toContain("a  review  -  u-a")
        expect(pr1Row.text).not.toContain("u-b")
        expect(pr1Row.text).not.toContain("u-e")
        expect(pr1Row.text).toContain(`(${env.store.task(1).branch})`)
        // non-GitHub URL: delivered without a key
        const odd = env.outbox.rows.find((x) => x.text.includes("not-a-pr"))
        expect(odd.dedupe_key).toBeNull()
        // second click while still queued: reused
        const again = await env.svc.action(1, "address-feedback")
        expect(again.deliveries[0]).toMatchObject({ duplicate: true })
        // after it was delivered, a click re-sends without the key
        env.outbox.markSent(pr1Row.id)
        const before = env.outbox.rows.length
        await env.svc.action(1, "address-feedback")
        const resent = env.outbox.rows.slice(before)
        expect(resent.some((x) => x.text.includes("(round 1)"))).toBe(true)
        expect(resent.every((x) => x.dedupe_key === null)).toBe(true)
    })

    test("clean needs done and a slug", async () => {
        const env = setup()
        await started(env)
        await expect(env.svc.action(1, "clean")).rejects.toMatchObject({
            code: "invalid_state",
        })
        env.store.tasks.get(1).status = "done"
        env.store.tasks.get(1).slug = null
        await expect(env.svc.action(1, "clean")).rejects.toMatchObject({
            code: "no_slug",
        })
        env.store.tasks.get(1).slug = "k7q2"
        const r = await env.svc.action(1, "clean")
        expect(r.delivery.status).toBe("sent")
        expect(env.herdr.agentPrompt.mock.calls.at(-1)[1]).toBe(
            "Clean: follow tree AGENTS.md §6 for slug k7q2."
        )
    })

    test("focus needs a live agent", async () => {
        const env = setup()
        env.store.seed(makeTask(1))
        await expect(env.svc.action(1, "focus")).rejects.toMatchObject({
            code: "no_agent",
        })
        await env.svc.startTask(1)
        await env.svc.action(1, "focus")
        expect(env.herdr.agentFocus).toHaveBeenCalledWith(NAME)
    })

    test("send validates and formats", async () => {
        const env = setup()
        await started(env)
        await expect(env.svc.action(1, "send", {})).rejects.toMatchObject({
            status: 400,
        })
        await expect(
            env.svc.action(1, "send", { text: "x".repeat(20001) })
        ).rejects.toMatchObject({ status: 400 })
        await env.svc.action(1, "send", { text: "do it", quote: "the part" })
        expect(env.herdr.agentPrompt.mock.calls.at(-1)[1]).toBe(
            "Re T-1 artifact, about 'the part': do it"
        )
        await env.clock.advance(20000)
        await env.svc.action(1, "send", { text: "plain", quote: 5 })
        expect(env.herdr.agentPrompt.mock.calls.at(-1)[1]).toBe("Re T-1: plain")
        await expect(env.svc.action(1, "send", null)).rejects.toMatchObject({
            status: 400,
        })
    })

    test("close-agent closes the idle agent's workspace and ends the session", async () => {
        const env = setup()
        await started(env)
        const r = await env.svc.action(1, "close-agent", {}, { actor: "me" })
        expect(r).toMatchObject({ ok: true, closed: true, workspace_id: "w1" })
        expect(env.herdr.workspaceClose).toHaveBeenCalledWith("w1")
        expect(env.herdr.agentGet).toHaveBeenCalledWith("p1")
        expect(await env.sessions.current(1)).toBeNull()
        expect(env.store.eventTypes()).toContain("agent_closed")
        // nothing live any more
        await expect(env.svc.action(1, "close-agent")).rejects.toMatchObject({
            code: "no_agent",
            status: 409,
        })
    })

    test("close-agent refuses a working agent, a gone agent and a replaced one", async () => {
        const env = setup()
        await started(env)
        env.herdr.setStatus(NAME, "working")
        await expect(env.svc.action(1, "close-agent")).rejects.toMatchObject({
            code: "agent_busy",
            details: { state: "working" },
        })
        env.herdr.setStatus(NAME, "blocked")
        await expect(env.svc.action(1, "close-agent")).rejects.toMatchObject({
            code: "agent_busy",
        })
        // another agent took the pane
        env.herdr.setStatus(NAME, "idle")
        env.herdr.agentGet.mockResolvedValueOnce({
            name: "someone-else",
            status: "idle",
            paneId: "p1",
        })
        await expect(env.svc.action(1, "close-agent")).rejects.toMatchObject({
            code: "agent_not_found",
        })
        // the agent exited
        env.herdr.agents.clear()
        await expect(env.svc.action(1, "close-agent")).rejects.toMatchObject({
            code: "agent_not_found",
        })
        expect(env.herdr.workspaceClose).not.toHaveBeenCalled()
        // "done" (idle, unseen) may be closed
        const env2 = setup()
        await started(env2)
        env2.herdr.setStatus(NAME, "done")
        await env2.svc.action(1, "close-agent")
        expect(env2.herdr.workspaceClose).toHaveBeenCalledTimes(1)
    })

    describe("close-agent with clean", () => {
        const FOLDER = { folder: "api--t1-fix--k7q2" }
        async function doneWithAgent(over = {}) {
            const env = setup(over)
            await started(env)
            await env.svc.start()
            const t = env.store.tasks.get(1)
            t.status = "done"
            t.slug = "k7q2"
            env.identity.scanFolders.mockImplementation(() => [FOLDER])
            return env
        }
        const status = async (env, st) => {
            env.events.emit("status", { paneId: "p1", status: st })
            await env.svc.idle()
        }

        test("cleans first, closes once the turn is over and the folders are gone", async () => {
            const env = await doneWithAgent()
            const r = await env.svc.action(
                1,
                "close-agent",
                { clean: true },
                { actor: "me" }
            )
            expect(r).toMatchObject({
                ok: true,
                close_after: `clean:${r.delivery.outbox_id}`,
                delivery: { status: "sent" },
            })
            expect(env.herdr.agentPrompt.mock.calls.at(-1)[1]).toBe(
                "Clean: follow tree AGENTS.md §6 for slug k7q2."
            )
            const row = r.delivery.outbox_id
            expect((await env.sessions.current(1)).close_after).toBe(
                `clean:${row}`
            )
            expect(env.store.eventTypes()).toContain("agent_close_requested")
            // an idle report before it took the turn changes nothing, even
            // with no folders left
            env.identity.scanFolders.mockImplementation(() => [])
            await status(env, "idle")
            expect(env.herdr.workspaceClose).not.toHaveBeenCalled()
            env.identity.scanFolders.mockImplementation(() => [FOLDER])
            await status(env, "working")
            expect((await env.sessions.current(1)).close_after).toBe(
                `clean:${row}:working`
            )
            // a dialog mid-clean (rm needs a yes) is left alone
            await status(env, "blocked")
            expect(env.herdr.workspaceClose).not.toHaveBeenCalled()
            await status(env, "working")
            env.identity.scanFolders.mockImplementation(() => [])
            await status(env, "idle")
            expect(env.herdr.workspaceClose).toHaveBeenCalledWith("w1")
            expect(await env.sessions.current(1)).toBeNull()
            const closed = env.store.events.find(
                (e) => e.type === "agent_closed"
            )
            expect(closed.data).toMatchObject({ after: "clean", name: NAME })
            await env.svc.stop()
        })

        test("folders left after the turn: stays open, Now raised", async () => {
            const env = await doneWithAgent()
            await env.svc.action(1, "close-agent", { clean: true })
            await status(env, "working")
            await status(env, "idle")
            expect(env.herdr.workspaceClose).not.toHaveBeenCalled()
            expect((await env.sessions.current(1)).close_after).toBeNull()
            expect(env.store.tasks.get(1).flags).toMatchObject({
                now: true,
                now_reason: CLEAN_LEFT_REASON,
            })
            expect(env.notifier.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: `T-1: ${CLEAN_LEFT_REASON}`,
                    body: FOLDER.folder,
                })
            )
            const skipped = env.store.events.find(
                (e) => e.type === "agent_close_skipped"
            )
            expect(skipped.data.folders).toEqual([FOLDER.folder])
            // later idles do nothing more
            await status(env, "working")
            await status(env, "idle")
            expect(env.herdr.workspaceClose).not.toHaveBeenCalled()
            await env.svc.stop()
        })

        test("refused like Clean folders and like Close agent", async () => {
            const env = await doneWithAgent()
            env.store.tasks.get(1).status = "pr_open"
            await expect(
                env.svc.action(1, "close-agent", { clean: true })
            ).rejects.toMatchObject({ code: "invalid_state" })
            env.store.tasks.get(1).status = "done"
            env.store.tasks.get(1).slug = null
            await expect(
                env.svc.action(1, "close-agent", { clean: true })
            ).rejects.toMatchObject({ code: "no_slug" })
            env.store.tasks.get(1).slug = "k7q2"
            env.herdr.setStatus(NAME, "working")
            await expect(
                env.svc.action(1, "close-agent", { clean: true })
            ).rejects.toMatchObject({ code: "agent_busy" })
            expect((await env.sessions.current(1)).close_after).toBeFalsy()
            expect(env.herdr.agentPrompt).toHaveBeenCalledTimes(1) // kickoff
            await env.svc.stop()
        })

        test("an undelivered clean-up prompt cancels the close", async () => {
            const env = await doneWithAgent()
            const first = await env.sessions.current(1)
            env.herdr.agentPrompt.mockRejectedValueOnce(herdrErr("boom"))
            const r = await env.svc.action(1, "close-agent", { clean: true })
            expect(r).toMatchObject({
                close_after: null,
                delivery: { status: "failed" },
            })
            expect(
                env.sessions.rows.find((x) => x.id === first.id).close_after
            ).toBeNull()
            // a throwing delivery too
            const env2 = await doneWithAgent()
            env2.outbox.pending = jest.fn(async () => {
                throw new Error("db gone")
            })
            await expect(
                env2.svc.action(1, "close-agent", { clean: true })
            ).rejects.toThrow("db gone")
            expect((await env2.sessions.current(1)).close_after).toBeFalsy()
            await env.svc.stop()
            await env2.svc.stop()
        })

        test("a clean-up prompt that later failed or was cancelled cancels the close", async () => {
            const env = await doneWithAgent()
            const r = await env.svc.action(1, "close-agent", { clean: true })
            const cur = await env.sessions.current(1)
            // e.g. the row was cancelled from the outbox panel
            env.outbox.byId = jest.fn(async () => ({
                id: r.delivery.outbox_id,
                status: "cancelled",
            }))
            env.identity.scanFolders.mockImplementation(() => [])
            await status(env, "working")
            await status(env, "idle")
            expect(env.herdr.workspaceClose).not.toHaveBeenCalled()
            expect((await env.sessions.current(1)).close_after).toBeNull()
            const ev = env.store.events.find(
                (e) => e.type === "agent_close_cancelled"
            )
            expect(ev.data).toMatchObject({
                name: cur.name,
                prompt: "cancelled",
            })
            // a still-queued row waits; a vanished row cancels
            await env.sessions.update(cur.id, { close_after: "clean:99" })
            env.outbox.byId = jest.fn(async () => ({
                id: 99,
                status: "pending",
            }))
            await status(env, "idle")
            expect((await env.sessions.current(1)).close_after).toBe("clean:99")
            env.outbox.byId = jest.fn(async () => null)
            await status(env, "working")
            expect((await env.sessions.current(1)).close_after).toBeNull()
            await env.svc.stop()
        })

        test("the row id keeps a working mark set during the send", async () => {
            const env = await doneWithAgent()
            // herdr reports working while the prompt goes out
            const realPrompt = env.herdr.agentPrompt.getMockImplementation()
            env.herdr.agentPrompt.mockImplementationOnce(async (...a) => {
                env.events.emit("status", { paneId: "p1", status: "working" })
                return realPrompt ? realPrompt(...a) : {}
            })
            const r = await env.svc.action(1, "close-agent", { clean: true })
            await env.svc.idle()
            expect((await env.sessions.current(1)).close_after).toBe(
                `clean:${r.delivery.outbox_id}:working`
            )
            env.identity.scanFolders.mockImplementation(() => [])
            await status(env, "idle")
            expect(env.herdr.workspaceClose).toHaveBeenCalledWith("w1")
            await env.svc.stop()
        })

        test("the prompt row and the marker are written in one transaction", async () => {
            const transaction = jest.fn((fn) => fn())
            const env = await doneWithAgent({ transaction })
            const r = await env.svc.action(1, "close-agent", { clean: true })
            expect(transaction).toHaveBeenCalledTimes(1)
            expect(r.close_after).toBe(`clean:${r.delivery.outbox_id}`)
            // a failing marker write leaves no clean-up prompt behind
            const env2 = await doneWithAgent({
                transaction: (fn) => {
                    const before = env2.outbox.rows.length
                    try {
                        return fn()
                    } catch (err) {
                        env2.outbox.rows.length = before // rollback
                        throw err
                    }
                },
            })
            const cur = await env2.sessions.current(1)
            const realUpdate = env2.sessions.update
            env2.sessions.update = (id, patch) => {
                if (patch.close_after) throw new Error("disk full")
                return realUpdate(id, patch)
            }
            await expect(
                env2.svc.action(1, "close-agent", { clean: true })
            ).rejects.toThrow("disk full")
            expect(
                env2.outbox.rows.filter((x) => x.reason === "clean")
            ).toEqual([])
            expect(cur.close_after).toBeFalsy()
            await env.svc.stop()
            await env2.svc.stop()
        })

        test("a clean-up prompt already queued is the one the close waits for", async () => {
            const env = await doneWithAgent()
            const queued = await env.outbox.enqueue({
                task_id: 1,
                text: "Clean",
                reason: "clean",
            })
            const r = await env.svc.action(1, "close-agent", { clean: true })
            expect(r).toMatchObject({
                close_after: `clean:${queued.id}`,
                delivery: { status: "queued", duplicate: true },
            })
            // still pending: a turn now is not the clean-up
            await status(env, "working")
            expect((await env.sessions.current(1)).close_after).toBe(
                `clean:${queued.id}`
            )
            await env.svc.stop()
        })

        test("parseCloseAfter", () => {
            expect(parseCloseAfter("clean:12")).toEqual({
                rowId: 12,
                working: false,
            })
            expect(parseCloseAfter("clean:7:working")).toEqual({
                rowId: 7,
                working: true,
            })
            expect(parseCloseAfter("clean:pending")).toBeNull()
            expect(parseCloseAfter("other")).toBeNull()
            expect(parseCloseAfter(null)).toBeNull()
        })

        test("resync closes a pending close whose idle event was missed", async () => {
            const env = await doneWithAgent()
            await env.svc.action(1, "close-agent", { clean: true })
            await status(env, "working")
            // the idle event was missed (service down): the row says idle,
            // herdr says idle, the folders are gone
            const cur = await env.sessions.current(1)
            await env.sessions.update(cur.id, { state: "idle" })
            env.identity.scanFolders.mockImplementation(() => [])
            await env.svc.resync()
            expect(env.herdr.workspaceClose).toHaveBeenCalledWith("w1")
            await env.svc.stop()
        })

        test("a failed workspace close or folder scan keeps the close pending", async () => {
            const env = await doneWithAgent()
            await env.svc.action(1, "close-agent", { clean: true })
            await status(env, "working")
            env.identity.scanFolders.mockImplementation(() => {
                throw new Error("tree unreadable")
            })
            await status(env, "idle")
            expect(env.herdr.workspaceClose).not.toHaveBeenCalled()
            expect((await env.sessions.current(1)).close_after).toMatch(
                /^clean:\d+:working$/
            )
            env.identity.scanFolders.mockImplementation(() => [])
            env.herdr.workspaceClose.mockRejectedValueOnce(
                new Error("herdr down")
            )
            await status(env, "working")
            await status(env, "idle")
            expect((await env.sessions.current(1)).close_after).toMatch(
                /^clean:\d+:working$/
            )
            await status(env, "working")
            await status(env, "idle")
            expect(await env.sessions.current(1)).toBeNull()
            await env.svc.stop()
        })
    })

    test("relaunch-codex: kind switch, session ended, fresh codex agent", async () => {
        const env = setup()
        await started(env)
        env.store.tasks.get(1).flags = {
            ...env.store.task(1).flags,
            now: true,
            now_reason: UNAVAILABLE_REASON,
            error: "Claude unavailable: x",
        }
        const r = await env.svc.action(1, "relaunch-codex", { text: "go on" })
        expect(r.session).toMatchObject({ kind: "codex", name: `${NAME}-2` })
        const t = env.store.task(1)
        expect(t.worker_kind).toBe("codex")
        expect(t.flags).toMatchObject({ now: false, error: null })
        expect(env.herdr.agentStart.mock.calls.at(-1)[0]).toMatchObject({
            kind: "codex",
            args: [],
        })
        expect(env.herdr.agentPrompt.mock.calls.at(-1)[1]).toContain(
            "Then: go on"
        )
        // without a live session too
        await env.svc.action(1, "stop")
        env.herdr.agents.clear()
        await env.svc.action(1, "relaunch-codex")
    })

    test.each(["done", "cancelled"])(
        "relaunch-codex on a %s task is refused and changes nothing",
        async (status) => {
            const env = setup()
            await started(env)
            const session = env.sessions.current(1)
            env.store.tasks.get(1).status = status
            env.store.tasks.get(1).flags = {
                ...env.store.task(1).flags,
                now: true,
                now_reason: UNAVAILABLE_REASON,
                error: "Claude unavailable: x",
            }
            const starts = env.herdr.agentStart.mock.calls.length
            await expect(
                env.svc.action(1, "relaunch-codex", { text: "go on" })
            ).rejects.toMatchObject({ code: "task_closed" })
            expect(env.herdr.agentStart).toHaveBeenCalledTimes(starts)
            expect(env.store.task(1).worker_kind).not.toBe("codex")
            // the current session is left alone
            expect(env.sessions.current(1).id).toBe(session.id)
        }
    )

    test("stop ends the record only", async () => {
        const env = setup()
        await started(env)
        expect(await env.svc.action(1, "stop")).toEqual({
            ok: true,
            stopped: true,
        })
        expect(await env.svc.action(1, "stop")).toEqual({
            ok: true,
            stopped: false,
        })
        expect(env.herdr.agents.has(NAME)).toBe(true)
    })

    test("retry requeues a failed prompt; cancel drops a pending one", async () => {
        const env = setup()
        await started(env)
        env.herdr.agentPrompt.mockRejectedValueOnce(herdrErr("boom"))
        await env.svc.deliver(1, "x")
        await expect(
            env.svc.action(1, "retry", { id: "nope" })
        ).rejects.toMatchObject({ status: 400 })
        await expect(
            env.svc.action(1, "retry", { id: 9 })
        ).rejects.toMatchObject({ status: 404 })
        const r = await env.svc.action(1, "retry", { id: 1 })
        expect(r.delivery).toMatchObject({ status: "sent", outbox_id: 1 })
        expect(env.store.task(1).flags.now).toBe(false)

        env.herdr.setStatus(NAME, "working")
        env.outbox.enqueue({ task_id: 1, text: "older", reason: "a" })
        env.herdr.agentPrompt.mockRejectedValueOnce(herdrErr("boom"))
        // make row 3 failed while 2 is pending
        env.outbox.enqueue({ task_id: 1, text: "y", reason: "b" })
        env.outbox.markFailed(3, "e")
        const q = await env.svc.action(1, "retry", { id: 3 })
        expect(q.delivery).toEqual({ status: "queued", outbox_id: 3 })
        expect(await env.svc.action(1, "cancel", { id: 2 })).toMatchObject({
            cancelled: true,
        })
    })

    test("outboxView lists pending and failed prompts (failed stay until retried)", async () => {
        const env = setup()
        await started(env)
        env.herdr.setStatus(NAME, "working")
        env.outbox.enqueue({ task_id: 1, text: "p1", reason: "a" })
        env.outbox.enqueue({ task_id: 1, text: "f1", reason: "b" })
        env.outbox.markFailed(2, "pane gone")
        env.outbox.enqueue({ task_id: 1, text: "s1", reason: "c" })
        env.outbox.markSent(3)
        const view = await env.svc.outboxView(1)
        expect(view.map((r) => [r.id, r.status])).toEqual([
            [1, "pending"],
            [2, "failed"],
        ])
        expect(view[1].error).toBe("pane gone")
    })

    test("an old failed prompt stays in view (and retryable) behind 50 sent ones", async () => {
        const env = setup()
        await started(env)
        env.herdr.setStatus(NAME, "working")
        const f = env.outbox.enqueue({ task_id: 1, text: "lost", reason: "b" })
        env.outbox.markFailed(f.id, "pane gone")
        for (let i = 0; i < 50; i++) {
            const r = env.outbox.enqueue({
                task_id: 1,
                text: `s${i}`,
                reason: "c",
            })
            env.outbox.markSent(r.id)
        }
        expect(env.outbox.list(1).some((r) => r.id === f.id)).toBe(false)
        const view = await env.svc.outboxView(1)
        expect(view.map((r) => [r.id, r.status])).toEqual([[f.id, "failed"]])
        // Retry finds it by id, not through the limited history
        const res = await env.svc.action(1, "retry", { id: f.id })
        expect(res.ok).toBe(true)
        expect(env.outbox.byId(f.id).status).not.toBe("failed")
    })

    test("retry without requeue enqueues a copy", async () => {
        const env = setup()
        delete env.outbox.requeue
        await started(env)
        env.herdr.agentPrompt.mockRejectedValueOnce(herdrErr("boom"))
        await env.svc.deliver(1, "x", { reason: "send" })
        const r = await env.svc.action(1, "retry", { id: 1 })
        expect(r.delivery).toMatchObject({ status: "sent", outbox_id: 2 })
    })

    test("unknown action is 404", async () => {
        const env = setup()
        await started(env)
        await expect(env.svc.action(1, "dance")).rejects.toMatchObject({
            status: 404,
        })
    })
})

describe("state views", () => {
    test("agentState / states / queued", async () => {
        const env = setup()
        env.store.seed(makeTask(1))
        expect(await env.svc.agentState(1)).toBeNull()
        await env.svc.startTask(1)
        env.herdr.setStatus(NAME, "working")
        await env.svc.deliver(1, "q")
        expect(await env.svc.agentState(1)).toMatchObject({
            state: "working",
            kind: "claude",
            name: NAME,
            pane_id: "p1",
            outbox: 1,
            limited: false,
        })
        expect(await env.svc.states()).toEqual({ 1: "working" })
        expect(await env.svc.queued(1)).toHaveLength(1)
        await env.svc.action(1, "stop")
        expect(await env.svc.agentState(1)).toMatchObject({
            state: "gone",
            name: NAME,
        })
        expect(await env.svc.states()).toEqual({})
    })

    test("agentState tolerates sparse rows and missing history", async () => {
        const env = setup()
        env.sessions.history = () => null
        expect(await env.svc.agentState(1)).toBeNull()
        const env2 = setup()
        env2.sessions.current = () => ({
            id: 1,
            state: "idle",
            kind: "codex",
            name: "n",
        })
        expect(await env2.svc.agentState(1)).toMatchObject({
            session_id: null,
            pane_id: null,
            workspace_id: null,
            started_at: null,
            last_seen_at: null,
        })
    })

    test("defaults: config without listeners/herdr, no notifier", async () => {
        const env = setup({
            config: { treeDir: "/t" },
            notifier: null,
        })
        await started(env)
        expect(env.herdr.workspaceCreate.mock.calls[0][0].env.CC_URL).toBe(
            "http://127.0.0.1:7788"
        )
        env.herdr.setStatus(NAME, "blocked")
        expect((await env.svc.deliver(1, "x")).status).toBe("blocked")
    })

    test("notifier and store failures are logged, not thrown", async () => {
        const warn = jest.fn()
        const env = setup({
            notifier: {
                notify: async () => {
                    throw new Error("n")
                },
            },
            log: { warn, info() {}, error() {}, debug() {} },
            localToken: undefined,
        })
        await started(env)
        expect(env.herdr.workspaceCreate.mock.calls[0][0].env.CC_TOKEN).toBe("")
        env.store.updateTask.mockRejectedValue(new Error("disk"))
        env.store.withTaskLock = async () => {
            throw new Error("lock")
        }
        const getTask = env.store.getTask
        env.store.getTask = async (id) => {
            if (env.store.failGet) throw new Error("get")
            return getTask(id)
        }
        env.herdr.setStatus(NAME, "blocked")
        await env.svc.start()
        env.store.failGet = false
        env.events.emit("status", { paneId: "p1", status: "blocked" })
        await env.svc.idle()
        env.events.emit("status", { paneId: "p1", status: "idle" })
        await env.svc.idle()
        expect(warn).toHaveBeenCalled()
        // markBlocked with a failing task read
        env.store.failGet = true
        env.events.emit("status", { paneId: "p1", status: "blocked" })
        await env.svc.idle()
        await env.svc.stop()
    })
})

describe("agent identity", () => {
    test("a name reused by another agent before resync gets no prompt", async () => {
        const env = setup()
        await started(env)
        const own = env.sessions.current(1)
        // our agent exited and another one took the name (new pane/session)
        env.herdr.agents.set(NAME, {
            name: NAME,
            kind: "claude",
            status: "idle",
            sessionId: "sess-impostor",
            paneId: "p9",
            workspaceId: "w9",
        })
        const before = env.herdr.agentPrompt.mock.calls.length
        const r = await env.svc.deliver(1, "secret work", { reason: "send" })
        const sentTo = env.herdr.agentPrompt.mock.calls
            .slice(before)
            .map((c) => c[0])
        expect(sentTo).not.toContain(NAME)
        // the old session ended; the task revived under a fresh name
        expect(env.sessions.current(1).id).not.toBe(own.id)
        expect(env.sessions.current(1).name).not.toBe(NAME)
        expect(env.sessions.current(1).pane_id).not.toBe("p9")
        expect(r.status).toBe("sent")
    })

    test("same pane with a new session id is still our agent", async () => {
        const env = setup()
        await started(env)
        env.herdr.agents.get(NAME).sessionId = "sess-after-clear"
        const r = await env.svc.deliver(1, "go on", { reason: "send" })
        expect(r.status).toBe("sent")
        expect(env.herdr.agentPrompt.mock.calls.at(-1)[0]).toBe(NAME)
    })

    test("resync ends a session whose pane now runs another agent", async () => {
        const env = setup()
        await started(env)
        const a = env.herdr.agents.get(NAME)
        env.herdr.agents.delete(NAME)
        env.herdr.agents.set("someone-else", {
            ...a,
            name: "someone-else",
            sessionId: "sess-x",
        })
        await env.svc.resync()
        await env.svc.idle()
        const hist = env.sessions.history(1)
        expect(hist.find((x) => x.name === NAME).session_id).not.toBe("sess-x")
        expect(
            env.sessions.current(1) && env.sessions.current(1).pane_id
        ).not.toBe(a.paneId)
    })
})

describe("dropQueued", () => {
    test("cancels only the queued prompts whose dedupe key matches", async () => {
        const env = setup()
        await started(env)
        env.herdr.setStatus(NAME, "working")
        await env.svc.deliver(1, "round 1", {
            reason: "pr_feedback",
            dedupeKey: "round-org-a-1-1",
        })
        await env.svc.deliver(1, "follow-up", {
            reason: "follow-up",
            dedupeKey: "sched-7",
        })
        const ids = await env.svc.dropQueued(1, (k) => k.startsWith("round-"), {
            pr: "u",
            status: "merged",
        })
        expect(ids).toHaveLength(1)
        expect(env.outbox.pending(1).map((r) => r.text)).toEqual(["follow-up"])
        expect(env.store.eventTypes()).toContain("agent_prompts_dropped")
        // nothing matches: no event
        const before = env.store.eventTypes().length
        expect(await env.svc.dropQueued(1, () => false)).toEqual([])
        expect(env.store.eventTypes()).toHaveLength(before)
    })
})

describe("closed tasks and interrupted sends", () => {
    test.each(["done", "cancelled"])(
        "revive of a %s task launches nothing",
        async (status) => {
            const env = setup()
            env.store.seed(makeTask(1, { status }))
            const r = await env.svc.revive(1, { action: "resume" })
            expect(r).toEqual({
                skipped: true,
                status: "skipped",
                reason: `task is ${status}`,
            })
            expect(env.herdr.agentStart).not.toHaveBeenCalled()
            expect(env.herdr.agentPrompt).not.toHaveBeenCalled()
        }
    )

    test("a cancelled task's queued prompts are dropped, never sent", async () => {
        const env = setup()
        await started(env)
        env.herdr.setStatus(NAME, "working")
        const q = await env.svc.deliver(1, "open the PR now", {
            reason: "create-pr",
        })
        expect(q.status).toBe("queued")
        env.store.task(1).status = "cancelled"
        env.herdr.setStatus(NAME, "idle")
        await env.svc.resync()
        await env.svc.idle()
        expect(env.herdr.agentPrompt).not.toHaveBeenCalledWith(
            NAME,
            "open the PR now",
            expect.anything()
        )
        expect(env.outbox.pending(1)).toEqual([])
        expect(env.store.eventTypes()).toContain("agent_prompts_dropped")
    })

    test("a done task only keeps the explicit Clean prompt", async () => {
        const env = setup()
        await started(env)
        env.herdr.setStatus(NAME, "working")
        await env.svc.deliver(1, "late feedback", { reason: "pr_feedback" })
        await env.svc.deliver(1, "clean up", { reason: "clean" })
        env.store.task(1).status = "done"
        env.herdr.setStatus(NAME, "idle")
        await env.svc.resync()
        await env.svc.idle()
        const sent = env.herdr.agentPrompt.mock.calls.map((c) => c[1])
        expect(sent).toContain("clean up")
        expect(sent).not.toContain("late feedback")
    })

    test("a send cut off by a restart is failed as uncertain, not resent", async () => {
        const outbox = createOutboxRepo(openDb(":memory:"), {
            clock: createFakeClock(),
        })
        // the previous process claimed the row, then died mid-send
        const row = outbox.enqueue({
            task_id: 1,
            text: "open the PR now",
            reason: "create-pr",
        })
        outbox.markSending(row.id)
        const env = setup({ outbox })
        env.store.seed(makeTask(1))
        await env.svc.start() // startup recovers interrupted sends
        await env.svc.idle()
        expect(outbox.get(row.id)).toMatchObject({ status: "failed" })
        expect(outbox.get(row.id).error).toMatch(/delivery uncertain/)
        expect(env.herdr.agentPrompt).not.toHaveBeenCalledWith(
            NAME,
            "open the PR now",
            expect.anything()
        )
        expect(env.store.task(1).flags.now).toBe(true)
        expect(env.store.eventTypes()).toContain("agent_prompt_uncertain")
        // a normal send claims the row as "sending" first
        await env.svc.startTask(1)
        const next = await env.svc.deliver(1, "hello", { reason: "send" })
        expect(next.status).toBe("sent")
        expect(outbox.get(next.outbox_id).status).toBe("sent")
    })
})

describe("early recovery", () => {
    test("recover() runs once; a send in flight before start() is not failed", async () => {
        const outbox = createOutboxRepo(openDb(":memory:"), {
            clock: createFakeClock(),
        })
        const crashed = outbox.enqueue({
            task_id: 1,
            text: "left over",
            reason: "create-pr",
        })
        outbox.markSending(crashed.id)
        const spy = jest.spyOn(outbox, "recoverInterrupted")
        const env = setup({ outbox })
        env.store.seed(makeTask(1))
        // system.start() recovers first ...
        await env.svc.recover()
        expect(outbox.get(crashed.id).status).toBe("failed")
        // ... then a due follow-up starts sending during initialization
        const live = outbox.enqueue({
            task_id: 1,
            text: "follow-up",
            reason: "follow-up",
        })
        outbox.markSending(live.id)
        // ... and the worker service starts afterwards
        await env.svc.recover()
        await env.svc.start()
        await env.svc.idle()
        expect(spy).toHaveBeenCalledTimes(1)
        expect(outbox.get(live.id).status).toBe("sending")
        outbox.markSent(live.id)
        expect(outbox.get(live.id).status).toBe("sent")
        await env.svc.stop()
    })
})

describe("refused prompts with the real outbox", () => {
    const realOutbox = () =>
        createOutboxRepo(openDb(":memory:"), { clock: createFakeClock() })

    test.each(["agent_not_ready", "agent_blocked"])(
        "%s: the prompt goes back to pending and is sent later",
        async (code) => {
            const outbox = realOutbox()
            const env = setup({ outbox })
            await started(env)
            env.herdr.agentPrompt.mockRejectedValueOnce(herdrErr(code))
            const r = await env.svc.deliver(1, "check CI", { reason: "send" })
            expect(["queued", "blocked"]).toContain(r.status)
            const row = outbox.get(r.outbox_id)
            expect(row.status).toBe("pending")
            expect((await env.svc.outboxView(1)).map((x) => x.id)).toContain(
                row.id
            )
            // the agent can take it now
            env.herdr.setStatus(NAME, "idle")
            await env.clock.advance(60000)
            await env.svc.resync()
            await env.svc.idle()
            expect(outbox.get(row.id).status).toBe("sent")
        }
    )

    test("agent_not_found: released, then sent to the revived agent", async () => {
        const outbox = realOutbox()
        const env = setup({ outbox })
        await started(env)
        env.herdr.agentPrompt.mockRejectedValueOnce(herdrErr("agent_not_found"))
        const r = await env.svc.deliver(1, "check CI", { reason: "send" })
        const row = outbox.get(r.outbox_id)
        expect(row.status).not.toBe("sending")
        await env.svc.idle()
        expect(["pending", "sent"]).toContain(outbox.get(row.id).status)
    })

    test("a transport failure stays failed (uncertain), never released", async () => {
        const outbox = realOutbox()
        const env = setup({ outbox })
        await started(env)
        env.herdr.agentPrompt.mockRejectedValueOnce(
            Object.assign(new Error("socket closed"), { code: "socket" })
        )
        const r = await env.svc.deliver(1, "check CI", { reason: "send" })
        expect(r.status).toBe("uncertain")
        expect(outbox.get(r.outbox_id)).toMatchObject({ status: "failed" })
    })
})

describe("late session ids", () => {
    test("resync stores a session id herdr reports later; revive resumes it", async () => {
        const env = setup()
        await started(env)
        const cur = env.sessions.current(1)
        // the post-launch agentGet did not get an id
        env.sessions.update(cur.id, { session_id: null })
        expect(env.sessions.current(1).session_id).toBeNull()
        await env.svc.resync()
        await env.svc.idle()
        expect(env.sessions.current(1).session_id).toBe(`sess-${NAME}-p1`)
        // the pane goes away; a revive resumes that conversation
        env.herdr.agents.delete(NAME)
        await env.svc.resync()
        await env.svc.idle()
        expect(env.sessions.current(1)).toBeNull()
        await env.svc.revive(1, { action: "continue" })
        const start = env.herdr.agentStart.mock.calls.at(-1)[0]
        expect(start.args).toEqual(["--resume", `sess-${NAME}-p1`])
    })
})

describe("Address feedback through the PR watcher", () => {
    test("delegates to the watcher's round queue when it is bound", async () => {
        const env = setup()
        await started(env)
        const watcher = {
            addressFeedback: jest.fn(async () => ({
                round: 2,
                resent: false,
                delivery: { status: "queued" },
            })),
        }
        env.svc.setFeedbackDelivery(watcher)
        const r = await env.svc.action(1, "address-feedback")
        expect(watcher.addressFeedback).toHaveBeenCalledWith(1)
        expect(r).toMatchObject({
            ok: true,
            round: 2,
            resent: false,
            delivery: { status: "queued" },
        })
        // an object without addressFeedback unbinds it
        env.svc.setFeedbackDelivery({})
        await expect(
            env.svc.action(1, "address-feedback")
        ).rejects.toMatchObject({ status: 409 })
    })
})

describe("status around launch", () => {
    test("the task is active before the kickoff prompt goes out", async () => {
        const env = setup()
        let statusAtKickoff = null
        env.herdr.agentPrompt.mockImplementationOnce(async () => {
            statusAtKickoff = env.store.task(1).status
            return {}
        })
        await started(env)
        expect(statusAtKickoff).toBe("active")
        expect(env.store.task(1).status).toBe("active")
    })

    test("a failed launch restores the previous status", async () => {
        const env = setup()
        env.store.seed(makeTask(1))
        env.herdr.agentStart.mockRejectedValueOnce(
            Object.assign(new Error("no shell"), { code: "weird" })
        )
        await expect(env.svc.startTask(1)).rejects.toThrow()
        expect(env.store.task(1).status).toBe("ready")
    })

    test("a failed launch never overrides a status changed meanwhile", async () => {
        const env = setup()
        env.store.seed(makeTask(1))
        env.herdr.agentStart.mockImplementationOnce(async () => {
            env.store.task(1).status = "cancelled" // Leo cancelled meanwhile
            throw Object.assign(new Error("no shell"), { code: "weird" })
        })
        await expect(env.svc.startTask(1)).rejects.toThrow()
        expect(env.store.task(1).status).toBe("cancelled")
    })
})

describe("retry keeps the failure flag unless it worked", () => {
    test("a retry that fails again leaves Now set", async () => {
        const env = setup()
        await started(env)
        env.herdr.agentPrompt.mockRejectedValueOnce(herdrErr("boom"))
        const d = await env.svc.deliver(1, "x")
        expect(env.store.task(1).flags.now_reason).toBe("Prompt not delivered")
        env.herdr.agentPrompt.mockRejectedValueOnce(herdrErr("boom again"))
        const r = await env.svc.action(1, "retry", { id: d.outbox_id })
        expect(r.delivery.status).toBe("failed")
        expect(env.store.task(1).flags).toMatchObject({
            now: true,
            now_reason: "Prompt not delivered",
        })
    })
})

describe("Start re-checks and rollback", () => {
    test("a task finished during the branch checks is not reopened", async () => {
        const env = setup()
        env.store.seed(makeTask(1))
        env.identity.checkBranch.mockImplementationOnce(async () => {
            env.store.task(1).status = "done" // Leo finished it meanwhile
            return { ok: true }
        })
        await expect(env.svc.startTask(1)).rejects.toMatchObject({
            code: "invalid_state",
            status: 409,
        })
        expect(env.store.task(1).status).toBe("done")
        expect(env.herdr.agentStart).not.toHaveBeenCalled()
    })

    test("a herdr failure while picking the agent name leaves the task as it was", async () => {
        const env = setup()
        env.store.seed(makeTask(1))
        // herdr unreachable: no name can be confirmed free
        env.herdr.agentGet.mockRejectedValue(
            Object.assign(new Error("socket closed"), { code: "socket" })
        )
        await expect(env.svc.startTask(1)).rejects.toMatchObject({
            code: "agent_name_taken",
        })
        expect(env.store.task(1).status).toBe("ready")
        expect(env.herdr.workspaceCreate).not.toHaveBeenCalled()
    })

    test("an inbox start that fails rolls back to ready and keeps the launch error", async () => {
        const env = setup()
        env.store.seed(makeTask(1, { status: "inbox" }))
        env.herdr.agentStart.mockRejectedValueOnce(
            Object.assign(new Error("no shell in pane"), { code: "weird" })
        )
        await expect(env.svc.startTask(1)).rejects.toThrow(/no shell in pane/)
        expect(env.store.task(1).status).toBe("ready")
    })
})

describe("Create PR on a multi-repo task", () => {
    test("allowed in pr_open while another repo still has no PR", async () => {
        const env = setup()
        await started(env)
        const t = env.store.task(1)
        t.status = "pr_open"
        t.deliverables = [
            { repo: "aws-lambda", branch: "b", disposition: "pr", pr: "u" },
            { repo: "infra", branch: "b", disposition: "pending" },
        ]
        const r = await env.svc.action(1, "create-pr")
        expect(r.ok).toBe(true)
        // every repo has its PR: refused
        t.deliverables[1].disposition = "pr"
        await expect(env.svc.action(1, "create-pr")).rejects.toMatchObject({
            code: "invalid_state",
        })
    })
})

describe("command-center MCP on worker launch", () => {
    test("claude start gets --mcp-config with the headers helper", async () => {
        const env = setup({ mcpHeadersHelper: "/repo/install/mcp-headers.sh" })
        await started(env)
        const { args } = env.herdr.agentStart.mock.calls[0][0]
        expect(args[0]).toBe("--mcp-config")
        expect(JSON.parse(args[1])).toEqual({
            mcpServers: {
                "command-center": {
                    type: "http",
                    url: "http://127.0.0.1:7788/mcp",
                    headersHelper: "/repo/install/mcp-headers.sh",
                },
            },
        })
        expect(args).toHaveLength(2)
        // the token is never on the command line
        expect(args.join(" ")).not.toMatch(/tok/)
    })

    test("codex resume: the -c MCP flags come before resume <id>", async () => {
        const env = setup({ mcpHeadersHelper: "/repo/install/mcp-headers.sh" })
        await started(env, { worker_kind: "codex" })
        env.herdr.agents.delete(NAME)
        await env.svc.action(1, "stop")
        await env.svc.revive(1)
        const args = env.herdr.agentStart.mock.calls.at(-1)[0].args
        expect(args.slice(0, 2)).toEqual([
            "-c",
            'mcp_servers.command-center.url="http://127.0.0.1:7788/mcp"',
        ])
        expect(args.slice(-2)).toEqual(["resume", `sess-${NAME}-p1`])
        expect(args).toHaveLength(8)
    })

    test("default helper is this checkout's install/mcp-headers.sh", async () => {
        const env = setup({ mcpHeadersHelper: undefined })
        await started(env)
        const cfg = JSON.parse(env.herdr.agentStart.mock.calls[0][0].args[1])
        expect(cfg.mcpServers["command-center"].headersHelper).toMatch(
            /\/install\/mcp-headers\.sh$/
        )
    })
})
