/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// assist: answer / change / chat on a task artifact from a comment.
// Edits apply via store.updateArtifactSection with the base revision the LLM
// saw; the reply is posted as a "note" reply by "center" on the comment's
// thread; the thread is resolved when a change applied cleanly or an answer
// was given, otherwise left open.
// Every chat bar message is its own thread, so a "chat" prompt also carries
// the last few chat exchanges on the task (chatHistory): Leo's "add my
// note" or "update the artifact" refers to what was said before.
// Only "ask" gets MCP (tracebot-mcp), and only the exact tools in
// ASSIST_ASK_TOOLS: the prompt carries untrusted artifact/thread content, so
// no write tool (Slack posting, deploys, SQL, QA writes) may be reachable.
// brain_do acts as Leo; the providers guard it (read-only prompt prefix on
// claude-sdk, denied on claude-cli; see providers/toolPolicy.js).
// "chat" / "change" may also rename the task and pass Leo's message on to
// the task's herdr agent. That needs both Leo's own words to open with an
// instruction to the agent ("tell the agent to …", "agent: …") and the
// model to agree, and the agent gets Leo's message verbatim: nothing the
// model wrote, nor the untrusted artifact / thread, reaches a worker that
// runs code. The reply always says what happened.
// "chat" / "change" may add task links (the Links tab, and the artifact's
// Links section rendered from them), but only URLs Leo wrote himself (this
// message or his earlier comments). The sections filled at display time
// (Links, PR feedback) are never edited as text.

import { z } from "zod"
import { applySectionEdits } from "../artifactEdits.js"
import { artifactBlock, systemPrompt, taskLine, untrusted } from "../prompts.js"
import { ASSIST_ASK_TOOLS, mcpToolNames } from "../providers/toolPolicy.js"
import { errMessage, newLinkId } from "./util.js"

const INTENTS = ["ask", "change", "chat"]
// the worker service's "send" limit is 20000 characters, prefix included
const AGENT_PREFIX = "From Leo via the task chat: "
const MAX_AGENT_MESSAGE = 20000 - AGENT_PREFIX.length
const MAX_SUMMARY = 4000
// earlier chat exchanges in a "chat" prompt, and their size
const HISTORY_EXCHANGES = 8
const HISTORY_CHARS = 12000
const HISTORY_MESSAGE_CHARS = 3000

const outputSchema = z.object({
    reply: z.string(),
    links: z
        .array(z.object({ url: z.string(), label: z.string() }))
        .default([]),
    edits: z.array(
        z.object({
            section: z.string(),
            op: z.enum(["replace", "append"]),
            content: z.string(),
        })
    ),
    title: z.string().nullable(),
    message_agent: z.boolean(),
})

const AGENT = String.raw`(?:the\s+|our\s+|my\s+|this\s+)?(?:herdr\s+|coding\s+|task(?:'s)?\s+)?(?:agent|worker|herdr|claude|codex)\b`
// "tell the agent to …", "please ask the herdr agent …", "have codex …"
const INSTRUCT_RE = new RegExp(
    String.raw`^\s*(?:please\s+|pls\s+)?(?:tell|ask|have|get|let|instruct|send|message|ping|remind)\s+${AGENT}`,
    "i"
)
// "agent: …", "@agent, …"
const ADDRESS_RE = new RegExp(String.raw`^\s*@?${AGENT}\s*[:,]`, "i")

/**
 * Do Leo's own words open with an instruction to the task's agent? A
 * question about it ("what did the agent find?") or "don't tell the agent"
 * does not count.
 */
export function asksAgent(text) {
    const s = String(text || "")
    return INSTRUCT_RE.test(s) || ADDRESS_RE.test(s)
}

const DELIVERY_LINE = {
    sent: "Sent to the herdr agent.",
    queued: "Queued for the herdr agent (it is busy or being relaunched); it gets it next.",
    blocked:
        "Queued for the herdr agent, but it is waiting for your answer in herdr first.",
}

