/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Worker → center tools (docs/04 "Worker → center: MCP tools",
// docs/implementation/phase2-contracts.md D). Pure handlers shared by the
// MCP server (/mcp) and the REST mirror (POST /api/agent/:tool).
//
// Each handler is (args, ctx) -> plain JSON result and throws AppError.
// ctx = { callerTaskId?, agent?, actor? }: callerTaskId is the X-CC-Task
// header (a write for another task is a 403 wrong_task), agent the
// X-CC-Agent header. The actor is "agent:<name>" from the header, else the
// task's live session name, else "agent:unknown".

import { z } from "zod"
import { ActorSchema, LINK_TYPES, taskKey } from "../contracts/schemas.js"
import { newLinkId } from "../agent/jobs/util.js"
import {
    parseChangeRecord,
    requiresChangeRecord,
    SOC2_SECTION,
} from "../phase3/soc2.js"
import {
    AppError,
    NotFoundError,
    StaleRevisionError,
    ValidationError,
} from "../util/errors.js"
import { systemClock } from "../util/clock.js"
import { nullLogger } from "../util/logger.js"

const TaskIdSchema = z
    .union([z.number().int().positive(), z.string().min(1).max(20)])
    .describe('Task id: 123 or "T-123"')
const text = (max) => z.string().trim().min(1).max(max)
const COMMENT_KINDS = ["review_comment", "review", "issue_comment"]
const REPORT_STATUSES = ["ready_for_pr", "review", "blocked", "progress"]
const FEEDBACK_STATUSES = ["fixed", "answered", "declined"]
const SCHEDULE_ACTIONS = ["surface", "prompt_agent", "center_job"]
const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,200}$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
const SHA_RE = /^[0-9a-f]{7,40}$/i
const ISO_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/
const AGENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** zod input schemas, one per tool (also used for the MCP tool listing). */
export const TOOL_SCHEMAS = {
    cc_get_task: z.object({ task_id: TaskIdSchema }),
    cc_update_artifact: z.object({
        task_id: TaskIdSchema,
        section: text(80).describe('Section name without "## ", e.g. Progress'),
        op: z.enum(["replace", "append"]),
        content: z.string().max(200000),
        base_revision: z
            .string()
            .min(1)
            .max(128)
            .optional()
            .describe(
                "Artifact revision from cc_get_task or the last write; required for replace"
            ),
    }),
    cc_log_decision: z.object({
        task_id: TaskIdSchema,
        decision: text(2000),
        rationale: text(4000),
    }),
    cc_add_link: z.object({
        task_id: TaskIdSchema,
        // files are attached with cc_attach_file (copied into the task)
        type: z.enum(LINK_TYPES.filter((t) => t !== "file")),
        url: text(2000).describe(
            "URL; the branch name for type=branch; the folder path for type=folder"
        ),
        label: z.string().trim().max(200).optional(),
        role: z.enum(["main", "ref", "work"]).optional(),
        repo: z
            .string()
            .regex(REPO_RE)
            .optional()
            .describe("Repo name (required for type=branch)"),
        branch: z
            .string()
            .regex(BRANCH_RE)
            .optional()
            .describe(
                "type=folder role=work: the branch checked out there (default: the branch registered for the repo, else the task branch)"
            ),
    }),
    cc_report: z.object({
        task_id: TaskIdSchema,
        status: z.enum(REPORT_STATUSES),
        summary: text(20000),
        work_repos: z.array(z.string().regex(REPO_RE)).max(50).optional(),
        no_change_repos: z
            .array(z.string().regex(REPO_RE))
            .max(50)
            .optional()
            .describe(
                "review / ready_for_pr: repos (deliverables) that need no change: nothing to commit or PR there"
            ),
        checks: z
            .union([z.string().max(4000), z.array(z.string().max(1000))])
            .optional(),
        next_steps: z.string().max(4000).optional(),
    }),
    cc_feedback: z.object({
        task_id: TaskIdSchema,
        item_id: text(200),
        status: z.enum(FEEDBACK_STATUSES),
        commit: z.string().regex(SHA_RE).optional(),
        reply_url: z.string().max(2000).optional(),
        note: z.string().max(4000).optional(),
    }),
    cc_schedule: z.object({
        task_id: TaskIdSchema,
        at: text(200).describe(
            'ISO time or a phrase ("in 30m", "tomorrow 9am")'
        ),
        action: z.enum(SCHEDULE_ACTIONS),
        prompt: z.string().trim().max(4000).optional(),
    }),
    cc_create_task: z.object({
        title: text(300),
        details: z.string().max(20000).optional(),
        parent_id: TaskIdSchema.optional(),
    }),
    cc_attach_file: z.object({
        task_id: TaskIdSchema,
        path: text(4000).describe(
            "Absolute path of a file in your task folders (or a temp folder)"
        ),
        label: z.string().trim().min(1).max(200).optional(),
    }),
}

