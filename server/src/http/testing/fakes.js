/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// In-memory fakes of the contract signatures (store, scheduler, job runner,
// date parser, repos) used by the HTTP tests. Not used in production.

import supertest from "supertest"
import { createFakeClock } from "../../util/clock.js"
import { NotFoundError, StaleRevisionError } from "../../util/errors.js"
import { laneOf } from "../../contracts/lifecycle.js"
import { createBus } from "../../events/bus.js"
import { createAuth } from "../auth.js"
import { createApp } from "../app.js"

export const OWNER = "owner@example.com"
export const TOKEN = "a".repeat(64)

export function makeTask(id, over = {}) {
    return {
        id,
        title: `Task ${id}`,
        kind: "todo",
        area: "other",
        status: "inbox",
        prev_status: null,
        priority: 2,
        visibility: "auto",
        source: { type: "manual", url: null, text: "secret source" },
        due_at: null,
        snooze_until: null,
        repos: [],
        branch: null,
        slug: null,
        deliverables: [],
        asana: {
            gid: null,
            url: null,
            section_gid: null,
            no_section: false,
            attachments: [],
        },
        wants_asana: false,
        wants_agent: false,
        worker_kind: null,
        links: [],
        flags: { enriching: false, now: false, now_reason: null, error: null },
        created_at: "2026-11-07T12:00:00.000Z",
        updated_at: "2026-11-07T12:00:00.000Z",
        done_at: null,
        ...over,
    }
}

export function createFakeStore({ bus, clock }) {
    const tasks = new Map()
    const artifacts = new Map()
    const comments = new Map()
    let nextId = 1
    let rev = 0
    const newRev = () => `r${++rev}`
    const get = (id) => {
        const t = tasks.get(id)
        if (!t) throw new NotFoundError(`task ${id}`)
        return t
    }
    const store = {
        calls: [],
        tasks,
        seed(task, content = "# artifact") {
            tasks.set(task.id, { task, revision: newRev() })
            artifacts.set(task.id, { content, revision: newRev() })
            nextId = Math.max(nextId, task.id + 1)
            return task
        },
        async createTask(input, actor) {
            store.calls.push(["createTask", input, actor])
            const id = nextId++
            const task = makeTask(id, {
                title: input.title,
                kind: input.kind,
                area: input.area,
                status: input.status || "inbox",
                due_at: input.due_at || null,
                source: input.source,
                flags: { ...makeTask(0).flags, ...(input.flags || {}) },
            })
            const revision = newRev()
            tasks.set(id, { task, revision })
            const artifact = { content: `# T-${id}`, revision: newRev() }
            artifacts.set(id, artifact)
            bus.emit("task.created", { task_id: id, data: { task } })
            return { task, revision, artifact }
        },
        async getTask(id) {
            const { task, revision } = get(id)
            return { task, revision }
        },
        async updateTask(id, patch, opts) {
            store.calls.push(["updateTask", id, patch, opts])
            const cur = get(id)
            if (opts.baseRevision && opts.baseRevision !== cur.revision)
                throw new StaleRevisionError({
                    task: cur.task,
                    revision: cur.revision,
                })
            const task = { ...cur.task, ...patch }
            const revision = newRev()
            tasks.set(id, { task, revision })
            bus.emit("task.updated", {
                task_id: id,
                data: { task, changed: Object.keys(patch) },
            })
            return { task, revision }
        },
        async getArtifact(id) {
            get(id)
            return artifacts.get(id)
        },
        async writeArtifact(id, content, { actor, baseRevision }) {
            store.calls.push(["writeArtifact", id, content, actor])
            const cur = artifacts.get(id)
            if (!cur) throw new NotFoundError(`task ${id}`)
            if (baseRevision !== cur.revision) throw new StaleRevisionError(cur)
            const revision = newRev()
            artifacts.set(id, { content, revision })
            bus.emit("artifact.updated", {
                task_id: id,
                data: { revision, actor },
            })
            return { revision }
        },
        async appendComment(id, record, actor) {
            get(id)
            store.calls.push(["appendComment", id, record, actor])
            const c = {
                ...record,
                id: `c_${comments.size + 1}`,
                at: clock.now().toISOString(),
                status: "open",
                resolution: null,
                replies: [],
            }
            comments.set(c.id, { task_id: id, ...c })
            return c
        },
        async setCommentStatus(id, cid, { status, resolution }) {
            const c = comments.get(cid)
            if (!c || c.task_id !== id) throw new NotFoundError("comment")
            Object.assign(c, { status, resolution })
            return c
        },
        async listComments(id) {
            return [...comments.values()].filter((c) => c.task_id === id)
        },
        async listFeedback() {
            return []
        },
        async listEvents(id, opts) {
            return [{ type: "created", id, opts }]
        },
        async getHistory(id, { limit }) {
            get(id)
            return [
                { sha: "abc123", at: "x", actor: "me", message: `m ${limit}` },
            ]
        },
        async getCommitDiff(id, sha) {
            return `diff ${id} ${sha}`
        },
        async query(q) {
            store.calls.push(["query", q])
            let list = [...tasks.values()].map((v) => v.task)
            if (q.status) list = list.filter((t) => q.status.includes(t.status))
            return { tasks: list, total: list.length }
        },
        async board(opts) {
            store.calls.push(["board", opts])
            const lanes = {
                now: [],
                active: [],
                prs: [],
                ready: [],
                inbox: [],
                waiting: [],
                done: [],
            }
            for (const { task } of tasks.values())
                lanes[laneOf(task)].push(task)
            return lanes
        },
        async reindex() {
            return { count: tasks.size }
        },
    }
    return store
}

