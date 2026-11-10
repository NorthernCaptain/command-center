/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { jest } from "@jest/globals"
import { createBus } from "../events/bus.js"
import { createFakeClock } from "../util/clock.js"
import {
    AppError,
    NotFoundError,
    StaleRevisionError,
    ValidationError,
} from "../util/errors.js"
import Database from "better-sqlite3"
import { MIGRATIONS, migrate, openDb } from "./db.js"
import { hashBytes } from "./fsutil.js"
import { getSectionBody, parseSections } from "./artifact.js"
import { createGitCommitter } from "./gitCommitter.js"
import { createStore, foldComments, ftsQuery } from "./store.js"

const run = promisify(execFile)
const exec = (cmd, args, opts) => run(cmd, args, opts)

let root
let dir
let db
let bus
let clock
let events
let log
let store

function makeStore(extra = {}) {
    return createStore({ tasksDir: dir, db, bus, clock, log, ...extra })
}

const read = (id, f) =>
    fs.readFileSync(
        path.join(dir, `T-${String(id).padStart(4, "0")}`, f),
        "utf8"
    )
const jsonl = (id, f) =>
    read(id, f)
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
const types = () => events.map((e) => e.type)

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-store-"))
    dir = path.join(root, "tasks")
    db = openDb(":memory:")
    clock = createFakeClock()
    bus = createBus({ clock })
    events = []
    bus.subscribe((e) => events.push(e))
    log = {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    }
    store = makeStore()
})
afterEach(() => {
    if (db.open) db.close()
    fs.rmSync(root, { recursive: true, force: true })
})

describe("helpers", () => {
    test("ftsQuery quotes terms and drops punctuation-only input", () => {
        expect(ftsQuery('cold "start" OR x*')).toBe(
            '"cold"* """start"""* "OR"* "x*"*'
        )
        expect(ftsQuery(" -- () ")).toBeNull()
        expect(ftsQuery(undefined)).toBeNull()
    })

    test("foldComments: replies, status, orphan replies, unknown status", () => {
        const at = "2026-11-07T12:00:00.000Z"
        const threads = foldComments([
            { op: "create", id: "a", parent_id: null, body: "root", at },
            { op: "create", id: "b", parent_id: "a", body: "reply", at },
            { op: "create", id: "c", parent_id: "b", body: "nested", at },
            { op: "create", id: "d", parent_id: "zz", body: "lost", at },
            { op: "status", id: "a", status: "resolved", resolution: "ok" },
            { op: "status", id: "nope", status: "resolved" },
        ])
        expect(threads.map((t) => t.id)).toEqual(["a", "d"])
        expect(threads[0].status).toBe("resolved")
        expect(threads[0].resolution).toBe("ok")
        expect(threads[0].replies.map((r) => r.id)).toEqual(["b", "c"])
        expect(threads[1].status).toBe("open")
    })
})

