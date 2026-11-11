/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Task store: canonical files under tasks/T-xxxx/, the SQLite index and the
// debounced git committer. The store is the only writer of tasks/.
//
// Writes: per-task lock -> re-read + revision check -> atomic write ->
// index -> events.jsonl -> git.touch -> bus.emit.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
    ActorSchema,
    CommentCreateRecord,
    CommentRecordSchema,
    CommentStatusRecord,
    EventRecordSchema,
    FeedbackItemSchema,
    STATUSES,
    TaskPatchSchema,
    TaskSchema,
    taskDirName,
    taskKey,
} from "../contracts/schemas.js"
import {
    LANES,
    TransitionError,
    assertTransition,
    isShared,
    laneOf,
    openDeliverables,
} from "../contracts/lifecycle.js"
import {
    AppError,
    NotFoundError,
    StaleRevisionError,
    ValidationError,
} from "../util/errors.js"
import { systemClock } from "../util/clock.js"
import { nullLogger } from "../util/logger.js"
import {
    appendLine,
    atomicWrite,
    hashBytes,
    isTempFile,
    readJsonl,
    readOrNull,
    repairJsonlTail,
} from "./fsutil.js"
import {
    buildArtifactTemplate,
    parseSections,
    SOC2_AREAS,
    ensureChangeRecord,
    setSection,
    setTitleLine,
} from "./artifact.js"
import { createLockManager } from "./mutex.js"
import { toUtcIso } from "./db.js"

const TASK_DIR_RE = /^T-(\d+)$/
const GLOBAL_LOCK = "global"
const PATCH_KEYS = new Set(Object.keys(TaskPatchSchema.shape))
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
const JSONL_FILES = ["comments.jsonl", "feedback.jsonl", "events.jsonl"]

/** Link types whose labels viewers can see (matches viewerTask()). */
const PUBLIC_LINK_TYPES = new Set(["pr", "branch", "asana", "doc", "file"])

/** FTS columns a viewer may search (shared_only queries). */
const PUBLIC_FTS_COLUMNS = "{title public_body}"

/** Statuses a waiting task may resume to: open and not waiting. */
const RESUMABLE = new Set(
    STATUSES.filter((s) => !["waiting", "done", "cancelled"].includes(s))
)
// statuses that close a task (nothing left for Leo)
const CLOSED_STATUSES = new Set(["done", "cancelled"])

const NOOP_GIT = {
    touch() {},
    flush: async () => {},
    recoverUncommitted: async () => false,
    log: async () => [],
    diff: async () => "",
}

const isPlainObject = (v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)

function validate(schema, value, what) {
    const res = schema.safeParse(value)
    if (!res.success)
        throw new ValidationError(`invalid ${what}`, res.error.issues)
    return res.data
}

function toId(id) {
    const n = typeof id === "string" ? Number(id.replace(/^T-/i, "")) : id
    if (!Number.isInteger(n) || n <= 0)
        throw new ValidationError(`invalid task id: ${id}`)
    return n
}

function checkActor(actor) {
    return validate(ActorSchema, actor, "actor")
}

const serializeTask = (task) => `${JSON.stringify(task, null, 2)}\n`

const genId = (prefix) => `${prefix}${crypto.randomBytes(6).toString("hex")}`

/**
 * Quote every user term for FTS5 MATCH so operators/punctuation in the input
 * can never change the query syntax. Terms are ANDed and prefix-matched.
 */
export function ftsQuery(q) {
    const terms = String(q || "")
        .split(/\s+/)
        .filter((t) => /[\p{L}\p{N}]/u.test(t))
        .slice(0, 16)
    if (!terms.length) return null
    return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ")
}

/** Fold comments.jsonl records into threads (status: latest record wins). */
export function foldComments(records) {
    const threads = []
    const byId = new Map()
    for (const r of records) {
        if (r.op === "create") {
            const parent = r.parent_id ? byId.get(r.parent_id) : null
            if (parent) {
                parent.replies.push(r)
                byId.set(r.id, parent)
            } else {
                const thread = {
                    ...r,
                    status: "open",
                    resolution: null,
                    replies: [],
                }
                threads.push(thread)
                byId.set(r.id, thread)
            }
        } else if (r.op === "status") {
            const thread = byId.get(r.id)
            if (thread) {
                thread.status = r.status
                thread.resolution = r.resolution
            }
        }
    }
    return threads
}

