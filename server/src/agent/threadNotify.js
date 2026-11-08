/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// When a task captured from a Slack thread gets its Asana task, reply in the
// thread with the Asana link, through Brain (TraceBot posts it).
//
// - Once per Asana task: an "slack_asana_link" event { gid, thread,
//   brain_job } is recorded when the Brain job starts, and a later call for
//   the same gid does nothing. The Brain idempotency key
//   (cc-T<id>-slack-asana-<gid>) covers a crash between start and event.
// - Brain runs the post on its own; a failure to start it is recorded as
//   "slack_asana_link_failed" and logged, never thrown (Asana creation is
//   not undone or failed because of Slack).

import { errMessage } from "./jobs/util.js"
import { nullLogger } from "../util/logger.js"

export const EV_LINK = "slack_asana_link"
export const EV_LINK_FAILED = "slack_asana_link_failed"
const ACTOR = "center"

/** The Brain instruction: one reply in the thread, nothing else. */
export function slackReplyPrompt({ threadUrl, asanaUrl }) {
    return [
        `Reply in the Slack thread at ${threadUrl} with exactly this text:`,
        `"Tracking this in Asana: ${asanaUrl}"`,
        "Post it once, as a reply in that thread (not in the channel). Do",
        "nothing else: no other messages, reactions or mentions.",
    ].join(" ")
}

export function brainKey(taskId, gid) {
    return `cc-T${taskId}-slack-asana-${gid}`
}

/**
 * @param {object} deps { store, brain: { start }, log }
 * @returns {{ asanaCreated(taskId) -> Promise<object> }}
 */
export function createThreadNotifier({ store, brain, log = nullLogger }) {
    async function asanaCreated(taskId) {
        if (!brain || typeof brain.start !== "function")
            return { skipped: "no_brain" }
        const { task } = await store.getTask(taskId)
        const src = task.source || {}
        if (src.type !== "slack" || !src.url) return { skipped: "no_slack" }
        const gid = task.asana && task.asana.gid
        const asanaUrl = task.asana && task.asana.url
        if (!gid || !asanaUrl) return { skipped: "no_asana" }
        const events = (await store.listEvents(taskId, { limit: 1000 })) || []
        if (
            events.some(
                (e) => e.type === EV_LINK && e.data && e.data.gid === gid
            )
        )
            return { skipped: "already_posted" }
        try {
            const job = await brain.start({
                prompt: slackReplyPrompt({ threadUrl: src.url, asanaUrl }),
                title: `cc T-${taskId} Asana link to Slack`,
                idempotencyKey: brainKey(taskId, gid),
            })
            await store.appendEvent(
                taskId,
                {
                    type: EV_LINK,
                    data: { gid, thread: src.url, brain_job: job },
                },
                ACTOR
            )
            return { posted: true, brain_job: job }
        } catch (err) {
            const error = errMessage(err).slice(0, 300)
            log.warn(
                { task_id: taskId, err: error },
                "slack thread: Asana link not posted"
            )
            try {
                await store.appendEvent(
                    taskId,
                    { type: EV_LINK_FAILED, data: { gid, error } },
                    ACTOR
                )
            } catch {
                // the warning above is enough
            }
            return { posted: false, error }
        }
    }

    return { asanaCreated }
}
