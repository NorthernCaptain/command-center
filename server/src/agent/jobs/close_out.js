/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// close_out: write the Result section, comment + complete the Asana task (if
// any) and move the task to done. Triggered only by Leo (button) or merge
// detection, never by content.
//
// A Result section that is already written (by Leo or the worker agent's
// report) is kept as is; the LLM only fills an empty one. The Asana comment
// is the conclusion for teammates: an outcome, the key points (root cause,
// what changed, PRs with links) and what is still open, posted as rich text.
//
// Preconditions (checked in prepare and again in apply, before any side
// effect): the status can move to done, and every deliverable is merged or
// marked no_change, and a SOC2-area task has a complete "Change record
// (SOC2)" section (phase3/soc2.js). Otherwise the job fails with a clear
// error.
//
// Asana side effects are idempotent across retries and new jobs: the comment
// is recorded as an "asana_close_commented" event and never re-posted when
// that event exists; completion checks getTask(gid).completed first and is
// recorded as "asana_completed".

import { z } from "zod"
import { canTransition, openDeliverables } from "../../contracts/lifecycle.js"
import { AppError } from "../../util/errors.js"
import {
    assertChangeRecord,
    assertTaskChangeRecord,
} from "../../phase3/soc2.js"
import { applySectionEdits } from "../artifactEdits.js"
import { buildConclusion } from "../../integrations/asana/asanaNotes.js"
import { artifactBlock, systemPrompt, taskLine } from "../prompts.js"
import { sectionBody } from "../sections.js"
import { asanaOf } from "./util.js"

const outputSchema = z.object({
    result_md: z.string(),
    asana_conclusion: z.object({
        outcome: z.string(),
        points: z.array(z.string()),
        open_items: z.array(z.string()),
    }),
})

/** Is the Result section written (not missing, empty or the placeholder)? */
export function hasResult(content) {
    const body = sectionBody(content, "Result")
    return Boolean(body && body.replace(/<!--[\s\S]*?-->/g, "").trim())
}

export const EV_COMMENTED = "asana_close_commented"
export const EV_COMPLETED = "asana_completed"

// Deliverables that block close-out; the store enforces the same rule.
export { openDeliverables }

/** Throw when the task cannot be closed out now. */
export function assertClosable(task) {
    if (!canTransition(task.status, "done")) {
        throw new AppError(
            "invalid_state",
            `T-${task.id} is ${task.status} and cannot move to done`,
            { status: 409 }
        )
    }
    const open = openDeliverables(task)
    if (open.length) {
        throw new AppError(
            "deliverables_open",
            `T-${task.id} has deliverables that are not merged or no_change: ${open
                .map(
                    (d) =>
                        `${d.repo}@${d.branch}${d.pr ? ` (${d.pr} is not merged)` : ""}`
                )
                .join(", ")}`,
            { status: 409 }
        )
    }
}

/**
 * Re-check the task's unmerged PRs on GitHub before judging close-out: a PR
 * merged since the last poll must not block it. Runs the PR watcher's poll
 * for the task (deps.prWatcher.pollTask), which records merges and settles
 * the status. Returns true when it polled. A failed poll is logged and the
 * check goes on with what is recorded.
 */
export async function refreshPrs(ctx, task) {
    const watcher = ctx.deps && ctx.deps.prWatcher
    if (!watcher || typeof watcher.pollTask !== "function") return false
    const unmerged = openDeliverables(task).some(
        (d) => d.disposition === "pr" && d.pr
    )
    if (!unmerged) return false
    try {
        const res = await watcher.pollTask(task.id)
        if (res && (res.error || (res.errors && res.errors.length)))
            ctx.log.warn(
                { task_id: task.id, err: res.error || res.errors.join("; ") },
                "close_out: PR re-check incomplete"
            )
    } catch (err) {
        ctx.log.warn(
            { task_id: task.id, err: err.message },
            "close_out: PR re-check failed"
        )
    }
    return true
}

const PENDING_JOB = ["queued", "running", "parked"]

/**
 * Start a close-out for the task unless one is already pending (double
 * clicks, the UI and a command racing). Every "mark done" path for an
 * Asana-linked task goes through here.
 * @returns {{ job: object, existing: boolean }}
 */