export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS)

export const TOOL_DESCRIPTIONS = {
    cc_get_task:
        "Task brief: task (repos, branch, slug, status), artifact + revision, open comments, links, deliverables, open PR feedback items, Asana URL, attached files (with their local path).",
    cc_update_artifact:
        "Replace or append one artifact section. replace requires base_revision (stale_revision returns the current revision and content); append may omit it.",
    cc_log_decision:
        'Append "date · author · decision · rationale" to the Decisions section.',
    cc_add_link:
        "Register a folder (role ref|work; work adds a deliverable), branch (with repo; checked for uniqueness before you create it), PR (claimed against the task), or doc link.",
    cc_report:
        "Report status: ready_for_pr (requires work_repos), review (non-code result), blocked, or progress. The summary is appended to Progress. With review or ready_for_pr, no_change_repos marks deliverables that need no change (so the task can close without a PR there).",
    cc_feedback:
        "Resolve one PR feedback item: fixed (commit), answered or declined (reply_url for comment/review items). ci_failure: fixed (commit) or declined (reply_url).",
    cc_schedule:
        "Ask to be woken later: surface (back to Leo's Now), prompt_agent (prompt sent to you), center_job (the center agent answers prompt on the task).",
    cc_create_task: "Create a spin-off task in Leo's inbox.",
    cc_attach_file:
        "Attach a file (screenshot, video, report .md, PDF, log) to the task: it is copied next to the artifact, listed in its Attachments section (images and videos shown inline) and in the task's Files tab. Only files under the tree folder or a temp folder. Max 250 MB.",
}

function validate(schema, value) {
    const res = schema.safeParse(value ?? {})
    if (!res.success)
        throw new ValidationError("invalid arguments", {
            issues: res.error.issues,
        })
    return res.data
}

/** 123 | "123" | "T-123" -> 123. */
export function toTaskId(raw) {
    const m = /^(?:T-)?(\d{1,9})$/i.exec(String(raw ?? "").trim())
    const id = m ? Number(m[1]) : 0
    if (!id) throw new ValidationError("invalid task id", { task_id: raw })
    return id
}

/** One line, whitespace collapsed (for bullet lines). */
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim()

/** Multi-line text indented under a list item. */
const indent = (s) => String(s).trim().split("\n").join("\n  ")

/** Request headers -> tool ctx ({ callerTaskId, agent }). */
export function contextFromHeaders(headers = {}) {
    const get = (name) => {
        const v = headers[name]
        const s = Array.isArray(v) ? v[0] : v
        return typeof s === "string" && s.trim() ? s.trim() : null
    }
    return { callerTaskId: get("x-cc-task"), agent: get("x-cc-agent") }
}

/** "t123-x" | "agent:t123-x" -> "agent:t123-x"; invalid -> null. */
export function agentActor(name) {
    if (typeof name !== "string") return null
    const bare = name
        .trim()
        .toLowerCase()
        .replace(/^agent:/, "")
    return AGENT_RE.test(bare) ? `agent:${bare}` : null
}

/**
 * @param {object} deps
 * @param {object} deps.store          contracts store
 * @param {object} deps.scheduler      add()
 * @param {object} deps.dateParser     parseWhen()
 * @param {object} [deps.identity]     checkBranch()
 * @param {object} [deps.prWatcher]    claim(), roundResolved()
 * @param {object} [deps.workerService] agentState()
 * @param {object} [deps.notifier]     notify()
 * @param {object} [deps.bus]          emit(); feedback.updated after cc_feedback
 * @param {object} [deps.taskFiles]  task attachments (cc_attach_file)
 * @param {object} [deps.clock]
 * @param {object} [deps.log]
 */
