/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// command: home command bar. The LLM sees a compact board and returns a reply
// plus whitelisted actions. Each action is validated and applied separately;
// a failing action never blocks the others. Nothing is ever deleted.
// Guardrails (the board titles are untrusted content):
// - terminal transitions (done/cancelled) only for task ids Leo's own
//   command text names explicitly (see mentionedTaskIds);
// - "done" on a task with an Asana gid enqueues close_out instead of setting
//   the status (close_out checks deliverables and completes Asana);
// - at most MAX_ACTIONS actions; the rest are listed as skipped.

import { z } from "zod"
import { AREAS, STATUSES } from "../../contracts/schemas.js"
import { canTransition, snoozePatch } from "../../contracts/lifecycle.js"
import { enqueueCloseOut, openDeliverables } from "./close_out.js"
import { nowLine, systemPrompt, untrusted } from "../prompts.js"
import { assertTaskChangeRecord } from "../../phase3/soc2.js"
import { errMessage, resolveWhen } from "./util.js"

export const ACTION_TYPES = [
    "set_status",
    "snooze",
    "set_area",
    "create_task",
    "add_comment",
]
export const MAX_ACTIONS = 10
const TERMINAL = new Set(["done", "cancelled"])

// Explicit forms: "T-123", "T123", "#123" ("PR#12" / "a/#3" do not count).
const EXPLICIT_ID_RE = /(?:\bT-?|(?<![\w/])#)(\d{1,9})\b/gi
// A bare number counts only right after a closing verb or "task"/"ticket"
// ("done 123", "close 45") and only when nothing but punctuation or a filler
// word follows it, so "finish 2 PRs" / "mark the 3 PR tasks done" /
// "snooze everything 2 days" name no task.
const VERB_ID_RE =
    /\b(?:close[ds]?|done|cancel(?:l?ed|s)?|finish(?:ed|es)?|complete[ds]?|task|ticket)\s+(\d{1,9})(?=\s*(?:$|[,.;:!?)]|(?:and|&|please|pls|now|too|also)\b))/gi