function listParam(v) {
    if (v === undefined || v === null || v === "") return []
    if (Array.isArray(v)) return v.filter(Boolean).map(String)
    return String(v)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
}

function firstLine(text, max = 120) {
    if (!text) return null
    const line = String(text)
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean)
    return line ? line.slice(0, max) : null
}

export function createStore({
    tasksDir,
    db,
    bus,
    clock = systemClock,
    git = NOOP_GIT,
    log = nullLogger,
}) {
    const locks = createLockManager()
    const now = () => clock.now().toISOString()
    const dirOf = (id) => path.join(tasksDir, taskDirName(id))
    const fileOf = (id, name) => path.join(dirOf(id), name)

    fs.mkdirSync(tasksDir, { recursive: true })
    let nextId = scanMaxId() + 1

    const st = {
        upsert: db.prepare(
            `INSERT OR REPLACE INTO tasks_index (id, title, kind, area, status,
                visibility, shared, lane, priority, due_at, snooze_until,
                updated_at, created_at, done_at, json)
             VALUES (@id, @title, @kind, @area, @status, @visibility, @shared,
                @lane, @priority, @due_at, @snooze_until, @updated_at,
                @created_at, @done_at, @json)`
        ),
        ftsDelete: db.prepare("DELETE FROM tasks_fts WHERE rowid = ?"),
        ftsInsert: db.prepare(
            `INSERT INTO tasks_fts (rowid, title, public_body, private_body)
             VALUES (?, ?, ?, ?)`
        ),
        allIds: db.prepare("SELECT id FROM tasks_index"),
        deleteIndex: db.prepare("DELETE FROM tasks_index WHERE id = ?"),
    }

    const deleteRows = (id) => {
        st.deleteIndex.run(id)
        st.ftsDelete.run(id)
    }

    const writeIndex = db.transaction((task, publicBody, privateBody) => {
        st.upsert.run({
            id: task.id,
            title: task.title,
            kind: task.kind,
            area: task.area,
            status: task.status,
            visibility: task.visibility,
            shared: isShared(task) ? 1 : 0,
            lane: laneOf(task),
            priority: task.priority,
            due_at: toUtcIso(task.due_at),
            snooze_until: toUtcIso(task.snooze_until),
            updated_at: toUtcIso(task.updated_at),
            created_at: toUtcIso(task.created_at),
            done_at: toUtcIso(task.done_at),
            json: JSON.stringify(task),
        })
        st.ftsDelete.run(task.id)
        st.ftsInsert.run(task.id, task.title, publicBody, privateBody)
    })

    function scanMaxId() {
        let max = 0
        for (const name of fs.readdirSync(tasksDir)) {
            const m = TASK_DIR_RE.exec(name)
            if (m) max = Math.max(max, Number(m[1]))
        }
        return max
    }

    function taskDirs() {
        return fs
            .readdirSync(tasksDir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && TASK_DIR_RE.test(e.name))
            .map((e) => ({
                name: e.name,
                id: Number(TASK_DIR_RE.exec(e.name)[1]),
            }))
            .sort((a, b) => a.id - b.id)
    }

    function emit(type, taskId, data) {
        // Outside the lock context: listeners that call back into the store
        // must queue on the lock like everyone else.
        locks.outside(() => {
            try {
                bus.emit(type, { task_id: taskId, data })
            } catch (err) {
                log.warn({ err, type }, "bus listener failed")
            }
        })
    }

    const taskLock = (id, fn) => locks.withLock(`task:${id}`, fn)

    // ---- readers -------------------------------------------------------

    async function readTask(id) {
        const buf = await readOrNull(fileOf(id, "task.json"))
        if (!buf) throw new NotFoundError(`task ${taskKey(id)}`)
        let raw
        try {
            raw = JSON.parse(buf.toString("utf8"))
        } catch (err) {
            throw new AppError(
                "corrupt_task",
                `${taskKey(id)}: ${err.message}`,
                {
                    status: 500,
                }
            )
        }
        const res = TaskSchema.safeParse(raw)
        if (!res.success) {
            throw new AppError(
                "corrupt_task",
                `${taskKey(id)}: invalid task.json`,
                {
                    status: 500,
                    details: res.error.issues,
                }
            )
        }
        return { task: res.data, revision: hashBytes(buf) }
    }

    async function readArtifact(id) {
        const buf = await readOrNull(fileOf(id, "artifact.md"))
        const data = buf || Buffer.alloc(0)
        return { content: data.toString("utf8"), revision: hashBytes(data) }
    }

    async function readRecords(id, name, schema) {
        const onBad = () =>
            log.warn(
                { task: taskKey(id), file: name },
                "skipping bad jsonl line"
            )
        const out = []
        for (const rec of await readJsonl(fileOf(id, name), onBad)) {
            const res = schema.safeParse(rec)
            if (res.success) out.push(res.data)
            else onBad()
        }
        return out
    }

    const readThreads = async (id) =>
        foldComments(
            await readRecords(id, "comments.jsonl", CommentRecordSchema)
        )

    async function ensureTask(id) {
        const buf = await readOrNull(fileOf(id, "task.json"))
        if (!buf) throw new NotFoundError(`task ${taskKey(id)}`)
    }

    // ---- writers (call under the task lock) ----------------------------

    async function writeTaskFile(task) {
        const valid = validate(TaskSchema, task, "task")
        const data = serializeTask(valid)
        await atomicWrite(fileOf(valid.id, "task.json"), data)
        return { task: valid, revision: hashBytes(data) }
    }

    async function writeArtifactFile(id, content) {
        if (Buffer.byteLength(content) > MAX_ARTIFACT_BYTES)
            throw new ValidationError("artifact too large")
        await atomicWrite(fileOf(id, "artifact.md"), content)
        return hashBytes(content)
    }

    async function appendEventRecord(id, { type, data = {} }, actor) {
        const event = validate(
            EventRecordSchema,
            { at: now(), actor, type, data },
            "event"
        )
        await appendLine(fileOf(id, "events.jsonl"), JSON.stringify(event))
        return event
    }

    /**
     * Rebuild the index row + FTS columns of one task from disk. Viewers may
     * search only title + public_body (artifact text and labels of the link
     * types viewerTask() exposes); comments and other labels are private.
     */
    async function indexTask(id, task) {
        const t = task || (await readTask(id)).task
        const { content } = await readArtifact(id)
        const threads = await readThreads(id)
        const comments = threads.flatMap((th) => [th, ...th.replies])
        const labels = (pub) =>
            t.links
                .filter((l) => PUBLIC_LINK_TYPES.has(l.type) === pub)
                .map((l) => l.label)
                .filter(Boolean)
        const publicBody = [content, ...labels(true)].join("\n")
        const privateBody = [
            ...comments.map((c) => c.body),
            ...labels(false),
        ].join("\n")
        writeIndex(t, publicBody, privateBody)
        return t
    }

    function emitEvent(id, event) {
        emit("event.added", id, { event })
    }

    // ---- id allocation -------------------------------------------------

    function allocateId() {
        return locks.withLock(GLOBAL_LOCK, async () => {
            for (;;) {
                const id = nextId++
                try {
                    await fs.promises.mkdir(dirOf(id))
                    return id
                } catch (err) {
                    if (err.code !== "EEXIST") throw err
                }
            }
        })
    }

    // ---- public API ----------------------------------------------------

    async function createTask(input, actor) {
        checkActor(actor)
        if (!isPlainObject(input))
            throw new ValidationError("invalid task input")
        const at = now()
        const fields = {}
        for (const [k, v] of Object.entries(input))
            if (PATCH_KEYS.has(k) && k !== "prev_status" && v !== undefined)
                fields[k] = v
        const title =
            input.title || firstLine(input.text) || input.url || undefined
        const draft = {
            kind: "todo",
            area: "other",
            status: "inbox",
            ...fields,
            title,
            source: input.source || {
                type: input.source_type || "manual",
                url: input.url ?? null,
                text: input.text ?? null,
            },
            created_at: at,
            updated_at: at,
        }
        if (draft.status === "done" && !draft.done_at) draft.done_at = at
        validate(TaskSchema, { ...draft, id: 1 }, "task")

        const id = await allocateId()
        const result = await taskLock(id, async () => {
            const { task, revision } = await writeTaskFile({ ...draft, id })
            const content = buildArtifactTemplate(task)
            const artRev = await writeArtifactFile(id, content)
            for (const f of JSONL_FILES)
                await fs.promises.writeFile(fileOf(id, f), "", { flag: "a" })
            const event = await appendEventRecord(
                id,
                { type: "created", data: { status: task.status } },
                actor
            )
            await indexTask(id, task)
            git.touch(id, actor, "created")
            emit("task.created", id, { task })
            emitEvent(id, event)
            return {
                task,
                revision,
                artifact: { content, revision: artRev },
            }
        })
        return result
    }

    async function getTask(id) {
        return readTask(toId(id))
    }

    async function updateTask(rawId, patch, opts = {}) {
        const id = toId(rawId)
        const { actor, baseRevision, reason, allowPrevStatus = false } = opts
        checkActor(actor)
        if (!isPlainObject(patch)) throw new ValidationError("invalid patch")
        for (const k of Object.keys(patch)) {
            if (!PATCH_KEYS.has(k))
                throw new ValidationError(`field not patchable: ${k}`)
        }
        validate(TaskPatchSchema, patch, "patch")
        // prev_status is service-owned: recorded on entering "waiting",
        // cleared on leaving it. Only internal callers may set it explicitly.
        const setsPrev = patch.prev_status !== undefined
        if (setsPrev && !allowPrevStatus)
            throw new ValidationError("field not patchable: prev_status")
        if (setsPrev && patch.prev_status && !RESUMABLE.has(patch.prev_status))
            throw new ValidationError(
                "prev_status must be an open, non-waiting status"
            )

        return taskLock(id, async () => {
            const cur = await readTask(id)
            if (baseRevision && baseRevision !== cur.revision)
                throw new StaleRevisionError(cur)
            const prev = cur.task
            const next = { ...prev }
            for (const [k, v] of Object.entries(patch)) {
                if (v === undefined) continue
                next[k] =
                    isPlainObject(prev[k]) && isPlainObject(v)
                        ? { ...prev[k], ...v }
                        : v
            }
            const at = now()
            if (next.status !== prev.status) {
                try {
                    assertTransition(prev.status, next.status)
                } catch (err) {
                    if (!(err instanceof TransitionError)) throw err
                    throw new AppError("illegal_transition", err.message, {
                        status: 409,
                        details: { from: err.from, to: err.to },
                    })
                }
                // Done needs every deliverable merged or no_change, whoever
                // asks; checked on the merged task, under the task lock.
                if (next.status === "done") {
                    const open = openDeliverables(next)
                    if (open.length)
                        throw new AppError(
                            "deliverables_open",
                            `T-${id} has deliverables that are not merged or no_change: ${open
                                .map((d) => `${d.repo}@${d.branch}`)
                                .join(", ")}`,
                            { status: 409 }
                        )
                }
                if (!setsPrev) {
                    next.prev_status =
                        next.status === "waiting" && RESUMABLE.has(prev.status)
                            ? prev.status
                            : null
                }
                if (!("done_at" in patch)) {
                    if (next.status === "done") next.done_at = at
                    else if (prev.status === "done") next.done_at = null
                }
                // A closed task needs nothing from Leo: drop the Now flag
                // (e.g. a leftover "Ready for review"), unless this same
                // patch sets it.
                const setsNow =
                    isPlainObject(patch.flags) &&
                    ("now" in patch.flags || "now_reason" in patch.flags)
                if (CLOSED_STATUSES.has(next.status) && !setsNow)
                    next.flags = { ...next.flags, now: false, now_reason: null }
            }
            next.updated_at = at
            const candidate = validate(TaskSchema, next, "task")
            const changed = Object.keys(candidate).filter(
                (k) =>
                    k !== "updated_at" &&
                    JSON.stringify(candidate[k]) !== JSON.stringify(prev[k])
            )
            if (!changed.length) return cur

            const written = await writeTaskFile(candidate)
            const task = written.task
            let artifactRevision = null
            // The title line follows the title; a SOC2-area task (also one
            // whose area was set later) gets its change record section.
            if (changed.includes("title") || SOC2_AREAS.includes(task.area)) {
                const art = await readArtifact(id)
                const content = ensureChangeRecord(
                    changed.includes("title")
                        ? setTitleLine(art.content, id, task.title)
                        : art.content,
                    task
                )
                if (content !== art.content)
                    artifactRevision = await writeArtifactFile(id, content)
            }
            const data = { changed }
            if (changed.includes("status")) {
                data.from = prev.status
                data.to = task.status
            }
            if (reason) data.reason = String(reason)
            const event = await appendEventRecord(
                id,
                { type: "updated", data },
                actor
            )
            await indexTask(id, task)
            git.touch(
                id,
                actor,
                changed.includes("status")
                    ? `status → ${task.status}`
                    : `updated ${changed.join(", ")}`
            )
            emit("task.updated", id, { task, changed })
            if (artifactRevision) {
                emit("artifact.updated", id, {
                    revision: artifactRevision,
                    actor,
                    sections: [],
                })
            }
            emitEvent(id, event)
            return written
        })
    }

    async function getArtifact(rawId) {
        const id = toId(rawId)
        await ensureTask(id)
        return readArtifact(id)
    }

    async function writeArtifact(rawId, content, opts = {}) {
        const id = toId(rawId)
        const { actor, baseRevision } = opts
        checkActor(actor)
        if (typeof content !== "string")
            throw new ValidationError("artifact content must be a string")
        if (!baseRevision)
            throw new ValidationError("base_revision is required")
        return taskLock(id, async () => {
            await ensureTask(id)
            const cur = await readArtifact(id)
            if (cur.revision !== baseRevision) throw new StaleRevisionError(cur)
            if (content === cur.content) return { revision: cur.revision }
            const revision = await writeArtifactFile(id, content)
            await indexTask(id)
            git.touch(id, actor, "edited artifact")
            emit("artifact.updated", id, { revision, actor })
            return { revision }
        })
    }

    async function updateArtifactSection(rawId, args = {}, actor) {
        const id = toId(rawId)
        const { section, op, content, baseRevision } = args
        checkActor(actor)
        if (
            typeof section !== "string" ||
            !section.trim() ||
            /[\r\n]/.test(section) ||
            section.trim().startsWith("#")
        )
            throw new ValidationError("invalid section name")
        if (op !== "replace" && op !== "append")
            throw new ValidationError("op must be replace or append")
        if (typeof content !== "string")
            throw new ValidationError("section content must be a string")
        if (op === "replace" && !baseRevision)
            throw new ValidationError("base_revision is required for replace")
        const name = section.trim()
        return taskLock(id, async () => {
            await ensureTask(id)
            const cur = await readArtifact(id)
            if (baseRevision && cur.revision !== baseRevision)
                throw new StaleRevisionError(cur)
            const next = setSection(cur.content, name, content, op)
            if (next === cur.content) return { revision: cur.revision }
            const revision = await writeArtifactFile(id, next)
            await indexTask(id)
            git.touch(
                id,
                actor,
                op === "append" ? `appended to ${name}` : `updated ${name}`
            )
            emit("artifact.updated", id, { revision, actor, sections: [name] })
            return { revision }
        })
    }

    async function listSections(rawId) {
        const { content } = await getArtifact(rawId)
        return parseSections(content)
    }

    async function appendComment(rawId, record, actor) {
        const id = toId(rawId)
        checkActor(actor)
        if (!isPlainObject(record)) throw new ValidationError("invalid comment")
        return taskLock(id, async () => {
            await ensureTask(id)
            const rec = validate(
                CommentCreateRecord,
                {
                    author: actor,
                    ...record,
                    op: "create",
                    id: genId("c_"),
                    at: now(),
                },
                "comment"
            )
            if (rec.parent_id) {
                const threads = await readThreads(id)
                const root = threads.find(
                    (t) =>
                        t.id === rec.parent_id ||
                        t.replies.some((r) => r.id === rec.parent_id)
                )
                if (!root) throw new NotFoundError(`comment ${rec.parent_id}`)
                rec.parent_id = root.id
            }
            await appendLine(fileOf(id, "comments.jsonl"), JSON.stringify(rec))
            await indexTask(id)
            git.touch(id, actor, rec.parent_id ? "comment reply" : "comment")
            const node = rec.parent_id
                ? rec
                : { ...rec, status: "open", resolution: null, replies: [] }
            emit("comment.added", id, { comment: node })
            return node
        })
    }

    async function setCommentStatus(rawId, commentId, args = {}, actor) {
        const id = toId(rawId)
        checkActor(actor)
        return taskLock(id, async () => {
            await ensureTask(id)
            const find = (threads) =>
                threads.find(
                    (t) =>
                        t.id === commentId ||
                        t.replies.some((r) => r.id === commentId)
                )
            const thread = find(await readThreads(id))
            if (!thread) throw new NotFoundError(`comment ${commentId}`)
            const rec = validate(
                CommentStatusRecord,
                {
                    op: "status",
                    id: thread.id,
                    status: args.status,
                    resolution: args.resolution ?? null,
                    by: actor,
                    at: now(),
                },
                "comment status"
            )
            await appendLine(fileOf(id, "comments.jsonl"), JSON.stringify(rec))
            const updated = find(await readThreads(id))
            git.touch(id, actor, `comment ${rec.status}`)
            emit("comment.updated", id, { comment: updated })
            return updated
        })
    }

    async function listComments(rawId) {
        const id = toId(rawId)
        await ensureTask(id)
        return readThreads(id)
    }

    async function appendFeedback(rawId, item, actor = "system") {
        const id = toId(rawId)
        checkActor(actor)
        return taskLock(id, async () => {
            await ensureTask(id)
            const rec = validate(
                FeedbackItemSchema,
                { at: now(), ...item },
                "feedback item"
            )
            await appendLine(fileOf(id, "feedback.jsonl"), JSON.stringify(rec))
            git.touch(id, actor, "feedback")
            return rec
        })
    }

    async function listFeedback(rawId) {
        const id = toId(rawId)
        await ensureTask(id)
        const latest = new Map()
        for (const rec of await readRecords(
            id,
            "feedback.jsonl",
            FeedbackItemSchema
        ))
            latest.set(rec.id, rec)
        return [...latest.values()]
    }

    async function appendEvent(rawId, { type, data = {} } = {}, actor) {
        const id = toId(rawId)
        checkActor(actor)
        return taskLock(id, async () => {
            await ensureTask(id)
            const event = await appendEventRecord(id, { type, data }, actor)
            git.touch(id, actor, event.type)
            emitEvent(id, event)
            return event
        })
    }

    async function listEvents(rawId, { limit = 50 } = {}) {
        const id = toId(rawId)
        await ensureTask(id)
        const events = await readRecords(id, "events.jsonl", EventRecordSchema)
        return events.reverse().slice(0, Math.max(0, Number(limit) || 0))
    }

    async function getHistory(rawId, { limit = 50 } = {}) {
        const id = toId(rawId)
        await ensureTask(id)
        return git.log(id, limit)
    }

    async function getCommitDiff(rawId, sha) {
        const id = toId(rawId)
        await ensureTask(id)
        return git.diff(id, sha)
    }

    function withTaskLock(rawId, fn) {
        return taskLock(toId(rawId), fn)
    }

    /** Run fn with no task lock context (detached background work). */
    function outsideLocks(fn) {
        return locks.outside(fn)
    }

    function query(params = {}) {
        const {
            status,
            area,
            kind,
            q,
            lane,
            shared_only: sharedOnly,
            done_since: doneSince,
        } = params
        const limit = Math.min(Math.max(Number(params.limit) || 200, 1), 1000)
        const offset = Math.max(Number(params.offset) || 0, 0)
        const where = []
        const args = []
        for (const [col, vals] of [
            ["status", listParam(status)],
            ["area", listParam(area)],
            ["kind", listParam(kind)],
        ]) {
            if (!vals.length) continue
            where.push(`${col} IN (${vals.map(() => "?").join(", ")})`)
            args.push(...vals)
        }
        if (lane) {
            where.push("lane = ?")
            args.push(String(lane))
        }
        if (sharedOnly) where.push("shared = 1")
        if (doneSince) {
            const since = toUtcIso(doneSince)
            if (!since) throw new ValidationError("invalid done_since")
            where.push("done_at >= ?")
            args.push(since)
        }
        if (q && String(q).trim()) {
            const match = ftsQuery(q)
            const idm = /^(?:T-?)?(\d+)$/i.exec(String(q).trim())
            const ors = []
            if (idm) {
                ors.push("id = ?")
                args.push(Number(idm[1]))
            }
            if (match) {
                ors.push(
                    "id IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH ?)"
                )
                // Viewers must not match private text (comments, private
                // link labels): restrict the MATCH to the public columns.
                args.push(
                    sharedOnly ? `${PUBLIC_FTS_COLUMNS} : (${match})` : match
                )
            }
            where.push(ors.length ? `(${ors.join(" OR ")})` : "0")
        }
        const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : ""
        const total = db
            .prepare(`SELECT COUNT(*) AS n FROM tasks_index${whereSql}`)
            .get(...args).n
        const rows = db
            .prepare(
                `SELECT json FROM tasks_index${whereSql}
                 ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
            )
            .all(...args, limit, offset)
        return { tasks: rows.map((r) => JSON.parse(r.json)), total }
    }

    function board({
        shared_only: sharedOnly = false,
        done_days: doneDays = 7,
    } = {}) {
        const since = new Date(
            clock.now().getTime() - Number(doneDays) * 86400000
        ).toISOString()
        const rows = db
            .prepare(
                `SELECT lane, json, updated_at, due_at, snooze_until, done_at
                 FROM tasks_index
                 WHERE (lane != 'done' OR COALESCE(done_at, updated_at) >= ?)
                 ${sharedOnly ? "AND shared = 1" : ""}`
            )
            .all(since)
        const lanes = Object.fromEntries(LANES.map((l) => [l, []]))
        for (const r of rows) (lanes[r.lane] || lanes.done).push(r)
        const desc = (a, b) => (a < b ? 1 : a > b ? -1 : 0)
        const byUpdated = (a, b) => desc(a.updated_at, b.updated_at)
        const wake = (r) =>
            [r.due_at, r.snooze_until].filter(Boolean).sort()[0] || null
        const sorters = {
            waiting: (a, b) => {
                const wa = wake(a)
                const wb = wake(b)
                if (wa && wb && wa !== wb) return wa < wb ? -1 : 1
                if (wa && !wb) return -1
                if (!wa && wb) return 1
                return byUpdated(a, b)
            },
            done: (a, b) =>
                desc(a.done_at || a.updated_at, b.done_at || b.updated_at),
        }
        const out = {}
        for (const lane of LANES) {
            out[lane] = lanes[lane]
                .sort(sorters[lane] || byUpdated)
                .map((r) => JSON.parse(r.json))
        }
        return out
    }

    /**
     * Index one task under its lock. A missing or corrupt task.json drops
     * its rows. Returns true when the task is indexed.
     */
    function reindexOne(id) {
        return taskLock(id, async () => {
            try {
                await indexTask(id)
                return true
            } catch (err) {
                if (!(err instanceof NotFoundError))
                    log.warn(
                        { err, task: taskKey(id) },
                        "reindex: skipping task"
                    )
                deleteRows(id)
                return false
            }
        })
    }

    async function reindex() {
        const seen = new Set()
        for (const { id } of taskDirs()) if (await reindexOne(id)) seen.add(id)
        // Rows not seen in the folder snapshot: re-check each one on disk
        // under its lock. A task created while the scan ran is indexed by
        // its creator and must not be dropped here.
        for (const { id } of st.allIds.all()) {
            if (seen.has(id)) continue
            if (await reindexOne(id)) seen.add(id)
        }
        nextId = Math.max(nextId, scanMaxId() + 1)
        return { count: seen.size }
    }

    async function removeTempFiles(dir) {
        let removed = 0
        const entries = await fs.promises.readdir(dir, { withFileTypes: true })
        for (const e of entries) {
            const p = path.join(dir, e.name)
            if (e.isDirectory()) removed += await removeTempFiles(p)
            else if (isTempFile(e.name)) {
                await fs.promises.rm(p, { force: true })
                removed++
            }
        }
        return removed
    }

    /** Fix torn last lines of the task's JSONL files (crash mid-append). */
    function repairJsonl(id) {
        return taskLock(id, async () => {
            for (const name of JSONL_FILES) {
                const res = await repairJsonlTail(fileOf(id, name))
                if (res)
                    log.warn(
                        { task: taskKey(id), file: name, result: res },
                        "recover: repaired torn jsonl line"
                    )
            }
        })
    }

    async function recover() {
        let removedTemp = 0
        for (const { id, name } of taskDirs()) {
            removedTemp += await removeTempFiles(path.join(tasksDir, name))
            await repairJsonl(id)
        }
        const committed = Boolean(await git.recoverUncommitted())
        await reindex()
        return { committed, removedTemp }
    }

    async function close() {
        try {
            await git.flush()
        } finally {
            if (db.open) db.close()
        }
    }

    return {
        createTask,
        getTask,
        updateTask,
        getArtifact,
        writeArtifact,
        updateArtifactSection,
        listSections,
        appendComment,
        setCommentStatus,
        listComments,
        appendFeedback,
        listFeedback,
        appendEvent,
        listEvents,
        getHistory,
        getCommitDiff,
        withTaskLock,
        outsideLocks,
        query,
        board,
        reindex,
        recover,
        close,
    }
}