/** Pass Leo's message to the task's herdr agent -> one line on the outcome. */
async function messageAgent(ctx) {
    const msg = String(ctx.input.message || "").trim()
    if (!asksAgent(msg))
        return 'Not sent to the agent: start your message with "tell the agent …" (or "agent: …") to pass it on.'
    if (msg.length > MAX_AGENT_MESSAGE)
        return `Not sent to the agent: the message is too long to pass on (${msg.length} characters, at most ${MAX_AGENT_MESSAGE}).`
    const workers = ctx.deps.workers
    if (!workers) return "Not sent to the agent: herdr workers are off."
    try {
        const state = await workers.agentState(ctx.task_id)
        if (!state)
            return `Not sent to the agent: T-${ctx.task_id} has no agent yet (press Start).`
        const res = await workers.send(ctx.task_id, AGENT_PREFIX + msg)
        const d = (res && res.delivery) || {}
        return (
            DELIVERY_LINE[d.status] ||
            `Not delivered to the agent (${d.status || "unknown"})${d.error ? `: ${d.error}` : ""}; it is in the agent's queue on the task page to retry.`
        )
    } catch (err) {
        return `Not sent to the agent: ${errMessage(err)}`
    }
}

/** Rename the task -> one line, or null when the title is unchanged. */
async function renameTask(ctx, task, raw) {
    const title = String(raw || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300)
    if (!title || title === task.title) return null
    try {
        await ctx.store.updateTask(
            ctx.task_id,
            { title },
            { actor: ctx.actor, reason: "assist rename" }
        )
        return `Renamed the task to "${title}".`
    } catch (err) {
        return `Title not changed: ${errMessage(err)}`
    }
}