export function enqueueCloseOut(runner, taskId) {
    if (!runner || typeof runner.enqueue !== "function")
        throw new AppError(
            "unavailable",
            "cannot close out: job runner unavailable",
            { status: 503 }
        )
    const pending =
        typeof runner.list === "function"
            ? (
                  runner.list({ task_id: taskId, status: PENDING_JOB }) || []
              ).find((j) => j.type === "close_out")
            : null
    if (pending) return { job: pending, existing: true }
    return {
        job: runner.enqueue("close_out", {}, { task_id: taskId }),
        existing: false,
    }
}

async function hasEvent(ctx, type, gid) {
    if (typeof ctx.store.listEvents !== "function") return false
    const events = await ctx.store.listEvents(ctx.task_id, { limit: 500 })
    return (events || []).some(
        (e) => e.type === type && (!e.data || !e.data.gid || e.data.gid === gid)
    )
}

async function closeAsana(ctx, svc, gid, conclusion, context) {
    if (conclusion.text && !context.asanaCommented) {
        if (!(await hasEvent(ctx, EV_COMMENTED, gid))) {
            // rich text when the service has it, else the plain version
            if (typeof svc.commentHtml === "function")
                await svc.commentHtml(gid, conclusion.html)
            else await svc.comment(gid, conclusion.text)
            await ctx.store.appendEvent(
                ctx.task_id,
                { type: EV_COMMENTED, data: { gid } },
                ctx.actor
            )
        }
        context.asanaCommented = true
    }
    if (!context.asanaCompleted) {
        let completed = false
        if (typeof svc.getTask === "function") {
            completed = Boolean((await svc.getTask(gid)).completed)
        }
        if (!completed) {
            await svc.complete(gid)
            await ctx.store.appendEvent(
                ctx.task_id,
                { type: EV_COMPLETED, data: { gid } },
                ctx.actor
            )
        }
        context.asanaCompleted = true
    }
}

export default {
    type: "close_out",
    lane: "background",
    weight: "light",
    lock: true,
    outputSchema,

    async prepare(ctx) {
        let { task } = await ctx.store.getTask(ctx.task_id)
        if (await refreshPrs(ctx, task))
            task = (await ctx.store.getTask(ctx.task_id)).task
        assertClosable(task)
        const artifact = await ctx.store.getArtifact(ctx.task_id)
        assertChangeRecord(task, artifact)
        return {
            context: {
                task,
                artifact,
                keepResult: hasResult(artifact.content),
            },
        }
    },

    buildPrompt(ctx, context) {
        return {
            system: systemPrompt("close_out"),
            prompt: [
                taskLine(context.task),
                `Title: ${JSON.stringify(context.task.title)}`,
                context.keepResult
                    ? 'The Result section is already written: keep it (result_md: "") and base asana_conclusion on it.'
                    : "The Result section is empty: write result_md.",
                artifactBlock(context.artifact.content),
            ].join("\n\n"),
        }
    },

    async apply(ctx, output, context) {
        // Re-check: the task may have changed while the LLM was running.
        const current = (await ctx.store.getTask(ctx.task_id)).task
        assertClosable(current)
        await assertTaskChangeRecord(ctx.store, current)

        const notes = []
        const resultMd = output.result_md.trim()
        if (context.keepResult) {
            notes.push("kept the written Result")
        } else {
            if (!resultMd)
                throw new AppError(
                    "invalid_output",
                    "close-out wrote no Result section"
                )
            const res = await applySectionEdits(ctx, context, [
                { section: "Result", op: "replace", content: resultMd },
            ])
            if (res.conflicts.length)
                notes.push("Result section changed meanwhile, kept yours")
        }

        const { task } = await ctx.store.getTask(ctx.task_id)
        const gid = task.asana && task.asana.gid
        const svc = asanaOf(ctx.deps)
        if (gid && svc) {
            await closeAsana(
                ctx,
                svc,
                gid,
                buildConclusion(output.asana_conclusion),
                context
            )
            notes.push("Asana completed")
        } else if (gid) {
            notes.push("Asana not configured; task not completed there")
        }

        if (task.status !== "done") {
            await ctx.store.updateTask(
                ctx.task_id,
                { status: "done" },
                { actor: ctx.actor, reason: "close_out" }
            )
        }
        return {
            summary: `Closed out${notes.length ? ` (${notes.join("; ")})` : ""}`,
        }
    },
}
