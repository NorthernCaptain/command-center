/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// End-to-end: real store + git + SQLite + scheduler + job runner + auth +
// HTTP apps. Only the LLM provider, notifier exec, keychain and fetch are
// faked. No network, no real ~/.config.

import { jest } from "@jest/globals"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import request from "supertest"

import { defaultConfig } from "./config/config.js"
import { createFakeClock } from "./util/clock.js"
import {
    createSystem,
    loadMcpServers,
    defaultExec,
    detectPublicBaseUrl,
} from "./system.js"

const TOKEN = "t".repeat(64)

function waitFor(fn, { timeoutMs = 5000, stepMs = 10 } = {}) {
    const start = Date.now()
    return new Promise((resolve, reject) => {
        const tick = async () => {
            try {
                const v = await fn()
                if (v) return resolve(v)
            } catch {
                /* retry */
            }
            if (Date.now() - start > timeoutMs)
                return reject(new Error("waitFor timeout"))
            setTimeout(tick, stepMs)
        }
        tick()
    })
}

function makeEnv() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sys-"))
    const home = path.join(root, "home")
    const tasksDir = path.join(root, "tasks")
    fs.mkdirSync(tasksDir, { recursive: true })
    execFileSync("git", ["init", "-q", "-b", "tasks"], { cwd: tasksDir })
    const config = defaultConfig({ home, root })
    config.tasksDir = tasksDir
    config.dataDir = path.join(root, "data")
    config.timezone = "UTC"
    config.treeDir = path.join(root, "tree")
    config.brain.claudeConfigPath = path.join(root, "claude.json")
    config.git.commitDebounceMs = 1000
    config.scheduler.tickMs = 1000
    config.publicBaseUrl = "https://mac.ts.net:8443"
    // what config.json would set (nothing identifying ships in defaults)
    config.owner.tailscaleLogin = "owner@example.com"
    config.github.org = "acme"
    config.brain.serverName = "brain-mcp"
    fs.mkdirSync(config.configDir, { recursive: true })
    fs.mkdirSync(config.treeDir, { recursive: true })
    fs.writeFileSync(
        path.join(config.treeDir, "AGENTS.md"),
        "## 0. Main repos\n\n| Repo (`acme/…`) | Default | Lang | What |\n|---|---|---|---|\n| `aws-lambda` | `master` | JS | Lambdas |\n"
    )
    return { root, config }
}

function fakeProvider(name, calls) {
    return {
        name,
        async run({ schema, prompt }) {
            calls.push({ name, prompt })
            const props = Object.keys(schema.properties || {})
            if (props.includes("edits"))
                return {
                    output: {
                        reply: "Updated the summary.",
                        title: null,
                        message_agent: false,
                        edits: [
                            {
                                section: "Summary",
                                op: "replace",
                                content: "Lambda times out on cold start.",
                            },
                        ],
                    },
                    usage: {},
                    model: "fake",
                }
            if (props.includes("plan_md"))
                return {
                    output: {
                        title: "Investigate Lambda cold starts",
                        area: "backend",
                        kind: "todo",
                        summary: "Cold starts are slow.",
                        context_md: "",
                        acceptance: ["p95 cold start under 1s"],
                        plan_md: "1. Measure",
                        repos: [{ name: "aws-lambda", role: "main" }],
                        branch_suggestion: null,
                        wants_asana: false,
                        wants_agent: false,
                        due_at: null,
                    },
                    usage: {},
                    model: "fake",
                }
            throw new Error(`unexpected schema ${props.join(",")}`)
        },
    }
}

