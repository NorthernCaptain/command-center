/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Express app factory shared by both listeners. `mode` decides auth:
// "local" (bearer / cc_session) or "tailnet" (Tailscale header + paired
// device). See docs/implementation/contracts.md "HTTP".

import express from "express"
import nodeFs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { assertClosable, enqueueCloseOut } from "../agent/jobs/close_out.js"
import { assertTaskChangeRecord, changeRecordState } from "../phase3/soc2.js"
import {
    isShared,
    LANES,
    viewerTask,
    withSnoozeFlags,
    clearsWhenSeen,
    SNOOZE_ENDED,
} from "../contracts/lifecycle.js"
import {
    AnchorSchema,
    AREAS,
    COMMENT_INTENTS,
    COMMENT_STATUSES,
    KINDS,
    SCHEDULE_ACTIONS,
    STATUSES,
    TaskCreateSchema,
    TaskPatchSchema,
    WORKER_KINDS,
} from "../contracts/schemas.js"
import {
    AppError,
    ForbiddenError,
    NotFoundError,
    StaleRevisionError,
    ValidationError,
} from "../util/errors.js"
import { nullLogger } from "../util/logger.js"
import {
    DEVICE_COOKIE,
    DEVICE_TTL_MS,
    SESSION_COOKIE,
    SESSION_TTL_MS,
    parseCookies,
    publicDevice,
    serializeCookie,
} from "./auth.js"
import { createHostGuard } from "./hostGuard.js"
import { createSseHandler } from "./sse.js"

const ACTOR = "me"
const PROVIDERS = ["claude-sdk", "claude-cli", "codex"]
// Sources whose URL enrich fetches (Slack via Brain, Asana via the API).
// Every other non-reminder capture is enriched from its text alone.
const FETCH_SOURCES = ["slack", "asana"]
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"]
const isoDate = z.string().datetime({ offset: true })

/** GET routes a viewer may call (paths relative to /api). */
const VIEWER_GETS = [
    /^\/me\/?$/,
    /^\/board\/?$/,
    /^\/tasks\/?$/,
    /^\/tasks\/[^/]+\/?$/,
    // a shared task's attachments (the artifact embeds them); the handler
    // checks the task is shared
    /^\/tasks\/[^/]+\/files\/[^/]+$/,
    /^\/events\/?$/,
]

// Attachments the browser may show inline (with ?download=1 every file is
// a download). HTML and unknown types are always downloads.
const INLINE_KINDS = ["image", "video", "audio", "pdf", "markdown", "text"]
// A file is never a page of this app: no scripts, no plugins, its own
// sandbox (an SVG opened directly can't run script on this origin).
const FILE_CSP =
    "default-src 'none'; img-src 'self' data:; media-src 'self'; " +
    "style-src 'unsafe-inline'; sandbox"

/** Whitelisted runtime settings and their value schemas. */
const ModelPairSchema = z
    .object({
        light: z.string().min(1).max(200),
        heavy: z.string().min(1).max(200),
    })
    .strict()
export const SETTINGS_SCHEMAS = {
    "center.provider": z.enum(PROVIDERS),
    "center.fallback_provider": z.enum(PROVIDERS).nullable(),
    "center.auto_fallback": z.boolean(),
    "center.models": z.partialRecord(z.enum(PROVIDERS), ModelPairSchema),
    "workers.default_kind": z.enum(WORKER_KINDS),
    "workers.auto_clean_on_done": z.boolean(),
    // phase 2/3
    "github.poll_minutes": z.number().int().min(5).max(1440),
    "digest.enabled": z.boolean(),
    "digest.time": z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    "stale.days": z.number().int().min(1).max(90),
    "push.enabled": z.boolean(),
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/i

/** First http(s) URL in text, without trailing punctuation. */
export function extractUrl(text) {
    if (!text) return null
    const m = URL_RE.exec(text)
    if (!m) return null
    return m[0].replace(/[).,;:!?\]>]+$/, "")
}

/** "slack" | "asana" | "github" | null from a URL's host. */
export function detectSourceType(url) {
    if (!url) return null
    let host
    try {
        host = new URL(url).hostname.toLowerCase()
    } catch {
        return null
    }
    const is = (d) => host === d || host.endsWith("." + d)
    if (is("slack.com")) return "slack"
    if (is("asana.com")) return "asana"
    if (is("github.com")) return "github"
    return null
}

/** First non-empty line, at most 120 chars. */
export function firstLine(text) {
    if (!text) return ""
    const line =
        text
            .split(/\r?\n/)
            .map((s) => s.trim())
            .find(Boolean) || ""
    return line.slice(0, 120).trimEnd()
}

/** Validate with zod; throw ValidationError with the issues. */
function parse(schema, value, what = "request") {
    const r = schema.safeParse(value)
    if (!r.success)
        throw new ValidationError(`invalid ${what}`, { issues: r.error.issues })
    return r.data
}

/** Task id from "123" or "T-123". */
export function parseTaskId(raw) {
    const m = /^(?:T-)?(\d{1,9})$/i.exec(String(raw))
    const id = m ? Number(m[1]) : 0
    if (!id) throw new ValidationError("invalid task id", { id: raw })
    return id
}

function parseIntId(raw, what) {
    if (!/^\d{1,12}$/.test(String(raw)) || Number(raw) <= 0)
        throw new ValidationError(`invalid ${what} id`, { id: raw })
    return Number(raw)
}

/** Task fields only the service sets; a PATCH naming them is a 400. */
export const SERVICE_OWNED_PATCH_FIELDS = ["prev_status"]