export function createFakeDevicesRepo({ clock }) {
    const devices = []
    const codes = new Map()
    return {
        devices,
        codes,
        add({ name, tokenHash }) {
            const d = {
                id: devices.length + 1,
                name,
                token_hash: tokenHash,
                created_at: clock.now().toISOString(),
                last_seen_at: null,
                revoked_at: null,
            }
            devices.push(d)
            return d
        },
        findByTokenHash(h) {
            return devices.find((d) => d.token_hash === h) || null
        },
        touch(id) {
            const d = devices.find((x) => x.id === id)
            if (d) d.last_seen_at = clock.now().toISOString()
        },
        list() {
            return devices
        },
        revoke(id) {
            const d = devices.find((x) => x.id === id)
            if (!d) return false
            d.revoked_at = clock.now().toISOString()
            return true
        },
        pairCodes: {
            add(hash, expiresAt) {
                codes.set(hash, { expiresAt, used: false })
            },
            consume(hash) {
                const c = codes.get(hash)
                if (!c || c.used) return false
                if (new Date(c.expiresAt) <= clock.now()) return false
                c.used = true
                return true
            },
        },
    }
}

export function createFakeSettingsRepo() {
    const map = new Map([["center.provider", "claude-sdk"]])
    return {
        map,
        get(k, def) {
            return map.has(k) ? map.get(k) : def
        },
        set(k, v) {
            map.set(k, v)
        },
        all() {
            return Object.fromEntries(map)
        },
    }
}

export function createFakeScheduler() {
    const schedules = []
    const s = {
        schedules,
        reminded: [],
        add(input) {
            const sch = {
                id: schedules.length + 1,
                status: "pending",
                ...input,
            }
            schedules.push(sch)
            return sch
        },
        cancel(id) {
            const sch = schedules.find((x) => x.id === id)
            if (!sch) return false
            sch.status = "cancelled"
            return true
        },
        listForTask(taskId) {
            return schedules.filter((x) => x.task_id === taskId)
        },
        remind(taskId, dueAt) {
            s.reminded.push([taskId, dueAt])
            return s.add({ task_id: taskId, fire_at: dueAt, action: "surface" })
        },
        reconciled: [],
        reconcileDue(taskId, dueAt, opts) {
            s.reconciled.push([taskId, dueAt, opts])
            return null
        },
    }
    return s
}

export function createFakeJobRunner() {
    const jobs = []
    return {
        jobs,
        enqueue(type, input, { task_id = null } = {}) {
            const job = {
                id: `j${jobs.length + 1}`,
                type,
                input,
                task_id,
                status: "queued",
            }
            jobs.push(job)
            return job
        },
        get(id) {
            return jobs.find((j) => j.id === id) || null
        },
        list({ task_id, status } = {}) {
            const statuses = status ? [].concat(status) : null
            return jobs.filter(
                (j) =>
                    j.task_id === task_id &&
                    (!statuses || statuses.includes(j.status))
            )
        },
        cancel(id) {
            const j = jobs.find((x) => x.id === id)
            if (!j || j.status !== "queued") return false
            j.status = "cancelled"
            return true
        },
    }
}

