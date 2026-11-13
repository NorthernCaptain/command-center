/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Task-page helpers for the phase 2 worker flow (tabs, action toasts).

import { errorMessage } from "./api.js"
import { isChatThread } from "./chat.js"

export const TABS = [
    { id: "links", label: "Links" },
    { id: "files", label: "Files" },
    { id: "deliverables", label: "Deliverables" },
    { id: "comments", label: "Comments" },
    { id: "chat", label: "Chat" },
    { id: "reviews", label: "Reviews" },
    { id: "agent", label: "Agent" },
    { id: "feedback", label: "Feedback" },
    { id: "activity", label: "Activity" },
    { id: "schedules", label: "Follow-ups" },
]

const len = (a) => (Array.isArray(a) ? a.length : 0)

/**
 * Worker tabs only show when the server has the feature (`features` from
 * /api/me) and, except Deliverables, when the task has something for them.
 * Chat shows once the task has a chat with the center agent.
 */
export function visibleTabs(data, features = {}) {
    const task = data.task || {}
    const show = {
        agent:
            Boolean(features.workers) &&
            Boolean(
                data.agent || len(data.outbox) || task.worker_kind || task.slug
            ),
        // always (with GitHub): it says whether anything blocks Done
        deliverables: Boolean(features.github),
        feedback: Boolean(features.github) && len(data.feedback) > 0,
        reviews: Boolean(features.github) && len(data.reviews) > 0,
        chat: (data.comments || []).some(isChatThread),
        // the owner's payload lists attachments; viewers have no Files tab
        files: Array.isArray(data.files),
    }
    return TABS.filter((t) => show[t.id] !== false)
}

const ACTION_DONE = {
    "create-pr": "Asked the agent to open the PR",
    "address-feedback": "Sent the PR feedback to the agent",
    clean: "Asked the agent to clean up its folders",
    "close-agent": "Closed the agent's herdr workspace",
    focus: "Focused the agent in herdr",
    "relaunch-codex": "Relaunching on Codex…",
    send: "Sent to the agent",
    stop: "Stopped tracking the agent",
    retry: "Sent the prompt again",
    cancel: "Dropped the queued prompt",
}

/**
 * Toast for POST actions/:name -> { ok, delivery?: { status, error? } }:
 * { kind: "success" | "info" | "error", text }. Delivery status:
 * sent (or none) -> success; queued / blocked -> info (not sent yet);
 * failed / uncertain -> error with the delivery error.
 */
export function actionToast(name, res) {
    const delivery = (res && res.delivery) || {}
    // Close agent + Clean folders: the close follows the clean-up
    if (
        name === "close-agent" &&
        res &&
        String(res.close_after || "").startsWith("clean:") &&
        ["sent", "confirmed", "queued"].includes(delivery.status)
    )
        return {
            kind: "success",
            text: "The agent is cleaning up its folders; its workspace closes when it is done",
        }
    const detail = delivery.error ? `: ${delivery.error}` : ""
    switch (delivery.status) {
        case "failed":
            return {
                kind: "error",
                text: `Not delivered to the agent${detail}`,
            }
        case "uncertain":
            return {
                kind: "error",
                text: `Delivery to the agent is uncertain (check it in herdr)${detail}`,
            }
        case "blocked":
            return {
                kind: "info",
                text: "Agent is blocked — not sent; check it in herdr",
            }
        case "queued":
            return { kind: "info", text: "Queued until the agent is idle" }
        default:
            return { kind: "success", text: ACTION_DONE[name] || "Done" }
    }
}

/**
 * The PR poll answers 200 with a summary even when GitHub failed
 * ({ error } for the whole task, { errors: [...] } per PR): the text to
 * show as an error, or null when the check went through.
 */
export function pollError(summary) {
    if (!summary) return null
    if (summary.error) return `PR check failed: ${summary.error}`
    const errors = Array.isArray(summary.errors) ? summary.errors : []
    return errors.length ? `PR check failed: ${errors.join("; ")}` : null
}

/** Error text, with the suggested branch on a 409 branch_conflict. */
export function workerError(err) {
    const msg = errorMessage(err)
    const suggestion = err && err.details && err.details.suggestion
    return suggestion ? `${msg} Suggested branch: ${suggestion}` : msg
}

/**
 * Create PR is offered while a PR still has to be opened (same rule as the
 * server's contracts/lifecycle.js canCreatePr): ready_for_pr, or pr_open /
 * pr_feedback with a deliverable that has no PR yet.
 */
export function canCreatePr(task) {
    if (!task) return false
    if (task.status === "ready_for_pr") return true
    if (task.status !== "pr_open" && task.status !== "pr_feedback") return false
    return (task.deliverables || []).some((d) => d.disposition === "pending")
}

const PR_NUM_RE = /\/pull\/(\d+)/

/** The pr_watch row of a deliverable's claimed PR (or null). */
export function watchFor(prs, d) {
    if (!d || !d.pr) return null
    const m = PR_NUM_RE.exec(d.pr)
    const num = m ? Number(m[1]) : null
    return (
        (prs || []).find(
            (w) => w.url === d.pr || (w.repo === d.repo && w.number === num)
        ) || null
    )
}

/**
 * Where a deliverable stands for closing the task (the server's rule: Done
 * needs every deliverable merged or marked no change).
 * -> { done, label, reason? }
 */
export function deliverableState(d, watch = null) {
    if (d.disposition === "no_change") return { done: true, label: "no change" }
    if (d.disposition === "pr" && d.merged_at)
        return { done: true, label: "merged" }
    if (d.disposition === "pr" && watch && watch.closed_at)
        return {
            done: false,
            label: "PR closed",
            reason: "PR closed without merge: reopen it, claim another, or mark No change",
        }
    if (d.disposition === "pr")
        return {
            done: false,
            label: "PR open",
            reason: "PR not merged yet",
        }
    return {
        done: false,
        label: "no PR yet",
        reason: "no PR yet: open or claim one, or mark No change",
    }
}

/**
 * Does looking at the task clear its Now flag (POST seen)? Any Now reason
 * does. Same rule as the server's contracts/lifecycle.js clearsWhenSeen.
 */
export function clearsWhenSeen(flags) {
    return Boolean(flags && flags.now)
}

const RECORD_LABELS = {
    what: "What",
    why: "Why",
    risk: "Risk",
    rollback: "Rollback",
    tested: "Tested",
}

/**
 * Why the SOC2 change record keeps the task from Done, or null.
 * @param {{ section: string, present: boolean, missing: string[] }|null} rec
 *   the task payload's change_record (only on SOC2-area tasks)
 */
export function changeRecordBlocker(rec) {
    if (!rec || !(rec.missing || []).length) return null
    const labels = rec.missing.map((k) => RECORD_LABELS[k] || k).join(", ")
    return rec.present
        ? `fill ${labels} in "${rec.section}"`
        : `add a "${rec.section}" section to the artifact and fill ${labels}`
}

/** Deliverables that keep the task from Done. */
export function blockingDeliverables(task, prs) {
    return ((task && task.deliverables) || []).filter(
        (d) => !deliverableState(d, watchFor(prs, d)).done
    )
}
