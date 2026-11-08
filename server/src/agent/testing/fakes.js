/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// In-memory fakes for center agent tests: jobsRepo, settingsRepo, store,
// providers. Shapes follow docs/implementation/contracts.md.

import { setSection } from "../../store/artifact.js"
import crypto from "node:crypto"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { NotFoundError, StaleRevisionError } from "../../util/errors.js"

export function createMemoryJobsRepo() {
    const rows = new Map()
    return {
        rows,
        insert(row) {
            rows.set(row.id, { ...row })
            return { ...row }
        },
        update(id, patch) {
            const row = rows.get(id)
            if (!row) throw new Error(`no job ${id}`)
            Object.assign(row, patch)
            return { ...row }
        },
        get(id) {
            const r = rows.get(id)
            return r ? { ...r } : null
        },
        list({ task_id, status, limit = 50 } = {}) {
            return [...rows.values()]
                .filter((r) => task_id == null || r.task_id === task_id)
                .filter((r) => !status || r.status === status)
                .slice(0, limit)
                .map((r) => ({ ...r }))
        },
        listByStatus(statuses) {
            return [...rows.values()]
                .filter((r) => statuses.includes(r.status))
                .map((r) => ({ ...r }))
        },
    }
}

export function createMemorySettingsRepo(initial = {}) {
    const map = new Map(Object.entries(initial))
    return {
        get(key, def) {
            return map.has(key) ? map.get(key) : def
        },
        set(key, value) {
            map.set(key, value)
        },
        all() {
            return Object.fromEntries(map)
        },
    }
}

export const TEMPLATE = (id, title) => `# T-${id} — ${title}

> **Source:** manual · **Area:** other

## Summary

## Context

## Acceptance

## Plan

## Decisions

## Progress

## Links

## PR feedback

## Result
`

export function makeTask(overrides = {}) {
    const id = overrides.id ?? 1
    return {
        id,
        title: "Do the thing",
        kind: "todo",
        area: "other",
        status: "inbox",
        prev_status: null,
        priority: 2,
        visibility: "auto",
        source: { type: "manual", url: null, text: "do the thing" },
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
        created_at: "2026-11-07T10:00:00.000Z",
        updated_at: "2026-11-07T10:00:00.000Z",
        done_at: null,
        ...overrides,
    }
}

const rev = (s) =>
    crypto.createHash("sha256").update(s).digest("hex").slice(0, 16)

// Same section logic as the real store, so expectations computed by
// applySectionEdits match what this fake writes.
function editSection(content, { section, op, content: body }) {
    return setSection(content, section, body, op)
}