export const DUE = "2026-11-08T10:00:00.000Z"

export function createFakeDateParser() {
    return {
        parseCapture(text) {
            const m = /^remind me (?:to )?(.*?)(?: tomorrow)$/i.exec(text)
            if (m)
                return {
                    isReminder: true,
                    title: m[1].charAt(0).toUpperCase() + m[1].slice(1),
                    due_at: DUE,
                    matchedText: "tomorrow",
                }
            return {
                isReminder: false,
                title: text,
                due_at: null,
                matchedText: null,
            }
        },
        parseWhen(text) {
            if (text === "2h") return "2026-11-07T14:00:00.000Z"
            if (text === "tomorrow") return DUE
            return null
        },
    }
}

export function makeConfig(over = {}) {
    return {
        configDir: "/nonexistent/cc-test",
        webDist: null,
        publicBaseUrl: "https://mac.tail.ts.net:8443",
        owner: { tailscaleLogin: OWNER },
        listeners: {
            local: { host: "127.0.0.1", port: 7788 },
            tailnet: { host: "127.0.0.1", port: 7789 },
        },
        ...over,
    }
}

/** Host header the tailnet app accepts for a config (publicBaseUrl host). */
export function tailnetHost(config) {
    try {
        return new URL(config.publicBaseUrl).host
    } catch {
        return null
    }
}

const DEFAULT_HOSTS = new WeakMap()
const VERBS = ["get", "post", "put", "patch", "delete", "head", "options"]

/** Make `request(app)` send this Host unless a test sets another. */
export function setDefaultHost(app, host) {
    if (host) DEFAULT_HOSTS.set(app, host)
    return app
}

/**
 * supertest with the app's default Host (see setDefaultHost). Local apps
 * need none: supertest's 127.0.0.1:<port> already passes the host guard.
 */
export function request(app) {
    const agent = supertest(app)
    const host = DEFAULT_HOSTS.get(app)
    if (!host) return agent
    const out = {}
    for (const verb of VERBS)
        out[verb] = (...args) => agent[verb](...args).set("Host", host)
    return out
}

/** Build both apps over shared fakes. */
export function createHarness(over = {}) {
    const clock = createFakeClock()
    const bus = createBus({ clock })
    const store = createFakeStore({ bus, clock })
    const devicesRepo = createFakeDevicesRepo({ clock })
    const settingsRepo = createFakeSettingsRepo()
    const scheduler = createFakeScheduler()
    const jobRunner = createFakeJobRunner()
    const dateParser = createFakeDateParser()
    const config = makeConfig(over.config)
    const auth = createAuth({ config, devicesRepo, localToken: TOKEN, clock })
    const deps = {
        store,
        bus,
        jobRunner,
        scheduler,
        dateParser,
        settingsRepo,
        devicesRepo,
        auth,
        config,
        ...over.deps,
    }
    return {
        clock,
        bus,
        store,
        devicesRepo,
        settingsRepo,
        scheduler,
        jobRunner,
        dateParser,
        config,
        auth,
        local: createApp({ mode: "local", ...deps }),
        tailnet: setDefaultHost(
            createApp({ mode: "tailnet", ...deps }),
            tailnetHost(config)
        ),
    }
}

/** Shared task (has Asana) and a private one. */
export function seedTasks(store) {
    const shared = store.seed(
        makeTask(1, {
            title: "Shared",
            asana: {
                gid: "123",
                url: "https://app.asana.com/0/1/123",
                section_gid: null,
                no_section: false,
                attachments: [],
            },
            links: [
                {
                    id: "l1",
                    type: "pr",
                    url: "https://github.com/x/pull/1",
                    label: "PR",
                },
                {
                    id: "l2",
                    type: "slack",
                    url: "https://slack.com/x",
                    label: "s",
                },
            ],
        }),
        "# shared artifact"
    )
    const priv = store.seed(makeTask(2, { title: "Private", status: "ready" }))
    return { shared, priv }
}