export function createAgentTools({
    store,
    scheduler,
    dateParser,
    identity = null,
    prWatcher = null,
    workerService = null,
    notifier = null,
    bus = null,
    taskFiles = null,
    clock = systemClock,
    log = nullLogger,
}) {
    const nowIso = () => clock.now().toISOString()
    const today = () => nowIso().slice(0, 10)
    const locked = (id, fn) =>
        typeof store.withTaskLock === "function"
            ? store.withTaskLock(id, fn)
            : fn()

    function checkCaller(taskId, ctx) {
        const raw = ctx && ctx.callerTaskId
        if (raw === undefined || raw === null || raw === "") return
        const m = /^(?:T-)?(\d{1,9})$/i.exec(String(raw).trim())
        if (!m || Number(m[1]) !== taskId)
            throw new AppError(
                "wrong_task",
                `this session works on ${m ? taskKey(Number(m[1])) : raw}, not ${taskKey(taskId)}`,
                {
                    status: 403,
                    details: { caller: String(raw), task_id: taskId },
                }
            )
    }

    async function resolveActor(taskId, ctx = {}) {
        if (
            typeof ctx.actor === "string" &&
            ctx.actor.startsWith("agent:") &&
            ActorSchema.safeParse(ctx.actor).success
        )
            return ctx.actor
        const fromHeader = agentActor(ctx.agent)
        if (fromHeader) return fromHeader
        if (taskId && workerService && workerService.agentState) {
            try {
                const st = await workerService.agentState(taskId)
                const fromSession = agentActor(st && st.name)
                if (fromSession) return fromSession
            } catch (err) {
                log.debug({ err: err.message }, "agentState failed")
            }
        }
        return "agent:unknown"
    }

    /** Validate, check the caller, load the task, resolve the actor. */
    async function begin(name, args, ctx) {
        const a = validate(TOOL_SCHEMAS[name], args)
        const taskId = toTaskId(a.task_id)
        checkCaller(taskId, ctx)
        const cur = await store.getTask(taskId)
        const actor = await resolveActor(taskId, ctx)
        return { a, taskId, task: cur.task, actor }
    }

    async function notify(title, task, body) {
        if (!notifier) return
        try {
            await notifier.notify({
                title,
                body: body || `${taskKey(task.id)} ${task.title}`,
                sound: "request",
                url: `/t/${task.id}`,
            })
        } catch (err) {
            log.warn({ err: err.message }, "notify failed")
        }
    }

    async function appendSection(taskId, section, content, actor) {
        return store.updateArtifactSection(
            taskId,
            { section, op: "append", content },
            actor
        )
    }

    // Partial flags: updateTask merges plain objects, so concurrent flag
    // changes (enriching, error) are kept.
    function nowFlags(reason) {
        return { now: true, now_reason: reason }
    }

    function mainRepoOf(task) {
        const repos = task.repos || []
        return (repos.find((r) => r.role === "main") || repos[0] || null)?.name
    }

    function makeLink({ type, url, label, role }, actor) {
        return {
            id: newLinkId(),
            type,
            url,
            label: label || null,
            role: role || null,
            added_by: actor,
            at: nowIso(),
        }
    }

    /** Add a link (or update label/role of the same type+url) in a patch. */
    function withLink(task, link) {
        const links = [...(task.links || [])]
        const i = links.findIndex(
            (l) => l.type === link.type && l.url === link.url
        )
        if (i === -1) {
            links.push(link)
            return { links, link }
        }
        const merged = {
            ...links[i],
            label: link.label ?? links[i].label,
            role: link.role ?? links[i].role,
        }
        links[i] = merged
        return { links, link: merged }
    }

    // ---- tools ----------------------------------------------------------

    async function cc_get_task(args, ctx = {}) {
        const { taskId, task } = await begin("cc_get_task", args, ctx)
        const [artifact, comments, feedback] = await Promise.all([
            store.getArtifact(taskId),
            store.listComments(taskId),
            store.listFeedback(taskId),
        ])
        return {
            task,
            revision: artifact.revision,
            artifact: artifact.content,
            open_comments: (comments || []).filter(
                (c) => c.status === "open" || c.status === "working"
            ),
            links: task.links || [],
            deliverables: task.deliverables || [],
            feedback_open: (feedback || []).filter((f) => f.status === "open"),
            asana_url: (task.asana && task.asana.url) || null,
            files: taskFiles ? await taskFiles.list(taskId, task) : [],
        }
    }

    async function cc_attach_file(args, ctx = {}) {
        const { a, taskId, actor } = await begin("cc_attach_file", args, ctx)
        if (!taskFiles)
            throw new AppError(
                "unavailable",
                "file attachments are not set up",
                {
                    status: 503,
                }
            )
        const file = await taskFiles.addFromPath(taskId, a.path, {
            actor,
            label: a.label,
        })
        return { ok: true, file }
    }

    async function cc_update_artifact(args, ctx = {}) {
        const { a, taskId, actor } = await begin(
            "cc_update_artifact",
            args,
            ctx
        )
        if (a.op === "replace" && !a.base_revision)
            throw new ValidationError(
                "base_revision is required for replace (get it from cc_get_task)"
            )
        if (/^#/.test(a.section))
            throw new ValidationError('section name without "#"')
        try {
            const res = await store.updateArtifactSection(
                taskId,
                {
                    section: a.section,
                    op: a.op,
                    content: a.content,
                    baseRevision: a.base_revision,
                },
                actor
            )
            return { revision: res.revision }
        } catch (err) {
            if (!(err instanceof StaleRevisionError)) throw err
            const cur = err.current || {}
            throw new AppError(
                "stale_revision",
                "the artifact changed since base_revision; re-apply your edit to the current content",
                {
                    status: 409,
                    details: {
                        revision: cur.revision ?? null,
                        content: cur.content ?? null,
                    },
                }
            )
        }
    }

    async function cc_log_decision(args, ctx = {}) {
        const { a, taskId, actor } = await begin("cc_log_decision", args, ctx)
        const line = `- ${today()} · ${actor} · ${oneLine(a.decision)} · ${oneLine(a.rationale)}`
        const res = await appendSection(taskId, "Decisions", line, actor)
        return { revision: res.revision, line }
    }

    const conflictPrefix = "Branch conflict: "

    /**
     * Check a branch for repo: the head of a PR this task has claimed is
     * accepted as is (it exists on the remote by definition); anything else
     * goes through identity.checkBranch. -> { ok:true } | { ok:false,
     * conflict, suggestion }.
     */
    async function acceptBranch(taskId, repo, branch) {
        if (
            prWatcher &&
            typeof prWatcher.ownsBranch === "function" &&
            prWatcher.ownsBranch(taskId, repo, branch)
        )
            return { ok: true }
        if (!identity) throw unavailable("branch checks")
        const check = await identity.checkBranch(repo, branch, taskId)
        if (check && check.ok) return { ok: true }
        return {
            ok: false,
            conflict: (check && check.reason) || "branch rejected",
            suggestion: (check && check.suggestion) || null,
        }
    }

    /** Raise Now for a rejected branch. */
    function flagConflict(taskId, repo, branch, conflict, actor) {
        return store.updateTask(
            taskId,
            { flags: nowFlags(`${conflictPrefix}${branch} in ${repo}`) },
            { actor, reason: `branch conflict: ${conflict}` }
        )
    }

    /**
     * Flags patch clearing a "Branch conflict: … in <repo>" Now flag once a
     * branch for that repo is accepted; null when the flag is something else.
     */
    function clearConflict(task, repo) {
        const reason = (task.flags && task.flags.now_reason) || ""
        return reason.startsWith(conflictPrefix) &&
            reason.endsWith(` in ${repo}`)
            ? { now: false, now_reason: null }
            : null
    }

    async function addBranch(a, taskId, actor) {
        if (!a.repo)
            throw new ValidationError("repo is required for type=branch")
        if (!BRANCH_RE.test(a.url))
            throw new ValidationError("invalid branch name", { branch: a.url })
        const check = await acceptBranch(taskId, a.repo, a.url)
        if (!check.ok) {
            await flagConflict(taskId, a.repo, a.url, check.conflict, actor)
            return check
        }
        return locked(taskId, async () => {
            const { task } = await store.getTask(taskId)
            const patch = {}
            const cleared = clearConflict(task, a.repo)
            if (cleared) patch.flags = cleared
            if (a.repo === mainRepoOf(task)) patch.branch = a.url
            const deliverables = task.deliverables || []
            if (deliverables.some((d) => d.repo === a.repo))
                patch.deliverables = deliverables.map((d) =>
                    d.repo === a.repo ? { ...d, branch: a.url } : d
                )
            // The label is the repo: work folders look up a repo's branch
            // by it (repoBranch).
            const { links, link } = withLink(
                task,
                makeLink({ ...a, label: a.repo }, actor)
            )
            patch.links = links
            await store.updateTask(taskId, patch, {
                actor,
                reason: `branch ${a.url} in ${a.repo}`,
            })
            return { ok: true, link, branch: a.url, repo: a.repo }
        })
    }

    /** Folder basename. */
    const baseName = (p) => String(p).replace(/\/+$/, "").split("/").pop() || ""

    /**
     * "<repo>--<branch>--<slug>" folder name parts, or null. The branch part
     * is NOT the branch (folder names replace "/" with "-"); it is only
     * used to tell a task note's branch from identity's name fallback.
     */
    function parseFolder(p) {
        const m = /^([A-Za-z0-9._-]+?)--(.+)--([a-z0-9]+)$/.exec(baseName(p))
        return m ? { repo: m[1], nameBranch: m[2], slug: m[3] } : null
    }

    /** Branch registered for repo with cc_add_link(type=branch), or null. */
    function repoBranch(task, repo) {
        const link = (task.links || [])
            .filter((l) => l.type === "branch" && l.label === repo)
            .at(-1)
        return link ? link.url : null
    }

    /** Branch from the folder's task note (.git/agent-task.md), or null. */
    async function noteBranch(task, folder, parsed) {
        if (!identity || !identity.scanFolders || !task.slug) return null
        let entries
        try {
            entries = await identity.scanFolders(task.slug)
        } catch (err) {
            log.debug({ err: err.message }, "scanFolders failed")
            return null
        }
        const name = baseName(folder)
        const e = (entries || []).find((x) => x.folder === name)
        if (!e || !e.branch) return null
        // scanFolders falls back to the folder-name part when there is no
        // note; that is not a branch name (slashes are lost).
        const fromName = parsed && e.branch === parsed.nameBranch
        return fromName && !e.status ? null : e.branch
    }

    /**
     * Branch of a new work deliverable: explicit arg -> the repo's
     * registered branch -> task.branch -> the folder's task note. Never the
     * folder name. Any branch that is not already registered for THIS repo
     * (including one inherited from task.branch or the note) is checked for
     * this repo: unique across tasks and absent on the remote. Returns
     * { branch } or { conflict, suggestion, branch }.
     */
    async function workBranch(a, task, repo, parsed, taskId) {
        const registered = repoBranch(task, repo)
        const branch =
            a.branch ||
            registered ||
            task.branch ||
            (await noteBranch(task, a.url, parsed))
        if (!branch)
            throw new ValidationError(
                "no branch known for this work folder; pass branch=<the branch checked out there>"
            )
        if (branch !== registered) {
            const check = await acceptBranch(taskId, repo, branch)
            if (!check.ok) return { branch, ...check }
        }
        return { branch }
    }

    async function addFolder(a, taskId, actor) {
        return locked(taskId, async () => {
            const { task } = await store.getTask(taskId)
            const parsed = parseFolder(a.url)
            const repo = a.repo || (parsed && parsed.repo)
            const patch = {}
            let deliverable = null
            if (a.role === "work") {
                if (!repo)
                    throw new ValidationError(
                        "repo is required for a work folder (or name it <repo>--<branch>--<slug>)"
                    )
                const deliverables = task.deliverables || []
                deliverable = deliverables.find((d) => d.repo === repo) || null
                if (
                    deliverable &&
                    a.branch &&
                    a.branch !== deliverable.branch
                ) {
                    // The agent names the branch checked out there: move the
                    // deliverable to it (same checks as type=branch).
                    const check = await acceptBranch(taskId, repo, a.branch)
                    if (!check.ok) {
                        await flagConflict(
                            taskId,
                            repo,
                            a.branch,
                            check.conflict,
                            actor
                        )
                        return check
                    }
                    deliverable = { ...deliverable, branch: a.branch }
                    patch.deliverables = deliverables.map((d) =>
                        d.repo === repo ? deliverable : d
                    )
                    if (repo === mainRepoOf(task)) patch.branch = a.branch
                }
                // The branch named is the deliverable's (moved just now, or
                // already by a PR claim): a conflict for the repo is over.
                if (deliverable && a.branch) {
                    const cleared = clearConflict(task, repo)
                    if (cleared) patch.flags = cleared
                }
                if (!deliverable) {
                    const wb = await workBranch(a, task, repo, parsed, taskId)
                    if (wb.conflict) {
                        await flagConflict(
                            taskId,
                            repo,
                            wb.branch,
                            wb.conflict,
                            actor
                        )
                        return {
                            ok: false,
                            conflict: wb.conflict,
                            suggestion: wb.suggestion,
                        }
                    }
                    const branch = wb.branch
                    deliverable = {
                        repo,
                        branch,
                        role: "work",
                        created_at: nowIso(),
                        disposition: "pending",
                        pr: null,
                        claimed_at: null,
                        merged_at: null,
                    }
                    patch.deliverables = [...deliverables, deliverable]
                    const cleared = clearConflict(task, repo)
                    if (cleared) patch.flags = cleared
                }
                const repos = task.repos || []
                const ref = repos.find((r) => r.name === repo)
                if (!ref) patch.repos = [...repos, { name: repo, role: "work" }]
                else if (ref.role === "ref")
                    patch.repos = repos.map((r) =>
                        r.name === repo ? { ...r, role: "work" } : r
                    )
            }
            const { links, link } = withLink(
                task,
                makeLink({ ...a, label: a.label || repo || null }, actor)
            )
            patch.links = links
            await store.updateTask(taskId, patch, {
                actor,
                reason: `folder ${a.url}${a.role ? ` (${a.role})` : ""}`,
            })
            return { ok: true, link, deliverable }
        })
    }

    async function cc_add_link(args, ctx = {}) {
        const { a, taskId, actor } = await begin("cc_add_link", args, ctx)
        if (a.type === "branch") return addBranch(a, taskId, actor)
        if (a.type === "folder") return addFolder(a, taskId, actor)
        if (a.type === "pr") {
            if (!prWatcher) throw unavailable("PR watcher")
            const res = await prWatcher.claim(taskId, a.url, {
                manual: false,
                reported: true,
                actor,
            })
            return { ...res }
        }
        return locked(taskId, async () => {
            const { task } = await store.getTask(taskId)
            const { links, link } = withLink(task, makeLink(a, actor))
            await store.updateTask(
                taskId,
                { links },
                { actor, reason: `link ${a.type}` }
            )
            return { ok: true, link }
        })
    }

    function sameSet(a, b) {
        const x = new Set(a)
        const y = new Set(b)
        return x.size === y.size && [...x].every((v) => y.has(v))
    }

    /**
     * The agent says these deliverables need no change: pending ->
     * no_change (like Leo's "No change" button), under the task lock.
     * Unknown repos and repos that already have a PR are rejected; repos
     * already no_change are left as they are.
     */
    async function markNoChange(taskId, repos, actor) {
        const same = (x, y) => x.toLowerCase() === y.toLowerCase()
        const changed = await locked(taskId, async () => {
            const { task: cur } = await store.getTask(taskId)
            const dl = cur.deliverables || []
            const unknown = repos.filter(
                (r) => !dl.some((d) => same(d.repo, r))
            )
            if (unknown.length)
                throw new ValidationError(
                    `not deliverables of T-${taskId}: ${unknown.join(", ")}`,
                    { repos: unknown }
                )
            const withPr = dl.filter(
                (d) =>
                    repos.some((r) => same(d.repo, r)) && d.disposition === "pr"
            )
            if (withPr.length)
                throw new AppError(
                    "invalid_state",
                    `already has a PR: ${withPr.map((d) => d.repo).join(", ")}`,
                    { status: 409 }
                )
            const hit = dl
                .filter(
                    (d) =>
                        d.disposition === "pending" &&
                        repos.some((r) => same(d.repo, r))
                )
                .map((d) => d.repo)
            if (!hit.length) return []
            await store.updateTask(
                taskId,
                {
                    deliverables: dl.map((d) =>
                        hit.includes(d.repo)
                            ? { ...d, disposition: "no_change" }
                            : d
                    ),
                },
                { actor, reason: `no change: ${hit.join(", ")}` }
            )
            return hit
        })
        for (const repo of changed)
            await store.appendEvent(
                taskId,
                { type: "deliverable_no_change", data: { repo } },
                actor
            )
        return changed
    }

    /**
     * For a SOC2-area task whose change record is incomplete: the missing
     * labels and a reminder, returned with a review / ready_for_pr report
     * (the task can't be done until they are filled).
     */
    async function changeRecordHint(taskId, task) {
        if (!requiresChangeRecord(task)) return {}
        const { missing } = parseChangeRecord(await store.getArtifact(taskId))
        if (!missing.length) return {}
        return {
            change_record_missing: missing,
            note: `T-${taskId} (${task.area}) can't be done without a SOC2 change record: fill ${missing.join(", ")} in "${SOC2_SECTION}" with cc_update_artifact.`,
        }
    }

    async function cc_report(args, ctx = {}) {
        const { a, taskId, task, actor } = await begin("cc_report", args, ctx)
        if (a.status === "ready_for_pr" && !(a.work_repos || []).length)
            throw new ValidationError(
                "work_repos is required for ready_for_pr (every repo with staged changes)"
            )
        const noChange = a.no_change_repos || []
        if (noChange.length) {
            if (a.status !== "review" && a.status !== "ready_for_pr")
                throw new ValidationError(
                    "no_change_repos goes with status review or ready_for_pr"
                )
            const both = noChange.filter((r) =>
                (a.work_repos || []).some(
                    (w) => w.toLowerCase() === r.toLowerCase()
                )
            )
            if (both.length)
                throw new ValidationError(
                    `a repo can't be both changed and unchanged: ${both.join(", ")}`
                )
            await markNoChange(taskId, noChange, actor)
        }
        const lines = [
            `- ${nowIso()} · ${actor} · ${a.status}: ${indent(a.summary)}`,
        ]
        if (a.work_repos && a.work_repos.length)
            lines.push(`  - Work repos: ${a.work_repos.join(", ")}`)
        if (noChange.length)
            lines.push(`  - No change needed: ${noChange.join(", ")}`)
        if (a.checks && a.checks.length) {
            const checks = Array.isArray(a.checks)
                ? a.checks.map(oneLine).join("; ")
                : indent(a.checks)
            lines.push(`  - Checks: ${checks}`)
        }
        if (a.next_steps && a.next_steps.trim())
            lines.push(`  - Next steps: ${indent(a.next_steps)}`)
        const art = await appendSection(
            taskId,
            "Progress",
            lines.join("\n"),
            actor
        )
        await store.appendEvent(
            taskId,
            {
                type: "agent_report",
                data: {
                    status: a.status,
                    summary: oneLine(a.summary).slice(0, 300),
                    ...(a.work_repos ? { work_repos: a.work_repos } : {}),
                    ...(noChange.length ? { no_change_repos: noChange } : {}),
                },
            },
            actor
        )
        const hint =
            a.status === "review" || a.status === "ready_for_pr"
                ? await changeRecordHint(taskId, task)
                : {}
        const result = {
            ok: true,
            status: task.status,
            revision: art.revision,
            ...hint,
        }

        if (a.status === "progress") return result

        if (a.status === "ready_for_pr") {
            // repos marked no_change (by Leo, or just now) need no PR
            const current = noChange.length
                ? (await store.getTask(taskId)).task
                : task
            const deliverables = (current.deliverables || [])
                .filter((d) => d.disposition !== "no_change")
                .map((d) => d.repo)
            if (!sameSet(a.work_repos, deliverables)) {
                const reason = `Work repos differ: reported ${a.work_repos.join(", ")}; deliverables ${deliverables.join(", ") || "none"}`
                await store.updateTask(
                    taskId,
                    { flags: nowFlags(reason) },
                    { actor, reason: "ready_for_pr: work repos differ" }
                )
                await notify("Work repos differ", task)
                return {
                    ...result,
                    ok: false,
                    mismatch: { reported: a.work_repos, deliverables },
                }
            }
            const res = await store.updateTask(
                taskId,
                { status: "ready_for_pr", flags: nowFlags("Ready for PR") },
                { actor, reason: "agent report" }
            )
            await notify("Ready for PR", task)
            return { ...result, status: res.task.status }
        }

        if (a.status === "review") {
            const res = await store.updateTask(
                taskId,
                { status: "review", flags: nowFlags("Ready for review") },
                { actor, reason: "agent report" }
            )
            return { ...result, status: res.task.status }
        }

        // blocked
        const reason = `Agent blocked: ${oneLine(a.summary).slice(0, 120)}`
        await store.updateTask(
            taskId,
            { flags: nowFlags(reason) },
            { actor, reason: "agent blocked" }
        )
        await notify("Agent needs you", task, reason)
        return result
    }

    async function cc_feedback(args, ctx = {}) {
        const { a, taskId, task, actor } = await begin("cc_feedback", args, ctx)
        if (a.reply_url && !/^https:\/\/\S+$/.test(a.reply_url))
            throw new ValidationError("reply_url must be an https URL")
        const outcome = await locked(taskId, async () => {
            const items = await store.listFeedback(taskId)
            const item = items.find((i) => i.id === a.item_id)
            if (!item) throw new NotFoundError(`feedback item ${a.item_id}`)
            if (item.status !== "open")
                throw new AppError(
                    "item_not_open",
                    `feedback item ${a.item_id} is ${item.status}, not open`,
                    { status: 409, details: { status: item.status } }
                )
            const missing = []
            if (item.kind === "ci_failure" && a.status === "answered")
                throw new ValidationError(
                    "a ci_failure can only be fixed or declined"
                )
            if (a.status === "fixed" && !a.commit) missing.push("commit")
            const needsReply =
                COMMENT_KINDS.includes(item.kind) ||
                (item.kind === "ci_failure" && a.status === "declined")
            if (needsReply && !a.reply_url) missing.push("reply_url")
            if (missing.length)
                throw new ValidationError(
                    `${item.kind} ${a.status} requires ${missing.join(" and ")}`,
                    { missing }
                )
            const rec = { ...item }
            delete rec.at
            const saved = await store.appendFeedback(
                taskId,
                {
                    ...rec,
                    status: a.status,
                    commit: a.commit ?? null,
                    reply_url: a.reply_url ?? null,
                    note: a.note ?? null,
                    verified: false,
                },
                actor
            )
            const round = items
                .filter((i) => i.round === item.round)
                .map((i) => (i.id === item.id ? saved : i))
            const resolved = round.every((i) => i.status !== "open")
            if (a.status === "declined") {
                await store.updateTask(
                    taskId,
                    { flags: nowFlags(`Agent declined feedback ${item.id}`) },
                    { actor, reason: `declined ${item.id}` }
                )
            }
            return { saved, resolved, round: item.round }
        })
        if (a.status === "declined")
            await notify(
                "Agent declined PR feedback",
                task,
                `${taskKey(taskId)} ${a.item_id}: ${oneLine(a.note || "").slice(0, 200)}`
            )
        // Every resolution refreshes open task pages (appendFeedback only
        // persists; roundResolved runs for the last item of a round only).
        if (bus) {
            try {
                bus.emit("feedback.updated", { task_id: taskId, data: {} })
            } catch (err) {
                log.warn({ err: err.message }, "feedback.updated emit failed")
            }
        }
        if (outcome.resolved && prWatcher) await prWatcher.roundResolved(taskId)
        return {
            ok: true,
            item: outcome.saved,
            round: outcome.round,
            round_resolved: outcome.resolved,
        }
    }

    async function cc_schedule(args, ctx = {}) {
        const { a, taskId, actor } = await begin("cc_schedule", args, ctx)
        if (a.action === "prompt_agent" && !a.prompt)
            throw new ValidationError("prompt is required for prompt_agent")
        if (a.action === "center_job" && !a.prompt)
            throw new ValidationError("prompt is required for center_job")
        let fireAt = null
        if (ISO_RE.test(a.at) && !Number.isNaN(Date.parse(a.at)))
            fireAt = new Date(a.at).toISOString()
        else fireAt = await dateParser.parseWhen(a.at)
        if (!fireAt)
            throw new ValidationError("could not parse at", { at: a.at })
        let payload
        if (a.action === "surface")
            payload = {
                reason: a.prompt
                    ? `Follow-up: ${oneLine(a.prompt).slice(0, 200)}`
                    : "Agent follow-up",
            }
        else if (a.action === "prompt_agent") payload = { prompt: a.prompt }
        else
            payload = {
                job_type: "assist",
                input: {
                    intent: "ask",
                    message: `Scheduled request from ${actor}: ${a.prompt}`,
                },
            }
        payload.requested_by = actor
        const schedule = await scheduler.add({
            task_id: taskId,
            fire_at: fireAt,
            action: a.action,
            payload,
            note: `requested by ${actor}`,
        })
        return { ok: true, schedule }
    }

    async function cc_create_task(args, ctx = {}) {
        const a = validate(TOOL_SCHEMAS.cc_create_task, args)
        let parentId = null
        if (a.parent_id !== undefined) {
            parentId = toTaskId(a.parent_id)
            checkCaller(parentId, ctx)
        } else if (ctx.callerTaskId) {
            parentId = toTaskId(ctx.callerTaskId)
        }
        if (parentId) await store.getTask(parentId)
        const actor = await resolveActor(parentId, ctx)
        const details = (a.details || "").trim()
        const input = {
            title: a.title,
            text: details ? `${a.title}\n\n${details}` : a.title,
            source_type: "manual",
        }
        if (parentId)
            input.links = [
                makeLink(
                    {
                        type: "doc",
                        url: `/t/${parentId}`,
                        label: `spun off from ${taskKey(parentId)}`,
                    },
                    actor
                ),
            ]
        const { task } = await store.createTask(input, actor)
        if (parentId)
            await store.appendEvent(
                parentId,
                { type: "spun_off", data: { task_id: task.id } },
                actor
            )
        return {
            ok: true,
            task: { id: task.id, title: task.title, status: task.status },
        }
    }

    return {
        cc_get_task,
        cc_update_artifact,
        cc_log_decision,
        cc_add_link,
        cc_report,
        cc_feedback,
        cc_schedule,
        cc_create_task,
        cc_attach_file,
    }
}

function unavailable(what) {
    return new AppError("unavailable", `${what} not available`, {
        status: 503,
    })
}