// The whole command is just an id: "123", "#123.", "T-5!".
const ONLY_ID_RE = /^\s*(?:T-?|#)?(\d{1,9})\s*[.!]?\s*$/i

/**
 * Task ids Leo's command text names explicitly: "T-123", "T123", "#123", a
 * bare number when it is the whole command, or a bare number right after
 * close/done/cancel/finish/complete/task/ticket. Any other number ("snooze
 * everything 2 days") is not a task id.
 */
export function mentionedTaskIds(text) {
    const s = String(text || "")
    const ids = new Set()
    const add = (raw) => {
        const n = Number(raw)
        if (n > 0) ids.add(n)
    }
    for (const m of s.matchAll(EXPLICIT_ID_RE)) add(m[1])
    for (const m of s.matchAll(VERB_ID_RE)) add(m[1])
    const only = ONLY_ID_RE.exec(s)
    if (only) add(only[1])
    return ids
}

const outputSchema = z.object({
    reply: z.string(),
    actions: z.array(
        z.object({
            type: z.enum(ACTION_TYPES),
            task_id: z.number().int().nullable(),
            status: z.enum(STATUSES).nullable(),
            area: z.enum(AREAS).nullable(),
            when: z.string().nullable(),
            title: z.string().nullable(),
            text: z.string().nullable(),
        })
    ),
})

const BOARD_LANES = [
    "now",
    "active",
    "prs",
    "ready",
    "inbox",
    "waiting",
    "done",
]

export function compactBoard(board, { doneLimit = 10 } = {}) {
    const lines = []
    for (const lane of BOARD_LANES) {
        const tasks = (board && board[lane]) || []
        const list = lane === "done" ? tasks.slice(0, doneLimit) : tasks
        if (!list.length) continue
        lines.push(`## ${lane}`)
        for (const t of list) {
            const extra = [
                t.due_at && `due ${t.due_at}`,
                t.snooze_until && `snoozed until ${t.snooze_until}`,
            ]
                .filter(Boolean)
                .join(", ")
            lines.push(
                `T-${t.id} [${t.status}] (${t.area}/${t.kind}) ${t.title}${extra ? ` — ${extra}` : ""}`
            )
        }
    }
    return lines.join("\n") || "(empty board)"
}

async function withLock(ctx, id, fn) {
    return typeof ctx.store.withTaskLock === "function"
        ? ctx.store.withTaskLock(id, fn)
        : fn()
}

const HANDLERS = {
    async set_status(ctx, a) {
        if (!a.status) throw new Error("status is required")
        if (
            TERMINAL.has(a.status) &&
            !mentionedTaskIds(ctx.input.text).has(a.task_id)
        )
            throw new Error(
                `not applied: ${a.status} needs T-${a.task_id} named in your command`
            )
        return withLock(ctx, a.task_id, async () => {
            const { task } = await ctx.store.getTask(a.task_id)
            if (task.status === a.status)
                return `T-${a.task_id} already ${a.status}`
            if (!canTransition(task.status, a.status))
                throw new Error(`cannot go from ${task.status} to ${a.status}`)
            if (a.status === "done") {
                const open = openDeliverables(task)
                if (open.length)
                    throw new Error(
                        `deliverables not merged: ${open.map((d) => `${d.repo}@${d.branch}`).join(", ")}`
                    )
                // SOC2 areas: 409 change_record_missing without What / Why /
                // Risk / Rollback / Tested in the artifact.
                await assertTaskChangeRecord(ctx.store, task)
            }
            if (a.status === "done" && task.asana && task.asana.gid) {
                const { job, existing } = enqueueCloseOut(
                    ctx.deps.jobRunner,
                    a.task_id
                )
                const id = job && job.id ? job.id : "queued"
                return existing
                    ? `T-${a.task_id}: close-out already running (${id})`
                    : `T-${a.task_id}: close-out started (${id})`
            }
            await ctx.store.updateTask(
                a.task_id,
                { status: a.status },
                { actor: ctx.actor, reason: "command" }
            )
            return `T-${a.task_id}: ${task.status} → ${a.status}`
        })
    },

    async snooze(ctx, a) {
        const scheduler = ctx.deps.scheduler
        if (!scheduler || typeof scheduler.add !== "function")
            throw new Error("scheduler unavailable")
        const until = resolveWhen(a.when, ctx)
        if (!until)
            throw new Error(
                `cannot understand when "${a.when ?? ""}" (must be in the future)`
            )
        return withLock(ctx, a.task_id, async () => {
            const { task } = await ctx.store.getTask(a.task_id)
            if (
                task.status !== "waiting" &&
                !canTransition(task.status, "waiting")
            )
                throw new Error(`cannot snooze a ${task.status} task`)
            await ctx.store.updateTask(a.task_id, snoozePatch(until), {
                actor: ctx.actor,
                reason: "command snooze",
            })
            await scheduler.add({
                task_id: a.task_id,
                fire_at: until,
                action: "surface",
                payload: { reason: "Snooze ended", snooze: true },
                note: "snooze (command)",
            })
            return `T-${a.task_id}: snoozed until ${until}`
        })
    },

    async set_area(ctx, a) {
        if (!a.area) throw new Error("area is required")
        return withLock(ctx, a.task_id, async () => {
            await ctx.store.getTask(a.task_id)
            await ctx.store.updateTask(
                a.task_id,
                { area: a.area },
                { actor: ctx.actor, reason: "command" }
            )
            return `T-${a.task_id}: area → ${a.area}`
        })
    },

    async create_task(ctx, a) {
        const title = String(a.title || a.text || "")
            .trim()
            .slice(0, 300)
        if (!title) throw new Error("title is required")
        const due = a.when ? resolveWhen(a.when, ctx) : null
        const { task } = await ctx.store.createTask(
            {
                title,
                kind: "todo",
                area: a.area || "other",
                status: "inbox",
                due_at: due,
                source: { type: "manual", url: null, text: a.text || title },
            },
            ctx.actor
        )
        if (
            due &&
            ctx.deps.scheduler &&
            typeof ctx.deps.scheduler.remind === "function"
        ) {
            await ctx.deps.scheduler.remind(task.id, due)
        }
        return `created T-${task.id}: ${title}`
    },

    async add_comment(ctx, a) {
        const body = String(a.text || "").trim()
        if (!body) throw new Error("text is required")
        await ctx.store.getTask(a.task_id)
        await ctx.store.appendComment(
            a.task_id,
            {
                op: "create",
                parent_id: null,
                anchor: null,
                body: body.slice(0, 20000),
                intent: "note",
                author: "center",
                job_id: ctx.job.id,
            },
            ctx.actor
        )
        return `T-${a.task_id}: comment added`
    },
}

const NEEDS_TASK = new Set(["set_status", "snooze", "set_area", "add_comment"])

export default {
    type: "command",
    lane: "interactive",
    weight: "light",
    lock: false,
    needsTask: false,
    outputSchema,

    async prepare(ctx) {
        const board = await ctx.store.board({})
        return { context: { board } }
    },

    buildPrompt(ctx, context) {
        return {
            system: systemPrompt("command"),
            prompt: [
                nowLine(ctx.clock, ctx.deps.timezone),
                `Board:\n${untrusted("BOARD", compactBoard(context.board))}`,
                `Leo's command:\n${ctx.input.text || ""}`,
            ].join("\n\n"),
        }
    },

    async apply(ctx, output, context) {
        const done = (context.done ||= [])
        const results = []
        const actions = output.actions.slice(0, MAX_ACTIONS)
        for (let i = 0; i < actions.length; i++) {
            if (done[i]) {
                results.push(done[i])
                continue
            }
            const a = actions[i]
            let line
            try {
                if (
                    NEEDS_TASK.has(a.type) &&
                    !(Number.isInteger(a.task_id) && a.task_id > 0)
                )
                    throw new Error("task_id is required")
                line = `✓ ${await HANDLERS[a.type](ctx, a)}`
            } catch (err) {
                if (err && err.code === "stale_revision") throw err
                line = `✗ ${a.type}${a.task_id ? ` T-${a.task_id}` : ""}: ${errMessage(err)}`
            }
            done[i] = line
            results.push(line)
        }
        const extra = output.actions.slice(MAX_ACTIONS)
        if (extra.length)
            results.push(
                `✗ skipped ${extra.length} action(s) over the limit of ${MAX_ACTIONS}: ${extra
                    .map(
                        (a) => `${a.type}${a.task_id ? ` T-${a.task_id}` : ""}`
                    )
                    .join(", ")}`
            )
        return {
            summary: [output.reply.trim(), ...results]
                .filter(Boolean)
                .join("\n"),
        }
    },
}
