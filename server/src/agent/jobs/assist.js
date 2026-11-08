/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// assist: answer / change / chat on a task artifact from a comment.
// Edits apply via store.updateArtifactSection with the base revision the LLM
// saw; the reply is posted as a "note" reply by "center" on the comment's
// thread; the thread is resolved when a change applied cleanly or an answer
// was given, otherwise left open.
// Only "ask" gets MCP (tracebot-mcp), and only the exact tools in
// ASSIST_ASK_TOOLS: the prompt carries untrusted artifact/thread content, so
// no write tool (Slack posting, deploys, SQL, QA writes) may be reachable.
// brain_do acts as Leo; the providers guard it (read-only prompt prefix on
// claude-sdk, denied on claude-cli; see providers/toolPolicy.js).

import { z } from "zod"
import { applySectionEdits } from "../artifactEdits.js"
import { artifactBlock, systemPrompt, taskLine, untrusted } from "../prompts.js"
import { ASSIST_ASK_TOOLS, mcpToolNames } from "../providers/toolPolicy.js"
import { errMessage } from "./util.js"

const INTENTS = ["ask", "change", "chat"]

const outputSchema = z.object({
    reply: z.string(),
    edits: z.array(
        z.object({
            section: z.string(),
            op: z.enum(["replace", "append"]),
            content: z.string(),
        })
    ),
})

/** Find the thread containing commentId (as root or reply). */
export function findThread(threads, commentId) {
    if (!commentId) return null
    for (const t of threads || []) {
        if (t.id === commentId) return t
        if ((t.replies || []).some((r) => r.id === commentId)) return t
    }
    return null
}

function threadText(thread) {
    if (!thread) return ""
    return [thread, ...(thread.replies || [])]
        .map(
            (c) =>
                `[${c.author}${c.intent && c.intent !== "note" ? ` / ${c.intent}` : ""}] ${c.body}`
        )
        .join("\n")
}

function intentOf(input) {
    return INTENTS.includes(input.intent) ? input.intent : "chat"
}

async function setStatus(ctx, commentId, status, resolution) {
    if (!commentId) return
    await ctx.store.setCommentStatus(
        ctx.task_id,
        commentId,
        { status, resolution: resolution ?? null },
        ctx.actor
    )
}

export default {
    type: "assist",
    lane: "interactive",
    weight: "light",
    lock: true,
    outputSchema,

    async prepare(ctx) {
        const { task } = await ctx.store.getTask(ctx.task_id)
        const artifact = await ctx.store.getArtifact(ctx.task_id)
        const threads = ctx.input.comment_id
            ? await ctx.store.listComments(ctx.task_id)
            : []
        const thread = findThread(threads, ctx.input.comment_id)
        const rootId = thread ? thread.id : ctx.input.comment_id || null
        if (rootId) {
            try {
                await setStatus(ctx, rootId, "working", null)
            } catch (err) {
                ctx.log.warn({ err }, "assist: could not mark comment working")
            }
        }
        return {
            context: {
                task,
                artifact,
                thread,
                rootId,
                anchor: ctx.input.anchor || (thread && thread.anchor) || null,
            },
        }
    },

    buildPrompt(ctx, context) {
        const intent = intentOf(ctx.input)
        const parts = [
            taskLine(context.task),
            artifactBlock(context.artifact.content),
        ]
        if (context.anchor && context.anchor.exact) {
            parts.push(
                `Anchor${context.anchor.section ? ` in section "${context.anchor.section}"` : ""}:\n${untrusted(
                    "ANCHOR QUOTE",
                    context.anchor.exact
                )}`
            )
        }
        if (context.thread) {
            parts.push(
                `Comment thread so far:\n${untrusted("THREAD", threadText(context.thread))}`
            )
        }
        parts.push(
            `Intent: ${intent}\nLeo's message:\n${ctx.input.message || ""}`
        )
        const out = {
            system: systemPrompt("assist"),
            prompt: parts.join("\n\n"),
        }
        if (
            intent === "ask" &&
            ctx.deps.mcpServers &&
            Object.keys(ctx.deps.mcpServers).length
        ) {
            out.mcpServers = ctx.deps.mcpServers
            out.allowedTools = mcpToolNames(
                ctx.deps.mcpServers,
                ASSIST_ASK_TOOLS
            )
        }
        return out
    },

    async apply(ctx, output, context) {
        const intent = intentOf(ctx.input)
        const edits = intent === "ask" ? [] : output.edits
        const res = edits.length
            ? await applySectionEdits(ctx, context, edits)
            : { applied: [], conflicts: [], skipped: [] }

        let reply = output.reply.trim()
        const notes = []
        if (res.conflicts.length)
            notes.push(
                `Not applied (section changed meanwhile): ${res.conflicts.join(", ")}.`
            )
        if (res.skipped.length)
            notes.push(`Skipped invalid edit(s): ${res.skipped.join(", ")}.`)
        if (notes.length) reply = [reply, ...notes].filter(Boolean).join("\n\n")
        if (!reply)
            reply = res.applied.length
                ? `Updated ${res.applied.join(", ")}.`
                : "No change."

        if (!context.posted) {
            await ctx.store.appendComment(
                ctx.task_id,
                {
                    op: "create",
                    parent_id: context.rootId,
                    anchor: null,
                    body: reply.slice(0, 20000),
                    intent: "note",
                    author: "center",
                    job_id: ctx.job.id,
                },
                ctx.actor
            )
            context.posted = true
        }

        const cleanChange =
            res.applied.length > 0 &&
            !res.conflicts.length &&
            !res.skipped.length
        const answered = Boolean(output.reply.trim())
        const resolved = intent === "change" ? cleanChange : answered
        await setStatus(
            ctx,
            context.rootId,
            resolved ? "resolved" : "open",
            resolved
                ? res.applied.length
                    ? `center updated ${res.applied.join(", ")}`
                    : "center answered"
                : "center could not apply the change"
        )
        return {
            summary: res.applied.length
                ? `Updated ${res.applied.join(", ")}`
                : intent === "change"
                  ? "No edits applied"
                  : "Replied",
        }
    },

    async onFailure(ctx, err, { cancelled } = {}) {
        if (!ctx.input.comment_id) return
        const threads = await ctx.store.listComments(ctx.task_id)
        const thread = findThread(threads, ctx.input.comment_id)
        await setStatus(
            ctx,
            thread ? thread.id : ctx.input.comment_id,
            "open",
            cancelled
                ? "center cancelled"
                : `center failed: ${errMessage(err)}`.slice(0, 500)
        )
    },
}