// filled from task data when the page shows the artifact: never edited
const RENDERED_SECTIONS = new Set(["links", "pr feedback"])
const URL_RE = /https?:\/\/[^\s<>()"'`]*[^\s<>()"'`.,;:!?]/g
const MAX_LINKS = 10

/** http(s) URLs in a text. */
export function urlsIn(text) {
    return String(text || "").match(URL_RE) || []
}

/** Link type for a URL (Links tab grouping). */
export function linkType(url) {
    const u = String(url)
    if (/^https?:\/\/[^/]*slack\.com\//i.test(u)) return "slack"
    if (/^https?:\/\/app\.asana\.com\//i.test(u)) return "asana"
    if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(u)) return "pr"
    if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/tree\//i.test(u))
        return "branch"
    if (
        /^https?:\/\/(docs\.google\.com|[^/]*notion\.so|[^/]*confluence)/i.test(
            u
        )
    )
        return "doc"
    return "other"
}

/** URLs Leo wrote: his message and his own comments on the task. */
function leoUrls(message, threads) {
    const own = (threads || [])
        .flatMap((t) => [t, ...(t.replies || [])])
        .filter((c) => c.author === "me")
        .map((c) => c.body)
    return new Set([message, ...own].flatMap(urlsIn))
}

/** Add task links -> note lines. Only URLs in `allowed`; dedup by URL. */
async function addLinks(ctx, raw, allowed) {
    const wanted = []
    const refused = []
    for (const l of raw.slice(0, MAX_LINKS)) {
        const url = String(l.url || "").trim()
        if (!url) continue
        if (!allowed.has(url)) refused.push(url)
        else if (!wanted.some((w) => w.url === url))
            wanted.push({ url, label: String(l.label || "").trim() })
    }
    const notes = refused.length
        ? [
              `Not added as a link (only links from your messages): ${refused.join(", ")}`,
          ]
        : []
    if (!wanted.length) return notes
    try {
        const { task } = await ctx.store.getTask(ctx.task_id)
        const links = [...(task.links || [])]
        const added = []
        const at = (ctx.clock ? ctx.clock.now() : new Date()).toISOString()
        for (const w of wanted) {
            const label = w.label.slice(0, 200) || null
            const i = links.findIndex((l) => l.url === w.url)
            if (i !== -1) {
                if (label && label !== links[i].label)
                    links[i] = { ...links[i], label }
                continue
            }
            links.push({
                id: newLinkId(),
                type: linkType(w.url),
                url: w.url,
                label,
                role: null,
                added_by: ctx.actor,
                at,
            })
            added.push(label || w.url)
        }
        await ctx.store.updateTask(
            ctx.task_id,
            { links },
            { actor: ctx.actor, reason: "assist link" }
        )
        if (added.length) notes.push(`Added link: ${added.join(", ")}.`)
    } catch (err) {
        notes.push(`Links not added: ${errMessage(err)}`)
    }
    return notes
}

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

const clip = (text, max) => {
    const s = String(text ?? "")
    return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * The task's chat before the current message, oldest first: the last
 * chat threads Leo started (each with its replies) that come before
 * `rootId`, newest kept when the text runs long. "" when there is none.
 */
export function chatHistory(threads, rootId) {
    const all = threads || []
    const at = all.findIndex((t) => t.id === rootId)
    const before = at === -1 ? all : all.slice(0, at)
    const chats = before
        .filter((t) => t.intent === "chat" && t.author === "me" && !t.parent_id)
        .slice(-HISTORY_EXCHANGES)
    const blocks = chats.map((t) =>
        [t, ...(t.replies || [])]
            .map((c) => `[${c.author}] ${clip(c.body, HISTORY_MESSAGE_CHARS)}`)
            .join("\n")
    )
    let total = 0
    const kept = []
    for (const b of blocks.reverse()) {
        total += b.length + 2
        if (kept.length && total > HISTORY_CHARS) break
        kept.unshift(b)
    }
    return kept.join("\n\n")
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
        const history =
            intentOf(ctx.input) === "chat" ? chatHistory(threads, rootId) : ""
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
                history,
                allowedUrls: leoUrls(ctx.input.message, threads),
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
        if (context.history) {
            parts.push(
                `Earlier messages in this task's chat, oldest first:\n${untrusted("CHAT HISTORY", context.history)}`
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

    // Under the task lock (the runner holds it): section edits and the
    // rename, retried on a stale revision.
    async apply(ctx, output, context) {
        const intent = intentOf(ctx.input)
        const all = intent === "ask" ? [] : output.edits
        const edits = all.filter(
            (e) =>
                !RENDERED_SECTIONS.has(
                    String(e.section || "")
                        .replace(/^#+\s*/, "")
                        .trim()
                        .toLowerCase()
                )
        )
        context.rendered = all.length !== edits.length
        context.res = edits.length
            ? await applySectionEdits(ctx, context, edits)
            : { applied: [], conflicts: [], skipped: [] }
        // once per job (also on a retried apply)
        if (intent !== "ask" && context.linkNotes === undefined)
            context.linkNotes = (output.links || []).length
                ? await addLinks(
                      ctx,
                      output.links,
                      context.allowedUrls || new Set()
                  )
                : []
        // once per job: a retried apply must not rename twice
        if (intent !== "ask" && context.renamed === undefined)
            context.renamed = output.title
                ? await renameTask(ctx, context.task, output.title)
                : null
        return {}
    },

    // After the lock is released: the message to the herdr agent (the
    // worker service takes its own queue and the task lock; holding the
    // lock here could deadlock with a status update), the reply and the
    // thread status.
    async afterApply(ctx, output, context) {
        const intent = intentOf(ctx.input)
        const res = context.res || { applied: [], conflicts: [], skipped: [] }
        let reply = output.reply.trim()
        const notes = []
        if (res.conflicts.length)
            notes.push(
                `Not applied (section changed meanwhile): ${res.conflicts.join(", ")}.`
            )
        if (res.skipped.length)
            notes.push(`Skipped invalid edit(s): ${res.skipped.join(", ")}.`)
        if (context.rendered)
            notes.push(
                "Not edited: the Links and PR feedback sections are filled from the task."
            )
        notes.push(...(context.linkNotes || []))
        if (context.renamed) notes.push(context.renamed)
        if (intent !== "ask" && output.message_agent) {
            if (context.agentLine === undefined)
                context.agentLine = `→ ${await messageAgent(ctx)}`
            notes.push(context.agentLine)
        }
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

        const renamed = String(context.renamed || "").startsWith("Renamed")
        const linked = (context.linkNotes || []).some((n) =>
            n.startsWith("Added link")
        )
        const cleanChange =
            (res.applied.length > 0 || renamed || linked) &&
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
        // the reply itself: the task page shows it above the chat input
        return { summary: reply.slice(0, MAX_SUMMARY) }
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
