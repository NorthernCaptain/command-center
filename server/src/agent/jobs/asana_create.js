/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// asana_create: the LLM writes the description prose; asanaService builds the
// html, picks the sprint section, creates the task and attachments. Apply
// records task.asana, adds an "asana" link, sets wants_asana and logs an event.
// The created task is remembered in the job context so a stale-revision retry
// of apply never creates a second Asana task. For a task captured from a Slack
// thread, deps.threadNotifier then replies there with the Asana link.
//
// Across retries/restarts/new jobs: before any POST an "asana_create_intent"
// event { nonce, at } is appended to the task (durable, store-owned), and the
// marker "Command-Center-Task: T-<id> <nonce>" goes into the Asana notes.
// When earlier intents exist, asanaService.createForTask first looks for an
// Asana task carrying one of their markers and adopts it instead of creating
// a second one. (The task schema has no asana.pending field, so the intent
// lives in events.jsonl rather than task.json.)

import crypto from "node:crypto"
import { z } from "zod"
import { creationMarker } from "../../integrations/asana/asanaService.js"
import { AppError } from "../../util/errors.js"
import { artifactBlock, systemPrompt, taskLine } from "../prompts.js"
import { asanaOf, newLinkId } from "./util.js"

const outputSchema = z.object({
    summary: z.string().min(1),
    context: z.string(),
    acceptance: z.array(z.string()),
    approach: z.string(),
})

export const EV_INTENT = "asana_create_intent"
const LOOKBACK_MS = 10 * 60 * 1000

/** Earlier creation intents recorded on the task (oldest first). */
export async function listIntents(ctx) {
    if (typeof ctx.store.listEvents !== "function") return []
    const events = await ctx.store.listEvents(ctx.task_id, { limit: 1000 })
    return (events || [])
        .filter(
            (e) =>
                e.type === EV_INTENT &&
                e.data &&
                typeof e.data.nonce === "string"
        )
        .map((e) => ({ nonce: e.data.nonce, at: e.data.at || e.at }))
        .reverse()
}

/** Create (or adopt) the Asana task; records the intent before any POST. */
async function createOrAdopt(ctx, task, output) {
    const prior = await listIntents(ctx)
    const nowIso = ctx.clock.now().toISOString()
    const nonce = crypto.randomBytes(6).toString("hex")
    await ctx.store.appendEvent(
        ctx.task_id,
        { type: EV_INTENT, data: { nonce, at: nowIso } },
        ctx.actor
    )
    const earliest = [nowIso, ...prior.map((p) => p.at)]
        .map((t) => Date.parse(t))
        .filter((t) => !Number.isNaN(t))
        .reduce((a, b) => Math.min(a, b))
    return asanaOf(ctx.deps).createForTask(task, output, {
        marker: creationMarker(task.id, nonce),
        priorMarkers: prior.map((p) => creationMarker(task.id, p.nonce)),
        since: new Date(earliest - LOOKBACK_MS).toISOString(),
    })
}

function ensureNoAsana(task) {
    if (task.asana && task.asana.gid) {
        throw new AppError(
            "already_exists",
            `T-${task.id} already has an Asana task: ${task.asana.url || task.asana.gid}`,
            { status: 409 }
        )
    }
}

export default {
    type: "asana_create",
    lane: "background",
    weight: "heavy",
    lock: true,
    outputSchema,

    async prepare(ctx) {
        const svc = asanaOf(ctx.deps)
        if (!svc || typeof svc.createForTask !== "function")
            throw new AppError("asana_unavailable", "Asana is not configured", {
                status: 503,
            })
        const { task } = await ctx.store.getTask(ctx.task_id)
        ensureNoAsana(task)
        const artifact = await ctx.store.getArtifact(ctx.task_id)
        return { context: { task, artifact } }
    },

    buildPrompt(ctx, context) {
        return {
            system: systemPrompt("asana_create"),
            prompt: [
                taskLine(context.task),
                `Title: ${JSON.stringify(context.task.title)}`,
                artifactBlock(context.artifact.content),
            ].join("\n\n"),
        }
    },

    async apply(ctx, output, context) {
        const { task } = await ctx.store.getTask(ctx.task_id)
        if (!context.created) {
            ensureNoAsana(task)
            context.created = await createOrAdopt(ctx, task, output)
        }
        const c = context.created
        const links = [...(task.links || [])]
        if (c.url && !links.some((l) => l.url === c.url)) {
            links.push({
                id: newLinkId(),
                type: "asana",
                url: c.url,
                label: "Asana",
                role: null,
                added_by: ctx.actor,
                at: ctx.clock.now().toISOString(),
            })
        }
        await ctx.store.updateTask(
            ctx.task_id,
            {
                asana: {
                    gid: c.gid,
                    url: c.url ?? null,
                    section_gid: c.section_gid ?? null,
                    no_section: Boolean(c.no_section),
                    attachments: c.attachments || [],
                    synced_gid: c.gid,
                },
                links,
                wants_asana: true,
            },
            { actor: ctx.actor, reason: "asana_create" }
        )
        if (!context.evented) {
            await ctx.store.appendEvent(
                ctx.task_id,
                {
                    type: "asana_created",
                    data: {
                        gid: c.gid,
                        url: c.url ?? null,
                        no_section: Boolean(c.no_section),
                        adopted: Boolean(c.adopted),
                    },
                },
                ctx.actor
            )
            context.evented = true
        }
        // Slack-captured task: reply in the thread with the Asana link.
        // Detached (outside the task lock, not awaited): the notifier writes
        // its own event once this apply has released the lock.
        const notifier = ctx.deps.threadNotifier
        if (notifier && !context.notified) {
            context.notified = true
            const run = () =>
                notifier
                    .asanaCreated(ctx.task_id)
                    .catch((err) =>
                        ctx.log?.warn?.(
                            { task_id: ctx.task_id, err: err?.message },
                            "slack thread notify failed"
                        )
                    )
            if (typeof ctx.store.outsideLocks === "function")
                ctx.store.outsideLocks(run)
            else run()
        }
        return {
            summary: `Asana task ${c.adopted ? "adopted (created by an earlier attempt)" : "created"}${c.no_section ? " (no sprint section this week)" : ""}: ${c.url || c.gid}`,
        }
    },
}