describe("system (end to end)", () => {
    let env
    let sys
    let clock
    let notes
    let calls
    const auth = (r) => r.set("Authorization", `Bearer ${TOKEN}`)
    // tailscale serve preserves the public Host; the host guard checks it.
    const tailnet = (method, url) =>
        request(sys.appTailnet)[method](url).set("Host", "mac.ts.net:8443")

    beforeEach(async () => {
        env = makeEnv()
        clock = createFakeClock("2026-11-07T12:00:00.000Z")
        notes = []
        calls = []
        sys = createSystem({
            config: env.config,
            overrides: {
                clock,
                localToken: TOKEN,
                keychain: { get: async () => "asana-token" },
                fetch: async () => {
                    throw new Error("no network in tests")
                },
                notifierExec: async (cmd, args) => {
                    notes.push([cmd, ...args])
                    return { stdout: "" }
                },
                providers: [
                    fakeProvider("claude-sdk", calls),
                    fakeProvider("claude-cli", calls),
                    fakeProvider("codex", calls),
                ],
            },
        })
        await sys.start({ listen: false })
    })

    afterEach(async () => {
        await sys.stop()
        fs.rmSync(env.root, { recursive: true, force: true })
    })

    test("a failed center job raises a notification", async () => {
        const before = notes.length
        sys.bus.emit("job.updated", {
            task_id: 7,
            data: { job: { type: "enrich", task_id: 7, status: "failed" } },
        })
        sys.bus.emit("job.updated", {
            task_id: null,
            data: { job: { type: "command", status: "done" } },
        })
        sys.bus.emit("task.updated", { task_id: 7, data: {} })
        await waitFor(() => notes.length > before)
        const fresh = notes.slice(before)
        expect(fresh).toHaveLength(1)
        expect(fresh[0].join(" ")).toMatch(/Center agent job failed/)
        expect(fresh[0].join(" ")).toMatch(/enrich T-7: /)
    })

    test("an Asana-linked task syncs its tracking block when its status changes", async () => {
        const spy = jest
            .spyOn(sys.asanaService, "syncTracking")
            .mockResolvedValue({
                attachments: ["https://example.test/artifact"],
                failed: [],
            })
        const { task } = await sys.store.createTask(
            { title: "Linked", kind: "todo", area: "backend" },
            "me"
        )
        await sys.store.updateTask(
            task.id,
            { asana: { gid: "1209", url: "https://app.asana.com/0/1/1209" } },
            { actor: "me" }
        )
        await clock.advance(3000)
        await waitFor(() => spy.mock.calls.length === 1)
        await waitFor(
            async () =>
                (await sys.store.getTask(task.id)).task.asana.tracking_hash
        )
        await sys.store.updateTask(
            task.id,
            { status: "active" },
            { actor: "me" }
        )
        await clock.advance(3000)
        await waitFor(() => spy.mock.calls.length === 2)
        expect(spy.mock.calls[1][0].status).toBe("active")
        const after = (await sys.store.getTask(task.id)).task.asana
        expect(after.attachments).toEqual(["https://example.test/artifact"])
        // the sync wrote only bookkeeping: no further sync is pending
        await clock.advance(3000)
        expect(spy).toHaveBeenCalledTimes(2)
    })

    test("phase 2/3 modules are wired: features, task extras, board, tools, digest", async () => {
        const me = await auth(request(sys.appLocal).get("/api/me"))
        expect(me.body.features).toEqual({
            workers: true,
            github: true,
            push: true,
            soc2: true,
            digest: true,
        })
        const { task } = await sys.store.createTask(
            { title: "Wire check", kind: "todo", area: "backend" },
            "me"
        )
        const t = await auth(request(sys.appLocal).get(`/api/tasks/${task.id}`))
        expect(t.status).toBe(200)
        expect(t.body).toMatchObject({
            agent: null,
            outbox: [],
            prs: [],
            pr_candidates: [],
            reviews: [],
        })
        const board = await auth(request(sys.appLocal).get("/api/board"))
        expect(board.body.agents).toEqual({})
        // worker tools over REST and MCP share one implementation
        const viaRest = await auth(
            request(sys.appLocal).post("/api/agent/cc_get_task")
        )
            .send({ task_id: task.id })
            .expect(200)
        expect(viaRest.body.task.title).toBe("Wire check")
        const list = await auth(request(sys.appLocal).post("/mcp"))
            .set("Accept", "application/json, text/event-stream")
            .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
            .expect(200)
        const names = list.body.result.tools.map((x) => x.name)
        expect(names).toEqual(
            expect.arrayContaining(["cc_get_task", "cc_report"])
        )
        // phase 3 routes answer; the digest is built on demand
        const d = await auth(request(sys.appLocal).post("/api/digest/run"))
            .send({})
            .expect(200)
        expect(d.body.digest.summary).toEqual(expect.any(String))
        await auth(request(sys.appLocal).get("/api/push/key")).expect(200)
        // the tailnet listener never exposes /mcp
        await request(sys.appTailnet)
            .post("/mcp")
            .set("Host", "mac.ts.net:8443")
            .expect((r) => expect(r.status).not.toBe(200))
    })

    test("Start without herdr fails cleanly (no repos -> 409)", async () => {
        const { task } = await sys.store.createTask(
            { title: "No repos", kind: "agent_task", area: "backend" },
            "me"
        )
        const res = await auth(
            request(sys.appLocal).post(`/api/tasks/${task.id}/start`)
        ).send({})
        expect(res.status).toBe(409)
    })

    test("rejects unauthenticated local requests", async () => {
        await request(sys.appLocal).get("/api/board").expect(401)
        await request(sys.appLocal).get("/healthz").expect(200)
    })

    /** Wait until the task's center jobs are finished; returns the task. */
    async function settled(id) {
        return waitFor(async () => {
            const t = await auth(request(sys.appLocal).get(`/api/tasks/${id}`))
            const busy = (t.body.jobs || []).some((j) =>
                ["queued", "running", "parked"].includes(j.status)
            )
            return !busy && t.body
        })
    }

    test("capture -> board -> artifact edit -> conflict", async () => {
        const created = await auth(request(sys.appLocal).post("/api/tasks"))
            .send({ text: "Fix upload lambda timeout" })
            .expect(201)
        const id = created.body.task.id
        expect(created.body.task.status).toBe("inbox")
        expect(fs.existsSync(path.join(env.config.tasksDir, "T-0001"))).toBe(
            true
        )

        const board = await auth(request(sys.appLocal).get("/api/board"))
        expect(board.body.lanes.inbox.map((t) => t.id)).toContain(id)

        // the capture's enrich job rewrites the artifact first
        const full = await settled(id)
        const { content, revision } = full.artifact
        expect(content).toMatch(/^# T-1 — Investigate Lambda cold starts/)

        const put = await auth(
            request(sys.appLocal).put(`/api/tasks/${id}/artifact`)
        )
            .send({ content: content + "\nextra\n", base_revision: revision })
            .expect(200)
        expect(put.body.revision).not.toBe(revision)

        const stale = await auth(
            request(sys.appLocal).put(`/api/tasks/${id}/artifact`)
        )
            .send({ content: "x", base_revision: revision })
            .expect(409)
        expect(stale.body.error).toBe("stale_revision")

        const search = await auth(
            request(sys.appLocal).get("/api/tasks?q=lambda")
        )
        expect(search.body.tasks.map((t) => t.id)).toEqual([id])
    })

    test("change comment runs the center agent and edits the artifact", async () => {
        const { body } = await auth(request(sys.appLocal).post("/api/tasks"))
            .send({ text: "Investigate cold starts" })
            .expect(201)
        const id = body.task.id
        // a free-text capture is enriched from its text
        expect(body.task.flags.enriching).toBe(true)
        const enriched = await settled(id)
        expect(enriched.task).toMatchObject({
            title: "Investigate Lambda cold starts",
            area: "backend",
        })
        expect(enriched.jobs.find((j) => j.type === "enrich").status).toBe(
            "done"
        )
        calls.length = 0
        const c = await auth(
            request(sys.appLocal).post(`/api/tasks/${id}/comments`)
        )
            .send({ body: "Summarize the problem", intent: "change" })
            .expect(201)
        expect(c.body.job).toBeTruthy()

        await waitFor(async () => {
            const j = await auth(
                request(sys.appLocal).get(`/api/jobs/${c.body.job.id}`)
            )
            return ["done", "failed"].includes(j.body.job.status) && j.body.job
        })
        const job = (
            await auth(request(sys.appLocal).get(`/api/jobs/${c.body.job.id}`))
        ).body.job
        expect(job.status).toBe("done")
        const t = await auth(request(sys.appLocal).get(`/api/tasks/${id}`))
        expect(t.body.artifact.content).toContain(
            "Lambda times out on cold start."
        )
        const thread = t.body.comments.find((x) => x.id === c.body.comment.id)
        expect(thread.status).toBe("resolved")
        expect(thread.replies[0].body).toBe("Updated the summary.")
        expect(calls.length).toBe(1)
    })

    test("reminder waits, then surfaces into Now with a notification", async () => {
        const { body } = await auth(request(sys.appLocal).post("/api/tasks"))
            .send({ text: "remind me to talk to Ron about 123 tomorrow 10am" })
            .expect(201)
        expect(body.task.kind).toBe("reminder")
        expect(body.task.status).toBe("waiting")
        expect(body.task.due_at).toBe("2026-11-08T10:00:00.000Z")

        await clock.advance(21 * 3600 * 1000)
        let board = await auth(request(sys.appLocal).get("/api/board"))
        expect(board.body.lanes.waiting.map((t) => t.id)).toContain(
            body.task.id
        )

        await clock.advance(2 * 3600 * 1000)
        await sys.scheduler.tick()
        board = await auth(request(sys.appLocal).get("/api/board"))
        expect(board.body.lanes.now.map((t) => t.id)).toContain(body.task.id)
        expect(notes.length).toBeGreaterThan(0)
        expect(notes[0][0]).toBe("herdr")
    })

    test("task changes are committed on the tasks branch", async () => {
        await auth(request(sys.appLocal).post("/api/tasks"))
            .send({ text: "Rotate tailscale keys" })
            .expect(201)
        await sys.git.flush()
        const log = execFileSync("git", ["log", "--format=%s%n%b"], {
            cwd: env.config.tasksDir,
        }).toString()
        expect(log).toMatch(/T-0001/)
        expect(log).toMatch(/Actor: me/)
        const branch = execFileSync("git", ["branch", "--show-current"], {
            cwd: env.config.tasksDir,
        })
            .toString()
            .trim()
        expect(branch).toBe("tasks")
    })

    test("tailnet: viewers see only shared tasks; the owner login is owner; local listener ignores the header", async () => {
        const priv = await auth(request(sys.appLocal).post("/api/tasks"))
            .send({ text: "Private thing" })
            .expect(201)
        const shared = await auth(request(sys.appLocal).post("/api/tasks"))
            .send({ text: "Shared thing", visibility: "shared" })
            .expect(201)

        await tailnet("get", "/api/board").expect(401)
        const viewer = await tailnet("get", "/api/board")
            .set("Tailscale-User-Login", "someone@example.com")
            .expect(200)
        const ids = Object.values(viewer.body.lanes)
            .flat()
            .map((t) => t.id)
        expect(ids).toContain(shared.body.task.id)
        expect(ids).not.toContain(priv.body.task.id)

        // a viewer can neither write nor see private tasks
        await tailnet("post", "/api/tasks")
            .set("Tailscale-User-Login", "someone@example.com")
            .send({ text: "x" })
            .expect(403)
        await tailnet("get", `/api/tasks/${priv.body.task.id}`)
            .set("Tailscale-User-Login", "someone@example.com")
            .expect(404)

        // the owner login alone (no paired device) is the owner
        await tailnet("get", `/api/tasks/${priv.body.task.id}`)
            .set("Tailscale-User-Login", "owner@example.com")
            .expect(200)
        await tailnet("post", "/api/tasks")
            .set("Tailscale-User-Login", "owner@example.com")
            .set("Origin", "https://mac.ts.net:8443")
            .send({ text: "From the phone" })
            .expect(201)
        // cross-origin writes are still refused
        await tailnet("post", "/api/tasks")
            .set("Tailscale-User-Login", "owner@example.com")
            .set("Origin", "https://evil.example")
            .send({ text: "x" })
            .expect(403)

        // a forged Tailscale header on the local listener grants nothing
        await request(sys.appLocal)
            .get("/api/board")
            .set("Tailscale-User-Login", "owner@example.com")
            .expect(401)
    })

    test("pairing makes the owner login an owner on the tailnet", async () => {
        const code = await auth(
            request(sys.appLocal).post("/api/pair/code")
        ).expect(200)
        const paired = await tailnet("post", "/api/pair")
            .set("Tailscale-User-Login", "owner@example.com")
            .send({ code: code.body.code, name: "phone" })
            .expect(200)
        const cookie = paired.headers["set-cookie"].find((c) =>
            c.startsWith("cc_device=")
        )
        expect(cookie).toMatch(/HttpOnly/i)
        const me = await tailnet("get", "/api/me")
            .set("Tailscale-User-Login", "owner@example.com")
            .set("Cookie", cookie.split(";")[0])
            .expect(200)
        expect(me.body.role).toBe("owner")
    })
})

describe("loadMcpServers", () => {
    const config = defaultConfig({ home: "/h", root: "/r" })
    config.brain.serverName = "tracebot-mcp"
    test("no Brain server configured: nothing", () => {
        const plain = defaultConfig({ home: "/h", root: "/r" })
        const readFile = jest.fn()
        expect(loadMcpServers({ config: plain, readFile })).toEqual({})
        expect(readFile).not.toHaveBeenCalled()
    })
    test("reads the Brain server entry", () => {
        const out = loadMcpServers({
            config,
            readFile: () =>
                JSON.stringify({
                    mcpServers: {
                        "tracebot-mcp": {
                            type: "http",
                            url: "https://x/mcp",
                            headers: { "x-api-key": "k" },
                        },
                    },
                }),
        })
        expect(out["tracebot-mcp"]).toEqual({
            type: "http",
            url: "https://x/mcp",
            headers: { "x-api-key": "k" },
        })
    })
    test("missing file or entry yields {}", () => {
        const warn = []
        expect(
            loadMcpServers({
                config,
                readFile: () => {
                    throw new Error("ENOENT")
                },
                log: { warn: (...a) => warn.push(a) },
            })
        ).toEqual({})
        expect(warn.length).toBe(1)
        expect(loadMcpServers({ config, readFile: () => "{}" })).toEqual({})
        expect(
            loadMcpServers({
                config,
                readFile: () =>
                    JSON.stringify({
                        mcpServers: { "tracebot-mcp": { url: "u" } },
                    }),
            })["tracebot-mcp"].headers
        ).toEqual({})
    })
})

test("defaultExec runs a binary", async () => {
    const { stdout } = await defaultExec("git", ["--version"])
    expect(stdout).toMatch(/git version/)
})

describe("detectPublicBaseUrl", () => {
    test("builds the tailnet URL from the Tailscale DNS name", async () => {
        const calls = []
        const url = await detectPublicBaseUrl({
            exec: async (cmd, args, opts) => {
                calls.push({ argv: [cmd, ...args], opts })
                return {
                    stdout: JSON.stringify({
                        Self: { DNSName: "My-Mac.tail0000.ts.net." },
                    }),
                }
            },
        })
        expect(url).toBe("https://my-mac.tail0000.ts.net:8443")
        expect(calls[0].argv.slice(1)).toEqual(["status", "--json"])
        expect(calls[0].opts.env.TERM).toBe(process.env.TERM || "dumb")
    })

    test("passes TERM even when the service has none (launchd)", async () => {
        const saved = process.env.TERM
        delete process.env.TERM
        try {
            let env = null
            await detectPublicBaseUrl({
                exec: async (cmd, args, opts) => {
                    env = opts.env
                    return { stdout: "{}" }
                },
            })
            expect(env.TERM).toBe("dumb")
            expect(env.HOME).toBe(process.env.HOME)
        } finally {
            if (saved !== undefined) process.env.TERM = saved
        }
    })
    test("returns null when tailscale is missing or output is odd", async () => {
        const warn = []
        expect(
            await detectPublicBaseUrl({
                exec: async () => {
                    throw new Error("ENOENT")
                },
                log: { warn: (...a) => warn.push(a) },
            })
        ).toBeNull()
        expect(warn).toHaveLength(1)
        expect(
            await detectPublicBaseUrl({
                exec: async () => ({ stdout: '{"Self":{"DNSName":"a b"}}' }),
            })
        ).toBeNull()
        expect(
            await detectPublicBaseUrl({
                exec: async () => ({ stdout: "{}" }),
                port: 9443,
            })
        ).toBeNull()
    })

    test("uses the configured https port", async () => {
        expect(
            await detectPublicBaseUrl({
                exec: async () => ({
                    stdout: '{"Self":{"DNSName":"mac.tail.ts.net."}}',
                }),
                port: 9443,
            })
        ).toBe("https://mac.tail.ts.net:9443")
    })
})

test("start: outbox recovery finishes before the scheduler, PR watcher and runner start", async () => {
    const env = makeEnv()
    const sys = createSystem({
        config: env.config,
        overrides: {
            clock: createFakeClock("2026-11-07T12:00:00.000Z"),
            localToken: TOKEN,
            keychain: { get: async () => null },
            fetch: async () => {
                throw new Error("no network in tests")
            },
        },
    })
    let release
    const gate = new Promise((r) => (release = r))
    const order = []
    const realRecover = sys.workerService.recover
    sys.workerService.recover = jest.fn(async () => {
        order.push("recover:begin")
        await gate
        await realRecover()
        order.push("recover:end")
    })
    for (const [name, obj] of [
        ["runner", sys.runner],
        ["scheduler", sys.scheduler],
        ["prWatcher", sys.github.prWatcher],
    ]) {
        const real = obj.start.bind(obj)
        obj.start = (...args) => {
            order.push(name)
            return real(...args)
        }
    }
    const started = sys.start({ listen: false })
    // wait until recovery is under way (git + store recovery run first)
    for (let i = 0; i < 200 && !order.length; i++)
        await new Promise((r) => setTimeout(r, 10))
    await new Promise((r) => setTimeout(r, 20))
    // nothing that can send has started while recovery is pending
    expect(order).toEqual(["recover:begin"])
    release()
    await started
    expect(order.slice(0, 2)).toEqual(["recover:begin", "recover:end"])
    expect(order).toEqual(
        expect.arrayContaining(["runner", "scheduler", "prWatcher"])
    )
    await sys.stop()
    fs.rmSync(env.root, { recursive: true, force: true })
})

test("security headers include a same-origin CSP", async () => {
    const env = makeEnv()
    const sys = createSystem({
        config: env.config,
        overrides: { localToken: TOKEN, keychain: { get: async () => null } },
    })
    const res = await request(sys.appLocal)
        .get("/healthz")
        .set("Host", `127.0.0.1:${env.config.listeners.local.port}`)
    expect(res.headers["content-security-policy"]).toMatch(
        /img-src 'self' data:/
    )
    expect(res.headers["x-frame-options"]).toBe("DENY")
    await sys.stop()
    fs.rmSync(env.root, { recursive: true, force: true })
})

test("tailnet resolves publicBaseUrl lazily via tailscale on the configured port", async () => {
    const env = makeEnv()
    env.config.publicBaseUrl = null
    env.config.tailscale.httpsPort = 9443
    const clock = createFakeClock("2026-11-07T12:00:00.000Z")
    const tsCalls = []
    let up = false
    const sys = createSystem({
        config: env.config,
        overrides: {
            clock,
            localToken: TOKEN,
            keychain: { get: async () => null },
            tailscaleExec: async (cmd, args) => {
                tsCalls.push([cmd, ...args])
                if (!up) throw new Error("tailscale not running")
                return {
                    stdout: JSON.stringify({
                        Self: { DNSName: "my-mac.tail0000.ts.net." },
                    }),
                }
            },
        },
    })
    const host = "my-mac.tail0000.ts.net:9443"
    const get = () => request(sys.appTailnet).get("/healthz").set("Host", host)
    // Tailscale not up yet at login: 503, retried at most once a minute.
    expect((await get()).status).toBe(503)
    up = true
    expect((await get()).status).toBe(503)
    expect(tsCalls).toHaveLength(1)
    expect(tsCalls[0].slice(1)).toEqual(["status", "--json"])
    clock.advance(60000)
    expect((await get()).status).toBe(200)
    expect(env.config.publicBaseUrl).toBe("https://my-mac.tail0000.ts.net:9443")
    expect((await get()).status).toBe(200)
    expect(tsCalls).toHaveLength(2)
    // the local listener never consults tailscale
    await request(sys.appLocal)
        .get("/healthz")
        .set("Host", `127.0.0.1:${env.config.listeners.local.port}`)
        .expect(200)
    expect(tsCalls).toHaveLength(2)
    await sys.stop()
    fs.rmSync(env.root, { recursive: true, force: true })
})
