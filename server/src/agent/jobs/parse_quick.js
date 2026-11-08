/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// parse_quick: LLM fallback when the rule date parser cannot read a capture.
// Fills kind / title / due_at on the existing task and schedules a reminder.

import { z } from "zod"
import { KINDS } from "../../contracts/schemas.js"
import { canTransition } from "../../contracts/lifecycle.js"
import { nowLine, systemPrompt, untrusted } from "../prompts.js"
import { isoOrNull } from "./util.js"

const outputSchema = z.object({
    kind: z.enum(KINDS),
    title: z.string().min(1),
    due_at: z.string().nullable(),
})

export default {
    type: "parse_quick",
    lane: "interactive",
    weight: "light",
    lock: true,
    outputSchema,

    async prepare(ctx) {
        const { task } = await ctx.store.getTask(ctx.task_id)
        return { context: { task } }
    },

    buildPrompt(ctx, context) {
        const text =
            ctx.input.text || context.task.source?.text || context.task.title
        return {
            system: systemPrompt("parse_quick"),
            prompt: [
                nowLine(ctx.clock, ctx.deps.timezone),
                "Parse this capture text:",
                untrusted("CAPTURE", text),
            ].join("\n\n"),
        }
    },

    async apply(ctx, output) {
        const { task } = await ctx.store.getTask(ctx.task_id)
        const due = isoOrNull(output.due_at, { clock: ctx.clock, future: true })
        // Only overwrite fields Leo has not edited since capture (the
        // snapshot holds their capture-time values; a missing key means no
        // guard, for jobs queued before the field was added).
        const snap = (ctx.input && ctx.input.snapshot) || null
        const untouched = (field) =>
            !snap ||
            !Object.prototype.hasOwnProperty.call(snap, field) ||
            task[field] === snap[field]
        const patch = {}
        const title = output.title.trim().slice(0, 300)
        if (untouched("title")) patch.title = title
        if (untouched("kind")) patch.kind = output.kind
        if (due && untouched("due_at")) patch.due_at = due
        if (
            (patch.kind || task.kind) === "reminder" &&
            patch.due_at &&
            untouched("status") &&
            task.status !== "waiting" &&
            canTransition(task.status, "waiting")
        ) {
            patch.status = "waiting"
        }
        await ctx.store.updateTask(ctx.task_id, patch, {
            actor: ctx.actor,
            reason: "parse_quick",
        })
        // Schedule only a due date this job actually applied.
        let reminder = false
        if (
            patch.due_at &&
            ctx.deps.scheduler &&
            typeof ctx.deps.scheduler.remind === "function"
        ) {
            await ctx.deps.scheduler.remind(ctx.task_id, patch.due_at)
            reminder = true
        }
        return {
            summary: `${patch.kind || task.kind}: ${patch.title || task.title}${due ? ` (due ${due}${reminder ? ", reminder set" : patch.due_at ? "" : ", kept yours"})` : ""}`,
        }
    },
}