/**
 * Validate a raw PATCH object against TaskPatchSchema and return only the
 * keys the caller sent. (TaskPatchSchema.parse fills defaults for missing
 * keys, which would clobber stored values, so the parsed output is unused.)
 */
export function validateTaskPatch(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new ValidationError("patch must be an object")
    const owned = Object.keys(raw).filter((k) =>
        SERVICE_OWNED_PATCH_FIELDS.includes(k)
    )
    if (owned.length)
        throw new ValidationError("service-owned patch fields", {
            fields: owned,
        })
    const known = TaskPatchSchema.shape
    const unknown = Object.keys(raw).filter((k) => !(k in known))
    if (unknown.length)
        throw new ValidationError("unknown patch fields", { fields: unknown })
    parse(TaskPatchSchema, raw, "patch")
    return { ...raw }
}

/**
 * Task repos from a PATCH: names resolved against the known repo table
 * (case-insensitive, canonical spelling; unknown names are a 400 when the
 * table is available), duplicates dropped, at most one "main".
 */
export function normalizeRepos(repos, table = []) {
    const known = new Map(
        (table || []).map((r) => [String(r.name).toLowerCase(), r.name])
    )
    const out = []
    const seen = new Set()
    const unknown = []
    for (const r of repos) {
        const raw = String(r.name).trim()
        const key = raw.toLowerCase()
        const name = known.size ? known.get(key) : raw
        if (!name) {
            unknown.push(raw)
            continue
        }
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ name, role: r.role })
    }
    if (unknown.length)
        throw new ValidationError("unknown repos", { repos: unknown })
    if (out.filter((r) => r.role === "main").length > 1)
        throw new ValidationError("only one repo can be main")
    return out
}

function normalizeSettings(all) {
    if (Array.isArray(all)) {
        const out = {}
        for (const row of all) out[row.key] = row.value
        return out
    }
    return all || {}
}

/** Map any thrown error to { status, body }. */
export function mapError(err) {
    if (err instanceof z.ZodError)
        return {
            status: 400,
            body: {
                error: "validation",
                message: "invalid request",
                details: { issues: err.issues },
            },
        }
    if (err && err.type === "entity.parse.failed")
        return {
            status: 400,
            body: { error: "bad_json", message: "malformed JSON body" },
        }
    if (err && err.type === "entity.too.large")
        return {
            status: 413,
            body: { error: "too_large", message: "request body too large" },
        }
    if (err && err.code === "illegal_transition")
        return {
            status: 409,
            body: {
                error: "illegal_transition",
                message: err.message,
                details: { from: err.from, to: err.to },
            },
        }
    if (
        err instanceof AppError ||
        (err && typeof err.status === "number" && typeof err.code === "string")
    ) {
        const body = { error: err.code, message: err.message }
        if (err.details !== undefined) body.details = err.details
        return { status: err.status, body }
    }
    if (err && err.expose && err.status >= 400 && err.status < 500)
        return {
            status: err.status,
            body: { error: "bad_request", message: err.message },
        }
    return {
        status: 500,
        body: { error: "internal", message: "internal error" },
    }
}

/**
 * @param {object} deps
 * @param {"local"|"tailnet"} deps.mode
 * @param {object} deps.store         contracts store
 * @param {object} deps.bus
 * @param {object} deps.jobRunner     enqueue/get/list/cancel
 * @param {object} deps.scheduler     add/cancel/listForTask/remind
 * @param {object} deps.dateParser    parseCapture/parseWhen
 * @param {object} deps.settingsRepo  get/set/all
 * @param {object} deps.devicesRepo   list/revoke (+ used by auth)
 * @param {object} deps.auth          from createAuth()
 * @param {object} deps.config
 * @param {object} [deps.log]
 * @param {object} [deps.fs]          for the web/dist existence check
 * @param {Function} [deps.mcpHandler] mounted at /mcp (local + bearer only)
 * @param {object} [deps.sse]         { heartbeatMs, setInterval, clearInterval }
 * @param {Function} [deps.resolvePublicBaseUrl] tailnet: async () => url|null,
 *        retried lazily while config.publicBaseUrl is unknown
 * @param {object} [deps.clock]       for the host guard's retry throttle
 * @param {Function[]} [deps.mounts]  phase 2/3 route modules: each is called
 *        as mount(api, helpers) after the core routes (helpers: see below)
 * @param {Function[]} [deps.taskExtras] async (id, task) => object merged
 *        into the owner's GET /api/tasks/:id response
 * @param {Function[]} [deps.boardExtras] async () => object merged into the
 *        owner's GET /api/board response
 * @param {object} [deps.features] { workers, github, push, soc2, digest }:
 *        which phase 2/3 modules are wired; reported to the owner by /api/me
 *        so the UI only shows controls that work
 * @param {Function[]} [deps.onDeviceRevoked] async (deviceId) => void, run
 *        after a device is revoked (e.g. drop its push subscriptions)
 * @param {object} [deps.repoTable] { list(), reset() }: known repos for
 *        GET /api/repos and PATCH repos validation
 * @param {object} [deps.taskFiles] task attachments (files/taskFiles.js):
 *        upload, list, serve and delete under /api/tasks/:id/files
 */
/** Baseline enrich compares against to keep fields the user edited. */
export function enrichSnapshot(task) {
    return { title: task.title, area: task.area, kind: task.kind }
}

