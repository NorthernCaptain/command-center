/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Plain constants duplicated from server/src/contracts/{schemas,lifecycle}.js.
// The server files import zod, so the web bundle keeps its own copy. Keep the
// two in sync when the contracts change.

export const STATUSES = [
    "inbox",
    "ready",
    "waiting",
    "active",
    "ready_for_pr",
    "pr_open",
    "pr_feedback",
    "review",
    "done",
    "cancelled",
]
export const KINDS = ["reminder", "todo", "agent_task"]
export const AREAS = [
    "backend",
    "mobile",
    "web",
    "batch",
    "infra",
    "access",
    "security",
    "soc2",
    "other",
]
export const LANES = [
    "now",
    "active",
    "prs",
    "ready",
    "inbox",
    "waiting",
    "done",
]
export const PROVIDERS = ["claude-sdk", "claude-cli", "codex"]
export const WORKER_KINDS = ["claude", "codex"]
export const ACTIVE_JOB_STATUSES = ["queued", "running", "parked"]

/**
 * Runtime settings used when a key is absent from GET /api/settings. Must
 * match the server's shared defaults.
 */
export const SETTINGS_DEFAULTS = {
    "center.provider": "claude-sdk",
    "center.fallback_provider": "codex",
    "center.auto_fallback": false,
    "center.models": {},
    "workers.default_kind": "claude",
    "workers.auto_clean_on_done": true,
    "github.poll_minutes": 15,
    "digest.enabled": true,
    "digest.time": "08:30",
    "stale.days": 7,
    "push.enabled": false,
}

export const LANE_LABELS = {
    now: "Now",
    all: "All",
    herdr: "herdr",
    active: "Active",
    prs: "PRs",
    ready: "Ready",
    inbox: "Inbox",
    waiting: "Waiting",
    done: "Done",
}

// The board lane a status belongs to (without the Now overlay); the server
// uses the same mapping (contracts/lifecycle.js laneOf).
const STATUS_LANES = {
    inbox: "inbox",
    ready: "ready",
    waiting: "waiting",
    active: "active",
    ready_for_pr: "prs",
    pr_open: "prs",
    pr_feedback: "prs",
    review: "prs",
}

/** "inbox" | "ready" | "active" | "prs" | "waiting" | "done" */
export function statusLane(status) {
    return STATUS_LANES[status] || "done"
}

export const STATUS_LABELS = {
    inbox: "inbox",
    ready: "ready",
    waiting: "waiting",
    active: "active",
    ready_for_pr: "ready for PR",
    pr_open: "PR open",
    pr_feedback: "PR feedback",
    review: "review",
    done: "done",
    cancelled: "cancelled",
}

export const KIND_LABELS = {
    reminder: "Reminder",
    todo: "To-do",
    agent_task: "Agent task",
}

export const JOB_LABELS = {
    parse_quick: "Parsing",
    enrich: "Enriching",
    assist: "Center agent",
    command: "Command",
    asana_create: "Creating Asana task",
    close_out: "Closing out",
}

const ANY_OPEN = STATUSES.filter((s) => s !== "done" && s !== "cancelled")

const TRANSITIONS = {
    inbox: ["ready", "active", "waiting", "done", "cancelled"],
    ready: ["inbox", "active", "waiting", "done", "cancelled"],
    waiting: [...ANY_OPEN.filter((s) => s !== "waiting"), "done", "cancelled"],
    active: ["ready", "ready_for_pr", "review", "waiting", "done", "cancelled"],
    ready_for_pr: ["active", "pr_open", "waiting", "done", "cancelled"],
    pr_open: ["pr_feedback", "active", "waiting", "done", "cancelled"],
    pr_feedback: ["pr_open", "active", "waiting", "done", "cancelled"],
    review: ["active", "waiting", "done", "cancelled"],
    done: ["ready", "active"],
    cancelled: ["ready", "inbox"],
}

/** Same rule as lifecycle.canTransition on the server. */
export function canTransition(from, to) {
    if (from === to) return true
    return (TRANSITIONS[from] || []).includes(to)
}

/** Statuses selectable from `from` (including itself), in canonical order. */
export function allowedStatuses(from) {
    return STATUSES.filter((s) => canTransition(from, s))
}

export function isOpenStatus(status) {
    return status !== "done" && status !== "cancelled"
}

/** Human id: 123 -> "T-123". */
export function taskKey(id) {
    return `T-${id}`
}
