/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Task status transitions and derived views (lanes, visibility).
// See docs/03-architecture.md#task-lifecycle.

import { STATUSES } from "./schemas.js"

const ANY_OPEN = STATUSES.filter((s) => s !== "done" && s !== "cancelled")

/** Allowed manual/system transitions. "waiting" and "cancelled" are reachable
 *  from any open status; done/cancelled can be reopened to "ready". */
const TRANSITIONS = {
    inbox: ["ready", "active", "waiting", "done", "cancelled"],
    ready: ["inbox", "active", "waiting", "done", "cancelled"],
    waiting: [...ANY_OPEN.filter((s) => s !== "waiting"), "done", "cancelled"],
    active: ["ready", "ready_for_pr", "review", "waiting", "done", "cancelled"],
    ready_for_pr: ["active", "pr_open", "waiting", "done", "cancelled"],
    // review: the agent reports a result again after more work on a task
    // with an open PR (still watched in review)
    pr_open: [
        "pr_feedback",
        "active",
        "review",
        "waiting",
        "done",
        "cancelled",
    ],
    pr_feedback: [
        "pr_open",
        "active",
        "review",
        "waiting",
        "done",
        "cancelled",
    ],
    review: [
        "active",
        "pr_open",
        "pr_feedback",
        "waiting",
        "done",
        "cancelled",
    ],
    done: ["ready", "active"],
    cancelled: ["ready", "inbox"],
}

export function canTransition(from, to) {
    if (from === to) return true
    return (TRANSITIONS[from] || []).includes(to)
}

export class TransitionError extends Error {
    constructor(from, to) {
        super(`illegal status transition ${from} -> ${to}`)
        this.code = "illegal_transition"
        this.from = from
        this.to = to
    }
}

export function assertTransition(from, to) {
    if (!canTransition(from, to)) throw new TransitionError(from, to)
}

export const LANES = [
    "now",
    "active",
    "prs",
    "ready",
    "inbox",
    "waiting",
    "done",
]

/**
 * Lane for the home board. "now" wins whenever flags.now is set on an open
 * task. Done/cancelled tasks are in "done" (the API limits it to recent ones).
 */
export function laneOf(task) {
    const open = task.status !== "done" && task.status !== "cancelled"
    if (open && task.flags && task.flags.now) return "now"
    switch (task.status) {
        case "active":
            return "active"
        case "ready_for_pr":
        case "pr_open":
        case "pr_feedback":
        case "review":
            return "prs"
        case "ready":
            return "ready"
        case "inbox":
            return "inbox"
        case "waiting":
            return "waiting"
        default:
            return "done"
    }
}

/** A task is visible to tailnet viewers when shared. "auto" = has Asana. */
export function isShared(task) {
    if (task.visibility === "shared") return true
    if (task.visibility === "private") return false
    return Boolean(task.asana && task.asana.gid)
}

/** Whitelisted fields a viewer may see. Never includes comments, history,
 *  jobs, source text, flags.error or agent details. */
export function viewerTask(task) {
    return {
        id: task.id,
        title: task.title,
        kind: task.kind,
        area: task.area,
        status: task.status,
        repos: task.repos,
        branch: task.branch,
        asana: { url: task.asana ? task.asana.url : null },
        links: (task.links || [])
            .filter((l) => ["pr", "branch", "asana", "doc"].includes(l.type))
            .map((l) => ({ type: l.type, url: l.url, label: l.label })),
        created_at: task.created_at,
        updated_at: task.updated_at,
        done_at: task.done_at,
    }
}

/**
 * Add the Now-flag reset every snooze needs: a surfaced task (flags.now)
 * would otherwise stay in the Now lane through the whole snooze, since
 * laneOf checks the flag first. Returns a new patch.
 */
export function withSnoozeFlags(patch) {
    return {
        ...patch,
        flags: { ...(patch.flags || {}), now: false, now_reason: null },
    }
}

/** Patch for snoozing a task until `until` (ISO). */
export function snoozePatch(until) {
    return withSnoozeFlags({ status: "waiting", snooze_until: until })
}

/** Deliverables that block "done" (not merged and not marked no_change). */
export function openDeliverables(task) {
    return ((task && task.deliverables) || []).filter(
        (d) => !d.merged_at && d.disposition !== "no_change"
    )
}

/**
 * Create PR is offered while a PR still has to be opened: status
 * ready_for_pr, or a PR state (pr_open / pr_feedback) with a deliverable that
 * has no PR yet (a multi-repo task whose first PR already moved it on).
 * Mirrored in web/src/lib/worker.js canCreatePr.
 */
export function canCreatePr(task) {
    if (!task) return false
    if (task.status === "ready_for_pr") return true
    if (task.status !== "pr_open" && task.status !== "pr_feedback") return false
    return (task.deliverables || []).some((d) => d.disposition === "pending")
}