export function createApp({
    mode,
    store,
    bus,
    jobRunner,
    scheduler,
    dateParser,
    settingsRepo,
    devicesRepo,
    auth,
    config,
    log = nullLogger,
    fs = nodeFs,
    mcpHandler = null,
    sse = {},
    resolvePublicBaseUrl = null,
    clock = null,
    mounts = [],
    taskExtras = [],
    boardExtras = [],
    features = {},
    onDeviceRevoked = [],
    repoTable = null,
    taskFiles = null,
}) {
    if (mode !== "local" && mode !== "tailnet")
        throw new Error(`invalid app mode: ${mode}`)
    const tailnet = mode === "tailnet"
    const app = express()
    app.disable("x-powered-by")
    app.set("etag", false)

    app.use((req, res, next) => {
        res.setHeader("X-Content-Type-Options", "nosniff")
        res.setHeader("X-Frame-Options", "DENY")
        res.setHeader("Referrer-Policy", "no-referrer")
        // Same-origin only: no remote images/scripts (blocks exfiltration
        // via injected artifact content), no framing.
        res.setHeader(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
                "script-src 'self'; connect-src 'self'; object-src 'none'; " +
                "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        )
        next()
    })

    // DNS-rebinding guard: before healthz, auth, API and static files.
    app.use(
        createHostGuard({
            mode,
            config,
            log,
            resolvePublicBaseUrl,
            ...(clock ? { clock } : {}),
        })
    )

    app.get("/healthz", (req, res) => res.json({ ok: true }))

    // ---- auth middleware -------------------------------------------------

    async function resolveAuth(req, res, next) {
        req.auth = await auth.resolve(req, mode)
        if (!req.auth.role)
            throw new AppError("unauthorized", "authentication required", {
                status: 401,
            })
        next()
    }

    /** CSRF: cookie/header-authenticated writes must be same-origin. */
    function csrf(req, res, next) {
        if (SAFE_METHODS.includes(req.method) || req.auth.via === "bearer")
            return next()
        const reject = () => {
            throw new AppError("csrf", "cross-origin request rejected", {
                status: 403,
            })
        }
        if (req.headers["sec-fetch-site"] === "cross-site") reject()
        const origin = req.headers.origin
        if (origin === undefined) return next()
        let host
        try {
            host = new URL(origin).host.toLowerCase()
        } catch {
            reject()
        }
        // req.ccHost is the Host the host guard already validated.
        if (!host || host !== req.ccHost) reject()
        next()
    }

    /** Deny by default: viewers get only the whitelisted GETs. */
    function enforceRole(req, res, next) {
        if (req.auth.role === "owner") return next()
        if (
            (req.method === "GET" || req.method === "HEAD") &&
            VIEWER_GETS.some((re) => re.test(req.path))
        )
            return next()
        if (tailnet && req.method === "POST" && req.path === "/pair")
            return next()
        throw new ForbiddenError()
    }

    const isViewer = (req) => req.auth.role !== "owner"

    // ---- bootstrap (local only) ------------------------------------------

    if (!tailnet) {
        app.get("/auth/bootstrap", (req, res) => {
            const t = typeof req.query.t === "string" ? req.query.t : ""
            if (!auth.consumeBootstrapToken(t)) {
                res.status(401)
                    .type("text/plain")
                    .send("Link expired or already used. Run `cc open` again.")
                return
            }
            const session = auth.createSession()
            res.setHeader(
                "Set-Cookie",
                serializeCookie(SESSION_COOKIE, session, {
                    maxAgeMs: SESSION_TTL_MS,
                    sameSite: "Strict",
                })
            )
            res.redirect(302, "/")
        })

        if (mcpHandler) {
            app.use(
                "/mcp",
                resolveAuth,
                (req, res, next) => {
                    if (req.auth.via !== "bearer")
                        throw new ForbiddenError("bearer token required")
                    next()
                },
                mcpHandler
            )
        }
    }

    // ---- API ---------------------------------------------------------------

    const api = express.Router()
    api.use((req, res, next) => {
        res.setHeader("Cache-Control", "no-store")
        next()
    })
    api.use(resolveAuth)
    api.use(express.json({ limit: "1mb" }))
    api.use(csrf)
    api.use(enforceRole)

    api.get("/me", (req, res) => {
        const me = { role: req.auth.role, login: req.auth.login, mode }
        if (!isViewer(req)) me.features = { ...features }
        res.json(me)
    })

    api.get("/events", createSseHandler({ bus, store, auth, log, ...sse }))

    /**
     * Tasks with an agent that the lanes leave out (done before the board's
     * window): the web "herdr" pill lists them too. A task that can't be
     * read is skipped.
     */
    async function offBoardTasks(lanes, agents) {
        const onBoard = new Set(
            Object.values(lanes)
                .flat()
                .map((t) => String(t.id))
        )
        const out = []
        for (const id of Object.keys(agents)) {
            if (onBoard.has(id)) continue
            try {
                out.push((await store.getTask(Number(id))).task)
            } catch {
                // deleted or unreadable: nothing to list
            }
        }
        return out
    }

    // board
    api.get("/board", async (req, res) => {
        const q = parse(
            z.object({
                done_days: z.coerce.number().int().min(0).max(365).optional(),
            }),
            req.query,
            "query"
        )
        const opts = { shared_only: isViewer(req) }
        if (q.done_days !== undefined) opts.done_days = q.done_days
        const board = await store.board(opts)
        const lanes = {}
        for (const lane of LANES) {
            const list = (board && board[lane]) || []
            lanes[lane] = isViewer(req)
                ? list.filter(isShared).map(viewerTask)
                : list
        }
        if (isViewer(req)) {
            res.json({ lanes })
            return
        }
        const extras = {}
        for (const fn of boardExtras) Object.assign(extras, await fn())
        if (extras.agents)
            extras.agent_tasks = await offBoardTasks(lanes, extras.agents)
        res.json({ ...extras, lanes })
    })

    // list / search
    const csv = (values) =>
        z
            .string()
            .optional()
            .transform((s) =>
                s
                    ? s
                          .split(",")
                          .map((x) => x.trim())
                          .filter(Boolean)
                    : undefined
            )
            .pipe(z.array(z.enum(values)).optional())
    const ListQuery = z.object({
        q: z.string().max(500).optional(),
        status: csv(STATUSES),
        area: csv(AREAS),
        kind: csv(KINDS),
        lane: z.enum(LANES).optional(),
        done_since: isoDate.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
        offset: z.coerce.number().int().min(0).default(0),
    })
    api.get("/tasks", async (req, res) => {
        const q = parse(ListQuery, req.query, "query")
        const query = { limit: q.limit, offset: q.offset }
        for (const k of ["q", "status", "area", "kind", "lane", "done_since"])
            if (q[k] !== undefined && q[k] !== "") query[k] = q[k]
        if (isViewer(req)) query.shared_only = true
        const { tasks, total } = await store.query(query)
        res.json({
            tasks: isViewer(req)
                ? tasks.filter(isShared).map(viewerTask)
                : tasks,
            total,
        })
    })

    // capture
    const CaptureExtra = z.object({
        when: z.string().trim().min(1).max(200).optional(),
    })
    api.post("/tasks", async (req, res) => {
        const body = req.body || {}
        const input = parse(TaskCreateSchema, body)
        const { when } = parse(CaptureExtra, body)
        const text = (input.text || "").trim()
        const url = input.url || extractUrl(text)
        const sourceType =
            input.source_type || detectSourceType(url) || "manual"
        let kind = input.kind
        let dueAt = input.due_at || null
        let title = input.title ? input.title.trim() : ""

        if (when) {
            const at = await dateParser.parseWhen(when)
            if (!at) throw new ValidationError("could not parse when", { when })
            dueAt = dueAt || at
            kind = kind || "reminder"
        }
        let capture = null
        if (text) capture = await dateParser.parseCapture(text)
        if (capture && capture.isReminder && (!kind || kind === "reminder")) {
            kind = "reminder"
            dueAt = dueAt || capture.due_at || null
            title = title || (capture.title || "").trim()
        }
        title = title || firstLine(text) || url || ""
        if (!title) throw new ValidationError("title could not be derived")
        kind = kind || "todo"
        const remind = kind === "reminder" && Boolean(dueAt)
        const fetchable = Boolean(url) && FETCH_SOURCES.includes(sourceType)
        // "remind me ..." text the date parser could not place goes to
        // parse_quick (which may turn it into a reminder) instead of enrich.
        const parseQuick =
            !fetchable &&
            !remind &&
            !when &&
            Boolean(text) &&
            /\bremind me\b/i.test(text)
        const enrich = fetchable || (!parseQuick && kind !== "reminder")
        // "Create in Asana" ticked: enrich starts asana_create when it is
        // done (so the Asana description has the artifact); without enrich
        // it starts right away.
        const createAsana = input.wants_asana === true
        // Fields chosen explicitly at capture: enrich must not re-guess them.
        const pinned = ["title", "area", "kind"].filter((k) => input[k])

        const createInput = {
            text: input.text,
            title: title.slice(0, 300),
            url: url || undefined,
            kind,
            area: input.area || "other",
            status: remind ? "waiting" : "inbox",
            due_at: dueAt,
            visibility: input.visibility,
            wants_asana: input.wants_asana,
            wants_agent: input.wants_agent,
            source_type: sourceType,
            source: {
                type: sourceType,
                url: url || null,
                text: input.text ?? null,
            },
        }
        if (enrich) createInput.flags = { enriching: true }
        for (const k of Object.keys(createInput))
            if (createInput[k] === undefined) delete createInput[k]

        const { task, revision, artifact } = await store.createTask(
            createInput,
            ACTOR
        )
        // Follow-ups must not fail the request: the task already exists.
        const followUp = async (what, fn) => {
            try {
                await fn()
            } catch (err) {
                log.error({ err: err.message, task_id: task.id }, what)
            }
        }
        if (remind)
            await followUp("remind failed", () =>
                scheduler.remind(task.id, dueAt)
            )
        if (enrich)
            await followUp("enqueue enrich failed", () =>
                jobRunner.enqueue(
                    "enrich",
                    {
                        snapshot: enrichSnapshot(task),
                        // artifact as created: later edits are Leo's
                        ...(artifact && artifact.revision
                            ? {
                                  baseline: {
                                      content: artifact.content,
                                      revision: artifact.revision,
                                  },
                              }
                            : {}),
                        ...(pinned.length ? { pinned } : {}),
                        ...(createAsana ? { create_asana: true } : {}),
                    },
                    { task_id: task.id }
                )
            )
        // parseQuick never coincides with enrich (see above)
        if (createAsana && !enrich)
            await followUp("enqueue asana_create failed", () =>
                jobRunner.enqueue("asana_create", {}, { task_id: task.id })
            )
        if (parseQuick)
            await followUp("enqueue parse_quick failed", () =>
                jobRunner.enqueue(
                    "parse_quick",
                    {
                        text,
                        // + due_at/status: parse_quick keeps any Leo changes
                        snapshot: {
                            ...enrichSnapshot(task),
                            due_at: task.due_at ?? null,
                            status: task.status,
                        },
                    },
                    { task_id: task.id }
                )
            )
        res.status(201).json({ task, revision })
    })

    // task detail
    api.get("/tasks/:id", async (req, res) => {
        const id = parseTaskId(req.params.id)
        const { task, revision } = await store.getTask(id)
        if (isViewer(req)) {
            if (!isShared(task)) throw new NotFoundError("task")
            const artifact = await store.getArtifact(id)
            res.json({
                task: viewerTask(task),
                artifact: { content: artifact.content },
            })
            return
        }
        const [artifact, comments, feedback, events, schedules, jobs] =
            await Promise.all([
                store.getArtifact(id),
                store.listComments(id),
                store.listFeedback(id),
                store.listEvents(id, { limit: 50 }),
                scheduler.listForTask(id),
                jobRunner.list({ task_id: id, limit: 50 }),
            ])
        const extras = {}
        for (const fn of taskExtras) Object.assign(extras, await fn(id, task))
        if (taskFiles) extras.files = await taskFiles.list(id, task)
        // SOC2 areas: what the change record still lacks (blocks Done)
        const changeRecord = changeRecordState(task, artifact)
        if (changeRecord) extras.change_record = changeRecord
        res.json({
            ...extras,
            task,
            revision,
            artifact,
            comments,
            feedback,
            events,
            schedules,
            jobs,
        })
    })

    // patch / snooze
    const PatchBody = z.object({
        patch: z.record(z.string(), z.unknown()).optional(),
        base_revision: z.string().min(1).max(128).optional(),
        snooze: z.string().trim().min(1).max(200).optional(),
    })
    /**
     * "Done" on an Asana-linked task is a close-out (Result section, Asana
     * comment + completion, then status done), same as the command path.
     * Other patch fields are applied now; the status follows when the job
     * finishes. Returns null when a plain status change applies instead
     * (after the same deliverables check).
     */
    async function startCloseOut(id, patch, baseRevision) {
        const cur = await store.getTask(id)
        const { task } = cur
        if (task.status === "done") return null
        if (baseRevision && baseRevision !== cur.revision)
            throw new StaleRevisionError(cur)
        // Every way to done needs merged / no_change deliverables, with or
        // without Asana (409 deliverables_open otherwise), judged on the task
        // as this patch would leave it. The caller holds the task lock.
        // Merged like store.updateTask does (plain objects shallow-merged), so
        // a patch that also sets asana.gid counts as Asana-linked.
        const merged = { ...task }
        for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) continue
            merged[k] =
                v &&
                typeof v === "object" &&
                !Array.isArray(v) &&
                task[k] &&
                typeof task[k] === "object" &&
                !Array.isArray(task[k])
                    ? { ...task[k], ...v }
                    : v
        }
        assertClosable({ ...merged, status: task.status })
        // SOC2 areas (also when this patch moves the task into one) need a
        // complete change record: 409 change_record_missing otherwise.
        await assertTaskChangeRecord(store, { ...merged, id })
        if (!(merged.asana && merged.asana.gid)) return null
        const rest = { ...patch }
        delete rest.status
        const result = Object.keys(rest).length
            ? await store.updateTask(id, rest, {
                  actor: ACTOR,
                  baseRevision,
              })
            : cur
        const { job, existing } = enqueueCloseOut(jobRunner, id)
        return {
            task: result.task,
            revision: result.revision,
            job,
            close_out: existing ? "pending" : "started",
        }
    }

    /** Known repos (<treeDir>/AGENTS.md), re-read on each call. */
    function repoList() {
        if (!repoTable) return []
        if (typeof repoTable.reset === "function") repoTable.reset()
        try {
            return repoTable.list() || []
        } catch (err) {
            log.warn({ err: err.message }, "repo table")
            return []
        }
    }

    // Owner only (not in VIEWER_GETS): the repo picker's choices.
    api.get("/repos", (req, res) => {
        res.json({
            repos: repoList().map((r) => ({
                name: r.name,
                description: r.description || null,
            })),
        })
    })

    api.patch("/tasks/:id", async (req, res) => {
        const id = parseTaskId(req.params.id)
        const body = parse(PatchBody, req.body || {})
        const patch = validateTaskPatch(body.patch || {})
        if (patch.repos) patch.repos = normalizeRepos(patch.repos, repoList())
        if (body.snooze) {
            const at = await dateParser.parseWhen(body.snooze)
            if (!at)
                throw new ValidationError("could not parse snooze", {
                    snooze: body.snooze,
                })
            patch.snooze_until = at
            if (!patch.status) patch.status = "waiting"
        }
        if (!Object.keys(patch).length) throw new ValidationError("empty patch")
        // Any snooze takes a surfaced task out of Now until it resurfaces.
        if (patch.snooze_until) Object.assign(patch, withSnoozeFlags(patch))
        // The update and its schedule changes run under the task lock, so
        // overlapping requests (two snoozes, a snooze and a due-date change)
        // can't interleave and leave a timer for an outdated state.
        const locked =
            typeof store.withTaskLock === "function"
                ? (fn) => store.withTaskLock(id, fn)
                : (fn) => fn()
        let result
        let closing = null
        await locked(async () => {
            if (patch.status === "done") {
                closing = await startCloseOut(id, patch, body.base_revision)
                if (closing) return
            }
            // A new due date (or a task turned into a reminder) moves its
            // due-date reminder.
            const dueChange = "due_at" in patch || patch.kind === "reminder"
            const before = dueChange ? (await store.getTask(id)).task : null
            result = await store.updateTask(id, patch, {
                actor: ACTOR,
                baseRevision: body.base_revision,
            })
            if (
                before &&
                (before.due_at !== result.task.due_at ||
                    before.kind !== result.task.kind)
            ) {
                await scheduler.reconcileDue(id, result.task.due_at, {
                    ensure: result.task.kind === "reminder",
                })
            }
            if (patch.snooze_until && result.task.status === "waiting") {
                const until = new Date(patch.snooze_until).getTime()
                const existing = (await scheduler.listForTask(id)) || []
                // Replace the previous snooze-end schedule, and drop plain
                // reminders that would fire (and un-snooze the task) before the
                // snooze ends. Later reminders stay.
                for (const s of existing) {
                    if (s.status !== "pending" || s.action !== "surface")
                        continue
                    const isSnooze = Boolean(s.payload && s.payload.snooze)
                    if (isSnooze || new Date(s.fire_at).getTime() < until)
                        await scheduler.cancel(s.id)
                }
                await scheduler.add({
                    task_id: id,
                    fire_at: patch.snooze_until,
                    action: "surface",
                    payload: { reason: SNOOZE_ENDED, snooze: true },
                    note: "snooze",
                })
            }
        })
        if (closing) {
            res.status(202).json(closing)
            return
        }
        res.json({ task: result.task, revision: result.revision })
    })

    /**
     * The owner looked at the task (its page stayed visible for 2 s): its
     * Now flag is cleared, whatever the reason (lifecycle.js
     * clearsWhenSeen). updated_at: the
     * version of the task the page showed; a task changed since (e.g. a
     * newer reminder fired) is left alone, and the page asks again with
     * the version it then shows.
     */
    const SeenBody = z.object({ updated_at: z.string().min(1).max(64) })
    api.post("/tasks/:id/seen", async (req, res) => {
        const id = parseTaskId(req.params.id)
        const body = parse(SeenBody, req.body || {})
        const locked =
            typeof store.withTaskLock === "function"
                ? (fn) => store.withTaskLock(id, fn)
                : (fn) => fn()
        const out = await locked(async () => {
            const { task } = await store.getTask(id)
            if (task.updated_at !== body.updated_at)
                return { cleared: false, stale: true }
            if (!clearsWhenSeen(task.flags)) return { cleared: false }
            const result = await store.updateTask(
                id,
                {
                    flags: {
                        ...task.flags,
                        now: false,
                        now_reason: null,
                        now_seen: null,
                        now_seen_id: null,
                    },
                },
                { actor: "me", reason: "seen" }
            )
            return {
                cleared: true,
                task: result.task,
                revision: result.revision,
            }
        })
        res.json(out)
    })

    // artifact
    const ArtifactBody = z.object({
        content: z.string().max(900000),
        base_revision: z.string().min(1).max(128),
    })
    api.put("/tasks/:id/artifact", async (req, res) => {
        const id = parseTaskId(req.params.id)
        const body = parse(ArtifactBody, req.body || {})
        const { revision } = await store.writeArtifact(id, body.content, {
            actor: ACTOR,
            baseRevision: body.base_revision,
        })
        res.json({ revision })
    })

    // attachments
    if (taskFiles) {
        const fileName = (raw) => {
            const name = String(raw || "")
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(name))
                throw new NotFoundError("file")
            return name
        }
        api.get("/tasks/:id/files", async (req, res) => {
            const id = parseTaskId(req.params.id)
            res.json({ files: await taskFiles.list(id) })
        })
        // raw body (application/octet-stream), the original name in ?name=
        api.post("/tasks/:id/files", async (req, res) => {
            const id = parseTaskId(req.params.id)
            if (!req.is("application/octet-stream"))
                throw new AppError(
                    "unsupported_media_type",
                    "send the file as application/octet-stream",
                    { status: 415 }
                )
            const { name, label } = parse(
                z.object({
                    name: z.string().trim().min(1).max(255),
                    label: z.string().trim().min(1).max(200).optional(),
                }),
                req.query
            )
            const length = Number(req.headers["content-length"])
            const file = await taskFiles.add(id, {
                name,
                label,
                stream: req,
                actor: ACTOR,
                size: Number.isFinite(length) ? length : undefined,
            })
            res.status(201).json({ file })
        })
        api.get("/tasks/:id/files/:name", async (req, res) => {
            const id = parseTaskId(req.params.id)
            const name = fileName(req.params.name)
            if (isViewer(req)) {
                const { task } = await store.getTask(id)
                if (!isShared(task)) throw new NotFoundError("file")
            } else await store.getTask(id)
            const file = await taskFiles.open(id, name)
            const download =
                req.query.download === "1" || !INLINE_KINDS.includes(file.kind)
            const type =
                file.kind === "markdown" || file.kind === "text"
                    ? "text/plain; charset=utf-8"
                    : file.mime
            const headers = {
                "Content-Type": type,
                "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
                "Cache-Control": "private, no-cache",
                "X-Content-Type-Options": "nosniff",
            }
            if (file.kind === "pdf" && !download) {
                // the browser's PDF viewer, framed by the task page
                headers["Content-Security-Policy"] = "frame-ancestors 'self'"
                headers["X-Frame-Options"] = "SAMEORIGIN"
            } else headers["Content-Security-Policy"] = FILE_CSP
            await new Promise((resolve, reject) =>
                // relative to the files folder: "dotfiles" then checks the
                // stored name only, not the folders above tasksDir
                res.sendFile(
                    path.basename(file.path),
                    {
                        root: path.dirname(file.path),
                        headers,
                        dotfiles: "deny",
                        lastModified: true,
                    },
                    (err) => (err && !res.headersSent ? reject(err) : resolve())
                )
            )
        })
        api.delete("/tasks/:id/files/:name", async (req, res) => {
            const id = parseTaskId(req.params.id)
            res.json(
                await taskFiles.remove(id, fileName(req.params.name), ACTOR)
            )
        })
    }

    // history
    const LimitQuery = z.object({
        limit: z.coerce.number().int().min(1).max(500).default(50),
    })
    api.get("/tasks/:id/history", async (req, res) => {
        const id = parseTaskId(req.params.id)
        const { limit } = parse(LimitQuery, req.query, "query")
        res.json({ commits: await store.getHistory(id, { limit }) })
    })
    api.get("/tasks/:id/history/:sha", async (req, res) => {
        const id = parseTaskId(req.params.id)
        if (!/^[0-9a-f]{4,64}$/i.test(req.params.sha))
            throw new ValidationError("invalid sha")
        res.json({ diff: await store.getCommitDiff(id, req.params.sha) })
    })

    // comments
    const CommentBody = z.object({
        body: z.string().trim().min(1).max(20000),
        intent: z.enum(COMMENT_INTENTS).default("note"),
        anchor: AnchorSchema.nullable().optional(),
        parent_id: z.string().min(1).max(100).nullable().optional(),
    })
    api.post("/tasks/:id/comments", async (req, res) => {
        const id = parseTaskId(req.params.id)
        const body = parse(CommentBody, req.body || {})
        const comment = await store.appendComment(
            id,
            {
                op: "create",
                parent_id: body.parent_id ?? null,
                anchor: body.anchor ?? null,
                body: body.body,
                intent: body.intent,
                author: ACTOR,
                job_id: null,
            },
            ACTOR
        )
        const out = { comment }
        if (["ask", "change", "chat"].includes(body.intent)) {
            const input = {
                comment_id: comment.id,
                message: body.body,
                intent: body.intent,
            }
            if (body.anchor) input.anchor = body.anchor
            out.job = await jobRunner.enqueue("assist", input, { task_id: id })
        }
        res.status(201).json(out)
    })
    const CommentStatusBody = z.object({
        status: z.enum(COMMENT_STATUSES),
        resolution: z.string().max(2000).nullable().optional(),
    })
    api.patch("/tasks/:id/comments/:cid", async (req, res) => {
        const id = parseTaskId(req.params.id)
        const body = parse(CommentStatusBody, req.body || {})
        const comment = await store.setCommentStatus(
            id,
            req.params.cid,
            { status: body.status, resolution: body.resolution ?? null },
            ACTOR
        )
        res.json({ comment })
    })

    // schedules
    const ScheduleBody = z
        .object({
            when: z.string().trim().min(1).max(200).optional(),
            fire_at: isoDate.optional(),
            action: z.enum(SCHEDULE_ACTIONS).default("surface"),
            note: z.string().max(500).nullable().optional(),
            payload: z.record(z.string(), z.unknown()).optional(),
        })
        .refine((v) => Boolean(v.when || v.fire_at), {
            message: "when or fire_at is required",
        })
    api.post("/tasks/:id/schedules", async (req, res) => {
        const id = parseTaskId(req.params.id)
        const body = parse(ScheduleBody, req.body || {})
        await store.getTask(id)
        let fireAt = body.fire_at
        if (!fireAt) {
            fireAt = await dateParser.parseWhen(body.when)
            if (!fireAt)
                throw new ValidationError("could not parse when", {
                    when: body.when,
                })
        }
        const schedule = await scheduler.add({
            task_id: id,
            fire_at: fireAt,
            action: body.action,
            payload: body.payload || {},
            note: body.note ?? null,
        })
        res.status(201).json({ schedule })
    })
    api.delete("/schedules/:sid", async (req, res) => {
        const sid = parseIntId(req.params.sid, "schedule")
        const ok = await scheduler.cancel(sid)
        if (ok === false) throw new NotFoundError("schedule")
        res.json({ ok: true })
    })

    // center jobs on a task
    const taskJob = (route, type) =>
        api.post(`/tasks/:id/${route}`, async (req, res) => {
            const id = parseTaskId(req.params.id)
            const { task } = await store.getTask(id)
            // enrich keeps fields Leo changed after this point (snapshot).
            let input = {}
            if (type === "enrich") {
                const art = await store.getArtifact(id)
                input = {
                    snapshot: enrichSnapshot(task),
                    baseline: { content: art.content, revision: art.revision },
                }
            }
            // close_out: a missing SOC2 change record is a 409 now, not a
            // job that fails at once (nothing it does can fill the record);
            // one at a time per task (double clicks, Done racing)
            if (type === "close_out") await assertTaskChangeRecord(store, task)
            const job =
                type === "close_out"
                    ? enqueueCloseOut(jobRunner, id).job
                    : await jobRunner.enqueue(type, input, { task_id: id })
            res.status(202).json({ job })
        })
    taskJob("asana", "asana_create")
    taskJob("close-out", "close_out")
    taskJob("enrich", "enrich")

    api.post("/command", async (req, res) => {
        const { text } = parse(
            z.object({ text: z.string().trim().min(1).max(4000) }),
            req.body || {}
        )
        const job = await jobRunner.enqueue("command", { text })
        res.status(202).json({ job })
    })

    const jobId = (raw) => {
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(raw))
            throw new ValidationError("invalid job id")
        return raw
    }
    api.get("/jobs/:id", async (req, res) => {
        const job = await jobRunner.get(jobId(req.params.id))
        if (!job) throw new NotFoundError("job")
        res.json({ job })
    })
    api.post("/jobs/:id/cancel", async (req, res) => {
        const id = jobId(req.params.id)
        if (!(await jobRunner.get(id))) throw new NotFoundError("job")
        res.json({ ok: Boolean(await jobRunner.cancel(id)) })
    })

    // settings
    api.get("/settings", async (req, res) => {
        res.json({ settings: normalizeSettings(await settingsRepo.all()) })
    })
    api.patch("/settings", async (req, res) => {
        const body = req.body
        if (!body || typeof body !== "object" || Array.isArray(body))
            throw new ValidationError("body must be an object")
        const keys = Object.keys(body)
        if (!keys.length) throw new ValidationError("no settings given")
        const unknown = keys.filter((k) => !(k in SETTINGS_SCHEMAS))
        if (unknown.length)
            throw new ValidationError("unknown settings", { keys: unknown })
        const values = {}
        for (const k of keys)
            values[k] = parse(SETTINGS_SCHEMAS[k], body[k], `setting ${k}`)
        if (values["center.models"]) {
            const current = await settingsRepo.get("center.models", {})
            values["center.models"] = {
                ...(current || {}),
                ...values["center.models"],
            }
        }
        for (const k of keys) await settingsRepo.set(k, values[k])
        const settings = normalizeSettings(await settingsRepo.all())
        bus.emit("settings.updated", { data: { settings } })
        res.json({ settings })
    })

    // pairing & devices
    api.post("/pair/code", async (req, res) => {
        res.json(await auth.createPairCode())
    })
    if (tailnet) {
        const PairBody = z.object({
            code: z
                .string()
                .trim()
                .regex(/^\d{6}$/),
            name: z.string().trim().min(1).max(80).optional(),
        })
        api.post("/pair", async (req, res) => {
            const body = parse(PairBody, req.body || {})
            const { device, token } = await auth.pair({
                code: body.code,
                name: body.name,
                login: req.auth.login,
            })
            res.setHeader(
                "Set-Cookie",
                serializeCookie(DEVICE_COOKIE, token, {
                    maxAgeMs: DEVICE_TTL_MS,
                    secure: true,
                    sameSite: "Strict",
                })
            )
            res.json({ device })
        })
    }
    api.get("/devices", async (req, res) => {
        const list = (await devicesRepo.list()) || []
        res.json({ devices: list.map(publicDevice) })
    })
    api.delete("/devices/:id", async (req, res) => {
        const raw = req.params.id
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw))
            throw new ValidationError("invalid device id")
        const id = /^\d+$/.test(raw) ? Number(raw) : raw
        const ok = await devicesRepo.revoke(id)
        if (ok === false) throw new NotFoundError("device")
        // Owner SSE streams opened with this device end now.
        auth.endDeviceStreams?.(id)
        for (const fn of onDeviceRevoked) {
            try {
                await fn(id)
            } catch (err) {
                log.warn({ err: err.message, device: id }, "device revoke hook")
            }
        }
        res.json({ ok: true })
    })

    // local-only bearer endpoints
    if (!tailnet) {
        api.post("/auth/bootstrap-token", (req, res) => {
            if (req.auth.via !== "bearer")
                throw new ForbiddenError("bearer token required")
            const { token, expires_at } = auth.createBootstrapToken()
            // Host was validated by the host guard (loopback only here).
            const host = req.ccHost || ""
            const base = /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)
                ? `http://${host}`
                : `http://${config.listeners.local.host}:${config.listeners.local.port}`
            res.json({
                url: `${base}/auth/bootstrap?t=${token}`,
                expires_at: expires_at.toISOString(),
            })
        })
        api.post("/auth/logout", (req, res) => {
            auth.revokeSession(parseCookies(req.headers.cookie)[SESSION_COOKIE])
            res.setHeader(
                "Set-Cookie",
                serializeCookie(SESSION_COOKIE, "", { maxAgeMs: 0 })
            )
            res.json({ ok: true })
        })
    }

    // maintenance (cc reindex)
    api.post("/admin/reindex", async (req, res) => {
        res.json(await store.reindex())
    })

    // phase 2/3 route modules (workers, github, agent tools, push, digest...)
    const helpers = {
        mode,
        tailnet,
        ACTOR,
        isViewer,
        parse,
        parseTaskId,
    }
    for (const mount of mounts) mount(api, helpers)

    api.use((req, res) => {
        res.status(404).json({ error: "not_found", message: "no such route" })
    })
    app.use("/api", api)

    // ---- static SPA ------------------------------------------------------

    const webDist = config.webDist
    if (webDist && fs.existsSync(path.join(webDist, "index.html"))) {
        app.use(express.static(webDist, { index: "index.html" }))
        app.use((req, res, next) => {
            if (req.method !== "GET" && req.method !== "HEAD") return next()
            if (/^\/(api|auth|mcp|healthz)(\/|$)/.test(req.path)) return next()
            res.sendFile(path.join(webDist, "index.html"))
        })
    }

    app.use((req, res) => {
        res.status(404).json({ error: "not_found", message: "no such route" })
    })

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        const { status, body } = mapError(err)
        // not_configured (no publicBaseUrl) is logged once by the host guard.
        if (status >= 500 && body.error !== "not_configured")
            log.error(
                { err: err && err.message, stack: err && err.stack },
                "request failed"
            )
        if (res.headersSent) {
            res.end()
            return
        }
        res.status(status).json(body)
    })

    return app
}