describe("createTask", () => {
    test("writes the task folder, template, index and events", async () => {
        const res = await store.createTask(
            {
                title: "Fix upload retry",
                kind: "agent_task",
                area: "infra",
                source: { type: "slack", url: "https://slack/x", text: "hi" },
                due_at: "2026-11-08T09:00:00+01:00",
            },
            "me"
        )
        expect(res.task).toMatchObject({
            id: 1,
            title: "Fix upload retry",
            status: "inbox",
            kind: "agent_task",
            area: "infra",
            created_at: "2026-11-07T12:00:00.000Z",
            updated_at: "2026-11-07T12:00:00.000Z",
        })
        const tdir = path.join(dir, "T-0001")
        expect(fs.readdirSync(tdir).sort()).toEqual([
            "artifact.md",
            "comments.jsonl",
            "events.jsonl",
            "feedback.jsonl",
            "task.json",
        ])
        expect(res.revision).toBe(
            hashBytes(fs.readFileSync(path.join(tdir, "task.json")))
        )
        expect(res.artifact.revision).toBe(hashBytes(read(1, "artifact.md")))
        expect(res.artifact.content).toMatch(/^# T-1 — Fix upload retry\n/)
        expect(
            parseSections(res.artifact.content).map((s) => s.name)
        ).toContain("Change record (SOC2)")
        expect(jsonl(1, "events.jsonl")).toEqual([
            {
                at: "2026-11-07T12:00:00.000Z",
                actor: "me",
                type: "created",
                data: { status: "inbox" },
            },
        ])
        expect(types()).toEqual(["task.created", "event.added"])
        expect(events[0].task_id).toBe(1)
        expect(events[0].data.task.id).toBe(1)
        const row = db.prepare("SELECT * FROM tasks_index WHERE id = 1").get()
        expect(row).toMatchObject({
            lane: "inbox",
            shared: 0,
            due_at: "2026-11-08T08:00:00.000Z",
        })
    })

    test("derives title and source from text/url; sequential ids", async () => {
        const a = await store.createTask(
            { text: "\n  remind me about Ron\nmore", source_type: "phone" },
            "me"
        )
        expect(a.task.title).toBe("remind me about Ron")
        expect(a.task.source).toEqual({
            type: "phone",
            url: null,
            text: "\n  remind me about Ron\nmore",
        })
        expect(
            parseSections(a.artifact.content).map((s) => s.name)
        ).not.toContain("Change record (SOC2)")
        const b = await store.createTask({ url: "https://asana/1" }, "center")
        expect(b.task).toMatchObject({
            id: 2,
            title: "https://asana/1",
            source: { type: "manual", url: "https://asana/1", text: null },
        })
        const c = await store.createTask(
            { title: "Closed", status: "done", priority: 1 },
            "me"
        )
        expect(c.task.done_at).toBe("2026-11-07T12:00:00.000Z")
        expect(c.task.priority).toBe(1)
    })

    test("validation errors leave no folder behind", async () => {
        await expect(
            store.createTask({ title: "x" }, "bob")
        ).rejects.toBeInstanceOf(ValidationError)
        await expect(
            store.createTask({ title: "x", kind: "nope" }, "me")
        ).rejects.toBeInstanceOf(ValidationError)
        await expect(store.createTask({}, "me")).rejects.toBeInstanceOf(
            ValidationError
        )
        await expect(store.createTask(null, "me")).rejects.toBeInstanceOf(
            ValidationError
        )
        expect(fs.readdirSync(dir)).toEqual([])
    })

    test("ids continue after existing folders; concurrent creates", async () => {
        fs.mkdirSync(path.join(dir, "T-0007"))
        fs.mkdirSync(path.join(dir, "notes"))
        const s2 = makeStore()
        const created = await Promise.all(
            [1, 2, 3, 4].map((i) => s2.createTask({ title: `t${i}` }, "me"))
        )
        expect(created.map((c) => c.task.id).sort((a, b) => a - b)).toEqual([
            8, 9, 10, 11,
        ])
    })

    test("skips a folder that appeared after startup", async () => {
        fs.mkdirSync(path.join(dir, "T-0001"))
        const res = await store.createTask({ title: "x" }, "me")
        expect(res.task.id).toBe(2)
    })
})

describe("getTask", () => {
    test("reads with revision; id forms; errors", async () => {
        const { task, revision } = await store.createTask({ title: "a" }, "me")
        expect(await store.getTask(1)).toEqual({ task, revision })
        expect((await store.getTask("1")).task.id).toBe(1)
        expect((await store.getTask("T-1")).task.id).toBe(1)
        await expect(store.getTask(2)).rejects.toBeInstanceOf(NotFoundError)
        await expect(store.getTask(0)).rejects.toBeInstanceOf(ValidationError)
        await expect(store.getTask("abc")).rejects.toBeInstanceOf(
            ValidationError
        )
    })

    test("corrupt task.json -> corrupt_task", async () => {
        await store.createTask({ title: "a" }, "me")
        const f = path.join(dir, "T-0001", "task.json")
        fs.writeFileSync(f, "{not json")
        await expect(store.getTask(1)).rejects.toMatchObject({
            code: "corrupt_task",
            status: 500,
        })
        fs.writeFileSync(f, JSON.stringify({ id: 1 }))
        await expect(store.getTask(1)).rejects.toMatchObject({
            code: "corrupt_task",
        })
    })
})

describe("updateTask", () => {
    beforeEach(async () => {
        await store.createTask({ title: "Task", status: "ready" }, "me")
        events.length = 0
    })

    test("merges nested objects, bumps updated_at, records event", async () => {
        await clock.advance(60000)
        const res = await store.updateTask(
            1,
            { flags: { now: true, now_reason: "ping" }, priority: 0 },
            { actor: "center", reason: "scheduler" }
        )
        expect(res.task.flags).toEqual({
            enriching: false,
            now: true,
            now_reason: "ping",
            error: null,
        })
        expect(res.task.updated_at).toBe("2026-11-07T12:01:00.000Z")
        expect(res.revision).toBe(hashBytes(read(1, "task.json")))
        expect(types()).toEqual(["task.updated", "event.added"])
        expect(events[0].data.changed).toEqual(["priority", "flags"])
        expect(jsonl(1, "events.jsonl")[1]).toMatchObject({
            actor: "center",
            type: "updated",
            data: { changed: ["priority", "flags"], reason: "scheduler" },
        })
        const row = db
            .prepare("SELECT lane FROM tasks_index WHERE id = 1")
            .get()
        expect(row.lane).toBe("now")
    })

    test("waiting sets prev_status; done sets done_at; reopen clears", async () => {
        let r = await store.updateTask(
            1,
            { status: "waiting", snooze_until: "2026-11-08T09:00:00Z" },
            { actor: "me" }
        )
        expect(r.task.prev_status).toBe("ready")
        expect(events[0].data.changed).toEqual(
            expect.arrayContaining(["status", "prev_status", "snooze_until"])
        )
        expect(jsonl(1, "events.jsonl")[1].data).toMatchObject({
            from: "ready",
            to: "waiting",
        })
        r = await store.updateTask(1, { status: "active" }, { actor: "me" })
        expect(r.task.prev_status).toBeNull()
        await clock.advance(1000)
        r = await store.updateTask(1, { status: "done" }, { actor: "me" })
        expect(r.task.done_at).toBe("2026-11-07T12:00:01.000Z")
        r = await store.updateTask(1, { status: "ready" }, { actor: "me" })
        expect(r.task.done_at).toBeNull()
        r = await store.updateTask(
            1,
            { status: "done", done_at: "2026-11-01T00:00:00Z" },
            { actor: "me" }
        )
        expect(r.task.done_at).toBe("2026-11-01T00:00:00Z")
    })

    test("closing a task clears its Now flag unless the patch sets it", async () => {
        await store.updateTask(1, { status: "active" }, { actor: "me" })
        await store.updateTask(
            1,
            {
                status: "review",
                flags: {
                    now: true,
                    now_reason: "Ready for review",
                    error: "x",
                },
            },
            { actor: "me" }
        )
        let r = await store.updateTask(1, { status: "done" }, { actor: "me" })
        expect(r.task.flags).toMatchObject({
            now: false,
            now_reason: null,
            error: "x", // other flags stay
        })
        // reopened, flagged again, cancelled: cleared too
        await store.updateTask(1, { status: "ready" }, { actor: "me" })
        await store.updateTask(
            1,
            { flags: { now: true, now_reason: "Agent needs you" } },
            { actor: "me" }
        )
        r = await store.updateTask(1, { status: "cancelled" }, { actor: "me" })
        expect(r.task.flags.now).toBe(false)
        // a patch that closes and sets the flag keeps what it sets
        await store.updateTask(1, { status: "ready" }, { actor: "me" })
        r = await store.updateTask(
            1,
            {
                status: "done",
                flags: { now: true, now_reason: "Check the close-out" },
            },
            { actor: "me" }
        )
        expect(r.task.flags).toMatchObject({
            now: true,
            now_reason: "Check the close-out",
        })
        // a non-closing status change leaves the flag alone
        await store.updateTask(1, { status: "ready" }, { actor: "me" })
        r = await store.updateTask(1, { status: "active" }, { actor: "me" })
        expect(r.task.flags.now).toBe(true)
    })

    test("prev_status is service-owned (regression)", async () => {
        for (const prev of ["done", "active", null]) {
            await expect(
                store.updateTask(
                    1,
                    { status: "waiting", prev_status: prev },
                    { actor: "me" }
                )
            ).rejects.toThrow(/prev_status/)
        }
        await expect(
            store.updateTask(1, { prev_status: "done" }, { actor: "me" })
        ).rejects.toBeInstanceOf(ValidationError)
        // Internal override still only accepts open, non-waiting statuses.
        for (const prev of ["done", "cancelled", "waiting"]) {
            await expect(
                store.updateTask(
                    1,
                    { status: "waiting", prev_status: prev },
                    { actor: "me", allowPrevStatus: true }
                )
            ).rejects.toBeInstanceOf(ValidationError)
        }
        expect((await store.getTask(1)).task.status).toBe("ready")
        let r = await store.updateTask(
            1,
            { status: "waiting", prev_status: "active" },
            { actor: "system", allowPrevStatus: true }
        )
        expect(r.task.prev_status).toBe("active")
        // Snoozing again while waiting keeps the recorded status.
        r = await store.updateTask(
            1,
            { snooze_until: "2026-11-09T09:00:00Z" },
            { actor: "me" }
        )
        expect(r.task.prev_status).toBe("active")
        r = await store.updateTask(
            1,
            { prev_status: null },
            { actor: "system", allowPrevStatus: true }
        )
        expect(r.task.prev_status).toBeNull()
        r = await store.updateTask(1, { status: "done" }, { actor: "me" })
        expect(r.task.prev_status).toBeNull()
        // A create cannot smuggle it in either.
        const c = await store.createTask(
            { title: "W", status: "waiting", prev_status: "done" },
            "me"
        )
        expect(c.task.prev_status).toBeNull()
    })

    test("done with unmerged deliverables -> 409 deliverables_open", async () => {
        const d = (over) => ({
            repo: "aws-lambda",
            branch: "t1-x",
            role: "work",
            created_at: "2026-11-07T10:00:00.000Z",
            disposition: "pr",
            ...over,
        })
        // set in the same patch as done: checked on the merged task
        const err = await store
            .updateTask(
                1,
                { status: "done", deliverables: [d({})] },
                { actor: "me" }
            )
            .catch((e) => e)
        expect(err).toMatchObject({ code: "deliverables_open", status: 409 })
        expect(err.message).toMatch(/aws-lambda@t1-x/)
        expect((await store.getTask(1)).task.status).toBe("ready")
        const ok = await store.updateTask(
            1,
            {
                status: "done",
                deliverables: [
                    d({ merged_at: "2026-11-07T11:00:00.000Z" }),
                    d({ repo: "ios", disposition: "no_change" }),
                ],
            },
            { actor: "me" }
        )
        expect(ok.task.status).toBe("done")
    })

    test("illegal transitions -> 409 illegal_transition", async () => {
        const err = await store
            .updateTask(1, { status: "review" }, { actor: "me" })
            .catch((e) => e)
        expect(err).toBeInstanceOf(AppError)
        expect(err).toMatchObject({
            code: "illegal_transition",
            status: 409,
            details: { from: "ready", to: "review" },
        })
    })

    test("baseRevision mismatch -> StaleRevisionError with current", async () => {
        const cur = await store.getTask(1)
        await store.updateTask(
            1,
            { priority: 1 },
            { actor: "me", baseRevision: cur.revision }
        )
        const err = await store
            .updateTask(
                1,
                { priority: 3 },
                { actor: "me", baseRevision: cur.revision }
            )
            .catch((e) => e)
        expect(err).toBeInstanceOf(StaleRevisionError)
        expect(err.current.task.priority).toBe(1)
    })

    test("rejects bad patches and actors", async () => {
        await expect(
            store.updateTask(1, { id: 5 }, { actor: "me" })
        ).rejects.toThrow(/not patchable/)
        await expect(
            store.updateTask(1, { status: "zzz" }, { actor: "me" })
        ).rejects.toBeInstanceOf(ValidationError)
        await expect(
            store.updateTask(1, [], { actor: "me" })
        ).rejects.toBeInstanceOf(ValidationError)
        await expect(
            store.updateTask(1, { priority: 1 })
        ).rejects.toBeInstanceOf(ValidationError)
        await expect(
            store.updateTask(1, { flags: { now: "yes" } }, { actor: "me" })
        ).rejects.toBeInstanceOf(ValidationError)
        await expect(
            store.updateTask(9, { priority: 1 }, { actor: "me" })
        ).rejects.toBeInstanceOf(NotFoundError)
    })

    test("no-op patch writes nothing", async () => {
        const before = await store.getTask(1)
        const res = await store.updateTask(
            1,
            { title: "Task", priority: undefined },
            { actor: "me" }
        )
        expect(res).toEqual(before)
        expect(events).toEqual([])
    })

    test("title change rewrites the artifact title line", async () => {
        const res = await store.updateTask(
            1,
            { title: "Better" },
            { actor: "center" }
        )
        const art = await store.getArtifact(1)
        expect(art.content).toMatch(/^# T-1 — Better\n/)
        expect(types()).toEqual([
            "task.updated",
            "artifact.updated",
            "event.added",
        ])
        expect(events[1].data).toEqual({
            revision: art.revision,
            actor: "center",
            sections: [],
        })
        expect(res.task.title).toBe("Better")
        // A custom first line is left alone.
        await store.writeArtifact(1, "# Mine\n", {
            actor: "me",
            baseRevision: art.revision,
        })
        events.length = 0
        await store.updateTask(1, { title: "Again" }, { actor: "me" })
        expect(types()).toEqual(["task.updated", "event.added"])
    })
})

describe("artifact", () => {
    let rev
    beforeEach(async () => {
        rev = (await store.createTask({ title: "Art" }, "me")).artifact.revision
        events.length = 0
    })

    test("writeArtifact requires and checks baseRevision", async () => {
        await expect(
            store.writeArtifact(1, "x", { actor: "me" })
        ).rejects.toBeInstanceOf(ValidationError)
        await expect(
            store.writeArtifact(1, 5, { actor: "me", baseRevision: rev })
        ).rejects.toBeInstanceOf(ValidationError)
        const err = await store
            .writeArtifact(1, "x", { actor: "me", baseRevision: "0000" })
            .catch((e) => e)
        expect(err).toBeInstanceOf(StaleRevisionError)
        expect(err.current).toEqual(await store.getArtifact(1))

        const same = await store.writeArtifact(1, read(1, "artifact.md"), {
            actor: "me",
            baseRevision: rev,
        })
        expect(same.revision).toBe(rev)
        expect(events).toEqual([])

        const { revision } = await store.writeArtifact(
            1,
            "# T-1 — Art\n\nzebra content\n",
            { actor: "me", baseRevision: rev }
        )
        expect(revision).toBe(hashBytes("# T-1 — Art\n\nzebra content\n"))
        expect(events[0]).toMatchObject({
            type: "artifact.updated",
            data: { revision, actor: "me" },
        })
        expect(store.query({ q: "zebra" }).total).toBe(1)
        await expect(
            store.writeArtifact(1, "x".repeat(3 * 1024 * 1024), {
                actor: "me",
                baseRevision: revision,
            })
        ).rejects.toThrow(/large/)
        await expect(
            store.writeArtifact(5, "x", { actor: "me", baseRevision: rev })
        ).rejects.toBeInstanceOf(NotFoundError)
        await expect(store.getArtifact(5)).rejects.toBeInstanceOf(NotFoundError)
    })

    test("missing artifact.md reads as empty", async () => {
        fs.rmSync(path.join(dir, "T-0001", "artifact.md"))
        expect(await store.getArtifact(1)).toEqual({
            content: "",
            revision: hashBytes(""),
        })
    })

    test("updateArtifactSection replace/append and validation", async () => {
        await expect(
            store.updateArtifactSection(
                1,
                { section: "Summary", op: "replace", content: "x" },
                "me"
            )
        ).rejects.toThrow(/base_revision/)
        for (const bad of [
            { section: "", op: "append", content: "x" },
            { section: "a\nb", op: "append", content: "x" },
            { section: "## X", op: "append", content: "x" },
            { section: 5, op: "append", content: "x" },
            { section: "X", op: "delete", content: "x" },
            { section: "X", op: "append", content: null },
        ]) {
            await expect(
                store.updateArtifactSection(1, bad, "me")
            ).rejects.toBeInstanceOf(ValidationError)
        }
        await expect(
            store.updateArtifactSection(1, undefined, "me")
        ).rejects.toBeInstanceOf(ValidationError)

        const r1 = await store.updateArtifactSection(
            1,
            {
                section: "Summary",
                op: "replace",
                content: "The gist.",
                baseRevision: rev,
            },
            "center"
        )
        expect(events[0].data).toEqual({
            revision: r1.revision,
            actor: "center",
            sections: ["Summary"],
        })
        await expect(
            store.updateArtifactSection(
                1,
                {
                    section: "Summary",
                    op: "append",
                    content: "x",
                    baseRevision: rev,
                },
                "me"
            )
        ).rejects.toBeInstanceOf(StaleRevisionError)
        await store.updateArtifactSection(
            1,
            { section: " Notes ", op: "append", content: "- n1" },
            "agent:w1"
        )
        const { content } = await store.getArtifact(1)
        expect(getSectionBody(content, "Summary")).toBe("The gist.")
        const names = (await store.listSections(1)).map((s) => s.name)
        expect(names.slice(-2)).toEqual(["Notes", "Result"])
        const same = await store.updateArtifactSection(
            1,
            { section: "Notes", op: "append", content: "" },
            "me"
        )
        expect(same.revision).toBe(hashBytes(content))
    })
})

describe("comments, feedback, events", () => {
    beforeEach(async () => {
        await store.createTask({ title: "C" }, "me")
        events.length = 0
    })

    test("threads, replies and status", async () => {
        const root = await store.appendComment(
            1,
            {
                body: "Why is the lambda slow?",
                intent: "ask",
                anchor: { section: "Summary", exact: "slow" },
                id: "ignored",
            },
            "me"
        )
        expect(root).toMatchObject({
            id: expect.stringMatching(/^c_[0-9a-f]{12}$/),
            op: "create",
            author: "me",
            parent_id: null,
            status: "open",
            resolution: null,
            replies: [],
            anchor: {
                section: "Summary",
                exact: "slow",
                prefix: "",
                suffix: "",
            },
        })
        expect(events[0]).toMatchObject({
            type: "comment.added",
            data: { comment: root },
        })
        const reply = await store.appendComment(
            1,
            {
                body: "Cold start.",
                intent: "chat",
                parent_id: root.id,
                author: "center",
                job_id: "j_1",
            },
            "center"
        )
        expect(reply).not.toHaveProperty("replies")
        const nested = await store.appendComment(
            1,
            {
                body: "ok",
                intent: "note",
                parent_id: reply.id,
            },
            "me"
        )
        expect(nested.parent_id).toBe(root.id)
        await expect(
            store.appendComment(
                1,
                { body: "x", intent: "note", parent_id: "c_missing" },
                "me"
            )
        ).rejects.toBeInstanceOf(NotFoundError)
        await expect(
            store.appendComment(1, { body: "", intent: "note" }, "me")
        ).rejects.toBeInstanceOf(ValidationError)
        await expect(
            store.appendComment(1, "text", "me")
        ).rejects.toBeInstanceOf(ValidationError)

        events.length = 0
        const resolved = await store.setCommentStatus(
            1,
            reply.id,
            { status: "resolved", resolution: "answered" },
            "center"
        )
        expect(resolved).toMatchObject({
            id: root.id,
            status: "resolved",
            resolution: "answered",
        })
        expect(resolved.replies).toHaveLength(2)
        expect(events[0]).toMatchObject({
            type: "comment.updated",
            data: { comment: resolved },
        })
        await store.setCommentStatus(1, root.id, { status: "open" }, "me")
        await expect(
            store.setCommentStatus(1, "nope", { status: "open" }, "me")
        ).rejects.toBeInstanceOf(NotFoundError)
        await expect(
            store.setCommentStatus(1, root.id, { status: "weird" }, "me")
        ).rejects.toBeInstanceOf(ValidationError)
        await expect(
            store.setCommentStatus(1, root.id, undefined, "me")
        ).rejects.toBeInstanceOf(ValidationError)

        const threads = await store.listComments(1)
        expect(threads).toHaveLength(1)
        expect(threads[0].status).toBe("open")
        expect(store.query({ q: "lambda" }).total).toBe(1)
        expect(store.query({ q: "cold start" }).total).toBe(1)
    })

    test("bad jsonl lines are skipped with a warning", async () => {
        fs.appendFileSync(
            path.join(dir, "T-0001", "comments.jsonl"),
            '{torn\n{"op":"create"}\n'
        )
        expect(await store.listComments(1)).toEqual([])
        expect(log.warn).toHaveBeenCalledTimes(2)
        await expect(store.listComments(2)).rejects.toBeInstanceOf(
            NotFoundError
        )
    })

    test("feedback: latest per id wins, order of first appearance", async () => {
        const base = {
            pr: "https://gh/pr/1",
            round: 1,
            kind: "review_comment",
            url: "https://gh/c/1",
            actionable: true,
            status: "open",
        }
        const a = await store.appendFeedback(1, { ...base, id: "f1" })
        expect(a.at).toBe("2026-11-07T12:00:00.000Z")
        await store.appendFeedback(1, { ...base, id: "f2" }, "agent:w1")
        await store.appendFeedback(1, {
            ...base,
            id: "f1",
            status: "fixed",
            commit: "abc",
        })
        const list = await store.listFeedback(1)
        expect(list.map((f) => [f.id, f.status])).toEqual([
            ["f1", "fixed"],
            ["f2", "open"],
        ])
        await expect(
            store.appendFeedback(1, { id: "x" })
        ).rejects.toBeInstanceOf(ValidationError)
    })

    test("appendEvent / listEvents newest first", async () => {
        const ev = await store.appendEvent(
            1,
            { type: "agent.report", data: { ok: true } },
            "agent:w1"
        )
        expect(ev).toEqual({
            at: "2026-11-07T12:00:00.000Z",
            actor: "agent:w1",
            type: "agent.report",
            data: { ok: true },
        })
        expect(events[0]).toMatchObject({
            type: "event.added",
            data: { event: ev },
        })
        await store.appendEvent(1, { type: "ping" }, "system")
        const list = await store.listEvents(1)
        expect(list.map((e) => e.type)).toEqual([
            "ping",
            "agent.report",
            "created",
        ])
        expect(await store.listEvents(1, { limit: 1 })).toHaveLength(1)
        expect(await store.listEvents(1, { limit: "x" })).toEqual([])
        await expect(
            store.appendEvent(1, { type: "" }, "me")
        ).rejects.toBeInstanceOf(ValidationError)
        await expect(
            store.appendEvent(1, undefined, "me")
        ).rejects.toBeInstanceOf(ValidationError)
    })
})

describe("locking", () => {
    test("withTaskLock is re-entrant for store calls", async () => {
        await store.createTask({ title: "L", status: "ready" }, "me")
        const res = await store.withTaskLock(1, async () => {
            const { task } = await store.getTask(1)
            return store.updateTask(
                1,
                { priority: task.priority - 1 },
                { actor: "center" }
            )
        })
        expect(res.task.priority).toBe(1)
    })

    test("concurrent writers with the same base: one wins, one is stale", async () => {
        const { artifact } = await store.createTask({ title: "L" }, "me")
        const results = await Promise.allSettled([
            store.writeArtifact(1, "a\n", {
                actor: "me",
                baseRevision: artifact.revision,
            }),
            store.writeArtifact(1, "b\n", {
                actor: "center",
                baseRevision: artifact.revision,
            }),
        ])
        expect(results.map((r) => r.status).sort()).toEqual([
            "fulfilled",
            "rejected",
        ])
    })

    test("bus listeners run outside the lock and may call the store", async () => {
        const seen = []
        bus.subscribe((e) => {
            if (e.type !== "task.created") return
            seen.push(
                store.updateTask(
                    e.task_id,
                    { priority: 0 },
                    { actor: "system" }
                )
            )
        })
        bus.subscribe(() => {
            throw new Error("bad listener")
        })
        await store.createTask({ title: "x" }, "me")
        const r = await seen[0]
        expect(r.task.priority).toBe(0)
        expect(log.warn).toHaveBeenCalled()
    })
})

describe("query and board", () => {
    async function seed() {
        const mk = async (input, patch) => {
            const { task } = await store.createTask(input, "me")
            await clock.advance(1000)
            if (patch) await store.updateTask(task.id, patch, { actor: "me" })
            await clock.advance(1000)
            return task.id
        }
        const ids = {}
        ids.inbox = await mk({ title: "Inbox alpha", area: "web" })
        ids.ready = await mk({
            title: "Ready beta",
            status: "ready",
            kind: "agent_task",
        })
        ids.active = await mk({
            title: "Active gamma",
            status: "active",
            visibility: "shared",
        })
        ids.pr = await mk(
            { title: "PR delta", status: "active" },
            { status: "ready_for_pr" }
        )
        ids.now = await mk(
            { title: "Now eps", status: "ready" },
            { flags: { now: true } }
        )
        ids.w1 = await mk(
            { title: "Wait late", status: "ready" },
            { status: "waiting", snooze_until: "2026-11-20T00:00:00Z" }
        )
        ids.w2 = await mk(
            {
                title: "Wait soon",
                status: "ready",
                due_at: "2026-11-10T00:00:00Z",
            },
            { status: "waiting" }
        )
        ids.w3 = await mk(
            { title: "Wait none", status: "ready" },
            { status: "waiting" }
        )
        ids.w4 = await mk(
            {
                title: "Wait both",
                status: "ready",
                due_at: "2026-11-30T00:00:00Z",
            },
            { status: "waiting", snooze_until: "2026-11-09T00:00:00Z" }
        )
        ids.w5 = await mk(
            { title: "Wait none 2", status: "ready" },
            { status: "waiting" }
        )
        ids.done = await mk(
            { title: "Done zeta", status: "ready" },
            { status: "done" }
        )
        ids.cancelled = await mk(
            { title: "Cancelled eta", status: "ready" },
            { status: "cancelled" }
        )
        ids.old = await mk({
            title: "Old done",
            status: "done",
            done_at: "2026-10-01T00:00:00Z",
        })
        return ids
    }

    test("query filters, FTS and pagination", async () => {
        const ids = await seed()
        const all = store.query()
        expect(all.total).toBe(13)
        expect(all.tasks[0].id).toBe(ids.old)
        expect(
            store.query({ status: ["ready"] }).tasks.map((t) => t.id)
        ).toEqual([ids.now, ids.ready])
        expect(store.query({ status: "inbox,active" }).total).toBe(2)
        expect(store.query({ area: "web" }).tasks[0].id).toBe(ids.inbox)
        expect(store.query({ kind: ["agent_task"] }).total).toBe(1)
        expect(store.query({ lane: "waiting" }).total).toBe(5)
        expect(
            store.query({ shared_only: true }).tasks.map((t) => t.id)
        ).toEqual([ids.active])
        expect(store.query({ done_since: "2026-11-01T00:00:00Z" }).total).toBe(
            1
        )
        expect(() => store.query({ done_since: "garbage" })).toThrow(
            ValidationError
        )
        expect(store.query({ q: "gam" }).tasks.map((t) => t.id)).toEqual([
            ids.active,
        ])
        expect(store.query({ q: "wait soon" }).tasks.map((t) => t.id)).toEqual([
            ids.w2,
        ])
        expect(
            store.query({ q: `T-${ids.pr}` }).tasks.map((t) => t.id)
        ).toContain(ids.pr)
        expect(
            store.query({ q: String(ids.ready) }).tasks.map((t) => t.id)
        ).toContain(ids.ready)
        expect(store.query({ q: '") OR (' }).total).toBe(0)
        expect(store.query({ q: "   " }).total).toBe(13)
        expect(store.query({ q: "NEAR(alpha" }).total).toBe(0)
        const page = store.query({ limit: 2, offset: 2 })
        expect(page.tasks).toHaveLength(2)
        expect(page.total).toBe(13)
        expect(store.query({ status: [], area: null }).total).toBe(13)
    })

    test("viewers cannot search private comment text or link labels (regression)", async () => {
        const { task } = await store.createTask(
            { title: "Shared plan", visibility: "shared" },
            "me"
        )
        const priv = await store.createTask({ title: "Private plan" }, "me")
        for (const id of [task.id, priv.task.id]) {
            await store.appendComment(
                id,
                { body: "zanzibar password hunter2", intent: "note" },
                "me"
            )
            await store.updateTask(
                id,
                {
                    links: [
                        {
                            id: "l1",
                            type: "pr",
                            url: "https://github.com/x/y/pull/1",
                            label: "quokka fix",
                            added_by: "me",
                            at: "2026-11-07T12:00:00.000Z",
                        },
                        {
                            id: "l2",
                            type: "slack",
                            url: "https://slack.com/x",
                            label: "wombat thread",
                            added_by: "me",
                            at: "2026-11-07T12:00:00.000Z",
                        },
                    ],
                },
                { actor: "me" }
            )
        }
        const { content, revision } = await store.getArtifact(task.id)
        await store.writeArtifact(task.id, `${content}\nplatypus notes\n`, {
            actor: "me",
            baseRevision: revision,
        })
        const ids = (params) => store.query(params).tasks.map((t) => t.id)
        const viewer = (q) => ids({ q, shared_only: true })
        // Owner searches every column.
        expect(ids({ q: "zanzi" }).sort()).toEqual([task.id, priv.task.id])
        expect(ids({ q: "wombat" }).sort()).toEqual([task.id, priv.task.id])
        expect(ids({ q: "platyp" })).toEqual([task.id])
        // Viewers only match title + public body.
        for (const q of ["zanzi", "hunter2", "pass", "wombat", "plan zanzibar"])
            expect(viewer(q)).toEqual([])
        expect(viewer("quokka")).toEqual([task.id])
        expect(viewer("platyp")).toEqual([task.id])
        expect(viewer("shared plan")).toEqual([task.id])
        expect(viewer(`T-${task.id}`)).toEqual([task.id])
        expect(viewer(`T-${priv.task.id}`)).toEqual([])
        // Quoting still neutralizes operators inside the column filter.
        expect(viewer('") OR (zanzibar')).toEqual([])
        expect(viewer("NEAR(zanzibar")).toEqual([])
        expect(viewer("title:zanzibar")).toEqual([])
    })

    test("board lanes and ordering", async () => {
        const ids = await seed()
        const b = store.board()
        expect(Object.keys(b)).toEqual([
            "now",
            "active",
            "prs",
            "ready",
            "inbox",
            "waiting",
            "done",
        ])
        expect(b.now.map((t) => t.id)).toEqual([ids.now])
        expect(b.active.map((t) => t.id)).toEqual([ids.active])
        expect(b.prs.map((t) => t.id)).toEqual([ids.pr])
        expect(b.ready.map((t) => t.id)).toEqual([ids.ready])
        expect(b.inbox.map((t) => t.id)).toEqual([ids.inbox])
        expect(b.waiting.map((t) => t.id)).toEqual([
            ids.w4,
            ids.w2,
            ids.w1,
            ids.w5,
            ids.w3,
        ])
        expect(b.done.map((t) => t.id)).toEqual([ids.cancelled, ids.done])
        expect(store.board({ done_days: 60 }).done.map((t) => t.id)).toContain(
            ids.old
        )
        const shared = store.board({ shared_only: true })
        expect(shared.active.map((t) => t.id)).toEqual([ids.active])
        expect(shared.waiting).toEqual([])
    })
})

describe("reindex and recover", () => {
    test("reindex rebuilds rows, drops missing tasks, skips bad ones", async () => {
        await store.createTask({ title: "one" }, "me")
        await store.createTask({ title: "two" }, "me")
        await store.createTask({ title: "three" }, "me")
        db.exec("DELETE FROM tasks_index; DELETE FROM tasks_fts")
        fs.rmSync(path.join(dir, "T-0002"), { recursive: true })
        fs.writeFileSync(path.join(dir, "T-0003", "task.json"), "{bad")
        fs.mkdirSync(path.join(dir, "T-0009"))
        db.prepare(
            `INSERT INTO tasks_index (id, title, kind, area, status,
                    visibility, lane, updated_at, created_at, json)
                 VALUES (42, 'ghost', 'todo', 'other', 'inbox', 'auto',
                    'inbox', 'x', 'x', '{}')`
        ).run()
        expect(await store.reindex()).toEqual({ count: 1 })
        expect(store.query().tasks.map((t) => t.title)).toEqual(["one"])
        expect(store.query({ q: "one" }).total).toBe(1)
        expect(log.warn).toHaveBeenCalled()
        const next = await store.createTask({ title: "four" }, "me")
        expect(next.task.id).toBe(10)
    })

    test("reindex keeps tasks created while it runs (regression)", async () => {
        await store.createTask({ title: "first" }, "me")
        // Hold T-0001's lock so reindex stalls after snapshotting folders.
        let release
        const gate = new Promise((r) => {
            release = r
        })
        const held = store.withTaskLock(1, () => gate)
        const running = store.reindex()
        await new Promise((r) => setImmediate(r))
        const created = await store.createTask({ title: "concurrent" }, "me")
        release()
        await held
        expect(await running).toEqual({ count: 2 })
        expect(store.query().tasks.map((t) => t.id)).toEqual([
            created.task.id,
            1,
        ])
        expect(store.query({ q: "concurrent" }).total).toBe(1)
    })

    test("reindex drops a row whose folder vanished while it ran", async () => {
        await store.createTask({ title: "a" }, "me")
        await store.createTask({ title: "b" }, "me")
        let release
        const gate = new Promise((r) => {
            release = r
        })
        const held = store.withTaskLock(1, () => gate)
        const running = store.reindex()
        await new Promise((r) => setImmediate(r))
        // T-0002 was in the snapshot; corrupt it before reindex reaches it.
        fs.writeFileSync(path.join(dir, "T-0002", "task.json"), "{bad")
        release()
        await held
        expect(await running).toEqual({ count: 1 })
        expect(store.query().tasks.map((t) => t.id)).toEqual([1])
    })

    test("recover repairs torn jsonl tails before appending (regression)", async () => {
        await store.createTask({ title: "torn" }, "me")
        const tdir = path.join(dir, "T-0001")
        fs.appendFileSync(
            path.join(tdir, "comments.jsonl"),
            '{"op":"create","id":"c_x","bo'
        )
        const ev = JSON.stringify({
            at: "2026-11-07T12:00:00.000Z",
            actor: "me",
            type: "note",
            data: {},
        })
        fs.appendFileSync(path.join(tdir, "events.jsonl"), ev)
        await store.recover()
        expect(read(1, "comments.jsonl")).toBe("")
        expect(read(1, "comments.jsonl.corrupt")).toBe(
            '{"op":"create","id":"c_x","bo\n'
        )
        expect(read(1, "events.jsonl").endsWith(`${ev}\n`)).toBe(true)
        expect(read(1, "feedback.jsonl")).toBe("")
        expect(log.warn).toHaveBeenCalledTimes(2)
        const c = await store.appendComment(
            1,
            { body: "after crash", intent: "note" },
            "me"
        )
        expect((await store.listComments(1)).map((t) => t.id)).toEqual([c.id])
        expect((await store.listEvents(1)).map((e) => e.type)).toEqual([
            "note",
            "created",
        ])
    })

    test("appends after a torn line without recover keep the new record", async () => {
        await store.createTask({ title: "torn" }, "me")
        fs.appendFileSync(path.join(dir, "T-0001", "comments.jsonl"), '{"op"')
        const c = await store.appendComment(
            1,
            { body: "kept", intent: "note" },
            "me"
        )
        expect((await store.listComments(1)).map((t) => t.id)).toEqual([c.id])
    })

    test("recover removes temp files and reindexes (no git)", async () => {
        await store.createTask({ title: "r" }, "me")
        const tdir = path.join(dir, "T-0001")
        fs.writeFileSync(path.join(tdir, ".task.json.aa.cctmp"), "x")
        fs.mkdirSync(path.join(tdir, "files"))
        fs.writeFileSync(path.join(tdir, "files", ".shot.png.bb.cctmp"), "x")
        fs.writeFileSync(path.join(tdir, "files", "shot.png"), "x")
        db.exec("DELETE FROM tasks_index")
        expect(await store.recover()).toEqual({
            committed: false,
            removedTemp: 2,
        })
        expect(fs.existsSync(path.join(tdir, "files", "shot.png"))).toBe(true)
        expect(store.query().total).toBe(1)
    })

    test("close flushes git and closes the db", async () => {
        const git = { touch: jest.fn(), flush: jest.fn(async () => {}) }
        const s = makeStore({ git })
        await s.close()
        expect(git.flush).toHaveBeenCalled()
        expect(db.open).toBe(false)
        await s.close()
    })
})

describe("FTS migration", () => {
    test("upgraded v1 db: owner search works, viewers see public only after recover", async () => {
        await store.createTask({ title: "Legacy", visibility: "shared" }, "me")
        await store.appendComment(1, { body: "zanzibar", intent: "note" }, "me")
        // Simulate a phase-1 (v1) db holding the old single-body index.
        const old = new Database(":memory:")
        migrate(old, MIGRATIONS.slice(0, 1))
        const rows = db.prepare("SELECT * FROM tasks_index").all()
        for (const r of rows) {
            old.prepare(
                `INSERT INTO tasks_index (id, title, kind, area, status,
                    visibility, shared, lane, updated_at, created_at, json)
                 VALUES (@id, @title, @kind, @area, @status, @visibility,
                    @shared, @lane, @updated_at, @created_at, @json)`
            ).run(r)
            old.prepare(
                "INSERT INTO tasks_fts (rowid, title, body) VALUES (?, ?, ?)"
            ).run(r.id, r.title, "artifact text\nzanzibar")
        }
        migrate(old)
        const s2 = makeStore({ db: old })
        expect(s2.query({ q: "zanzibar" }).total).toBe(1)
        expect(s2.query({ q: "zanzibar", shared_only: true }).total).toBe(0)
        expect(s2.query({ q: "acceptance", shared_only: true }).total).toBe(0)
        await s2.recover()
        expect(s2.query({ q: "zanzibar" }).total).toBe(1)
        expect(s2.query({ q: "zanzibar", shared_only: true }).total).toBe(0)
        expect(s2.query({ q: "acceptance", shared_only: true }).total).toBe(1)
        old.close()
    })
})

describe("with real git", () => {
    let git
    beforeEach(async () => {
        fs.mkdirSync(dir, { recursive: true })
        await run("git", ["init", "-q", "-b", "tasks"], { cwd: dir })
        git = createGitCommitter({
            tasksDir: dir,
            exec,
            clock,
            debounceMs: 15000,
            author: { name: "T", email: "t@t" },
            log,
        })
        await git.ensureRepo()
        store = makeStore({ git })
    })

    test("debounced commit, history and diff", async () => {
        await store.createTask({ title: "G" }, "me")
        const { artifact } = await store.createTask({ title: "H" }, "me")
        await store.updateTask(1, { status: "ready" }, { actor: "center" })
        await clock.advance(15000)
        const hist = await store.getHistory(1)
        expect(hist).toHaveLength(1)
        expect(hist[0]).toMatchObject({
            message: "T-0001: created; status → ready",
            actors: ["me", "center"],
        })
        expect(await store.getHistory(2, { limit: 5 })).toHaveLength(1)
        await store.writeArtifact(2, "new\n", {
            actor: "me",
            baseRevision: artifact.revision,
        })
        await store.close()
        const h2 = await store.getHistory(2)
        expect(h2[0].message).toBe("T-0002: edited artifact")
        const diff = await store.getCommitDiff(2, h2[0].sha)
        expect(diff).toContain("+new")
        await expect(store.getHistory(7)).rejects.toBeInstanceOf(NotFoundError)
        await expect(store.getCommitDiff(7, h2[0].sha)).rejects.toBeInstanceOf(
            NotFoundError
        )
    })

    test("recover commits repaired jsonl but never the .corrupt sidecar", async () => {
        await store.createTask({ title: "torn" }, "me")
        await store.close()
        fs.appendFileSync(path.join(dir, "T-0001", "comments.jsonl"), "{torn")
        const s2 = makeStore({
            db: openDb(":memory:"),
            git: createGitCommitter({ tasksDir: dir, exec, clock, log }),
        })
        expect(await s2.recover()).toEqual({ committed: false, removedTemp: 0 })
        const status = (
            await run("git", ["status", "--porcelain", "-uall"], { cwd: dir })
        ).stdout
        expect(status.trim()).toBe("?? T-0001/comments.jsonl.corrupt")
        await s2.close()
    })

    test("recover commits leftovers with Actor: recovery", async () => {
        await store.createTask({ title: "crash" }, "me")
        // Simulate a crash: pending debounce never fired.
        fs.writeFileSync(path.join(dir, "T-0001", ".artifact.md.x.cctmp"), "")
        const s2 = makeStore({
            git: createGitCommitter({ tasksDir: dir, exec, clock, log }),
        })
        expect(await s2.recover()).toEqual({ committed: true, removedTemp: 1 })
        const hist = await s2.getHistory(1)
        expect(hist[0]).toMatchObject({
            actor: "recovery",
            message: "T-0001: recovery commit",
        })
    })
})