/** Minimal in-memory store implementing the calls the agent makes. */
export function createFakeStore({ tasks = [], clock } = {}) {
    const state = new Map()
    let nextId = 1
    let commentSeq = 0
    const now = () => (clock ? clock.now() : new Date()).toISOString()
    const add = (task) => {
        state.set(task.id, {
            task: { ...task },
            artifact: TEMPLATE(task.id, task.title),
            comments: [],
            events: [],
        })
        nextId = Math.max(nextId, task.id + 1)
    }
    tasks.forEach(add)
    const need = (id) => {
        const s = state.get(id)
        if (!s) throw new NotFoundError(`task ${id}`)
        return s
    }
    const locks = new Map()
    const calls = []
    const store = {
        state,
        calls,
        async getTask(id) {
            const s = need(id)
            return {
                task: structuredClone(s.task),
                revision: rev(JSON.stringify(s.task)),
            }
        },
        async updateTask(id, patch, opts) {
            const s = need(id)
            calls.push(["updateTask", id, patch, opts])
            s.task = { ...s.task, ...structuredClone(patch), updated_at: now() }
            return {
                task: structuredClone(s.task),
                revision: rev(JSON.stringify(s.task)),
            }
        },
        async createTask(input, actor) {
            const id = nextId++
            calls.push(["createTask", input, actor])
            const task = makeTask({ id, ...input })
            add(task)
            return {
                task,
                revision: rev(JSON.stringify(task)),
                artifact: { content: state.get(id).artifact },
            }
        },
        async getArtifact(id) {
            const s = need(id)
            return { content: s.artifact, revision: rev(s.artifact) }
        },
        async setArtifact(id, content) {
            need(id).artifact = content
        },
        async updateArtifactSection(id, args, actor) {
            const s = need(id)
            calls.push(["updateArtifactSection", id, args, actor])
            if (
                (args.op === "replace" || args.baseRevision) &&
                args.baseRevision !== rev(s.artifact)
            ) {
                throw new StaleRevisionError({
                    content: s.artifact,
                    revision: rev(s.artifact),
                })
            }
            s.artifact = editSection(s.artifact, args)
            return { revision: rev(s.artifact) }
        },
        async appendComment(id, record, actor) {
            const s = need(id)
            const c = { ...record, id: `c_${++commentSeq}`, at: now() }
            calls.push(["appendComment", id, record, actor])
            if (record.parent_id) {
                const root = s.comments.find((t) => t.id === record.parent_id)
                if (root) root.replies.push(c)
                else
                    s.comments.push({
                        ...c,
                        status: "open",
                        resolution: null,
                        replies: [],
                    })
            } else {
                s.comments.push({
                    ...c,
                    status: "open",
                    resolution: null,
                    replies: [],
                })
            }
            return c
        },
        async setCommentStatus(id, commentId, { status, resolution }, actor) {
            const s = need(id)
            calls.push([
                "setCommentStatus",
                id,
                commentId,
                status,
                resolution,
                actor,
            ])
            const t = s.comments.find((c) => c.id === commentId)
            if (!t) throw new NotFoundError(`comment ${commentId}`)
            t.status = status
            t.resolution = resolution
            return t
        },
        async listComments(id) {
            return structuredClone(need(id).comments)
        },
        async appendEvent(id, ev, actor) {
            const e = { data: {}, ...ev, actor, at: now() }
            calls.push(["appendEvent", id, ev, actor])
            need(id).events.push(e)
            return e
        },
        async listEvents(id, { limit = 50 } = {}) {
            return structuredClone(need(id).events).reverse().slice(0, limit)
        },
        async board() {
            const lanes = {
                now: [],
                active: [],
                prs: [],
                ready: [],
                inbox: [],
                waiting: [],
                done: [],
            }
            for (const { task } of state.values()) {
                const lane = lanes[task.status] ? task.status : "done"
                lanes[lane].push(structuredClone(task))
            }
            return lanes
        },
        async withTaskLock(id, fn) {
            const prev = locks.get(id) || Promise.resolve()
            let release
            const next = new Promise((r) => (release = r))
            locks.set(
                id,
                prev.then(() => next)
            )
            await prev
            calls.push(["lock", id])
            try {
                return await fn()
            } finally {
                release()
            }
        },
    }
    return store
}

/**
 * Fake provider. handler(args, callIndex) returns output (object) or throws.
 * Records calls on .calls.
 */
export function fakeProvider(name, handler) {
    const calls = []
    return {
        name,
        calls,
        async run(args) {
            calls.push(args)
            const out = await handler(args, calls.length - 1)
            return {
                output: out,
                usage: { input_tokens: 1, output_tokens: 1 },
                model: args.model,
            }
        },
    }
}

/**
 * Fake child_process.spawn. script(child, bin, args, opts) drives the child:
 * write to child.stdout/stderr, then child.finish(code).
 */
export function fakeSpawn(script) {
    const calls = []
    const spawn = (bin, args, opts) => {
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdin = opts.stdio[0] === "pipe" ? new PassThrough() : null
        child.killed = false
        child.stdinText = ""
        if (child.stdin)
            child.stdin.on("data", (b) => (child.stdinText += b.toString()))
        child.kill = (sig) => {
            child.killed = sig
            setImmediate(() => child.emit("close", null, sig))
        }
        child.finish = (code = 0) => {
            setImmediate(() => child.emit("close", code, null))
        }
        calls.push({ bin, args, opts, child })
        setImmediate(() => script(child, bin, args, opts))
        return child
    }
    spawn.calls = calls
    return spawn
}

/** Wait for pending setImmediate/microtasks a few rounds. */
export async function flush(rounds = 5) {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r))
}

/** Poll until cond() is truthy (real timers), max ~2s. */
export async function waitFor(cond, { tries = 200 } = {}) {
    for (let i = 0; i < tries; i++) {
        if (cond()) return
        await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error("waitFor: condition not met")
}

/** Job ctx as the runner builds it. */
export function makeCtx({
    store,
    deps = {},
    input = {},
    task_id = 1,
    attempt = 1,
    clock,
    job,
} = {}) {
    return {
        job: job || { id: "j9", task_id, type: "test" },
        input,
        task_id,
        store,
        deps,
        actor: "center",
        clock: clock || { now: () => new Date("2026-11-07T12:00:00.000Z") },
        log: { info() {}, warn() {}, error() {}, debug() {} },
        attempt,
    }
}
