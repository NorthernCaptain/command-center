/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Shared data contracts. Every module validates task data through these
// schemas. See docs/implementation/contracts.md for the semantics.

import { z } from "zod"

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
export const SOURCE_TYPES = [
    "slack",
    "asana",
    "github",
    "phone",
    "manual",
    "herdr",
    "other",
]
export const LINK_TYPES = [
    "slack",
    "asana",
    "pr",
    "branch",
    "folder",
    "doc",
    "review",
    "other",
]
export const VISIBILITY = ["auto", "shared", "private"]
export const COMMENT_INTENTS = ["note", "ask", "change", "chat"]
export const COMMENT_STATUSES = ["open", "working", "resolved", "orphaned"]
export const WORKER_KINDS = ["claude", "codex"]

const isoDate = z.string().datetime({ offset: true })

/** Actor strings: "me" | "center" | "system" | "recovery" | "agent:<name>" */
export const ActorSchema = z
    .string()
    .regex(/^(me|center|system|recovery|agent:[a-z0-9][a-z0-9_-]{0,63})$/)

export const LinkSchema = z.object({
    id: z.string().min(1),
    type: z.enum(LINK_TYPES),
    url: z.string().min(1),
    label: z.string().nullable().default(null),
    role: z.enum(["main", "ref", "work"]).nullable().default(null),
    added_by: ActorSchema,
    at: isoDate,
})

export const RepoRefSchema = z.object({
    name: z.string().min(1),
    role: z.enum(["main", "ref", "work"]),
})

export const DeliverableSchema = z.object({
    repo: z.string().min(1),
    branch: z.string().min(1),
    role: z.literal("work"),
    created_at: isoDate,
    disposition: z.enum(["pending", "pr", "no_change"]),
    pr: z.string().nullable().default(null),
    claimed_at: isoDate.nullable().default(null),
    merged_at: isoDate.nullable().default(null),
})

export const AnchorSchema = z.object({
    section: z.string().nullable().default(null),
    exact: z.string().min(1),
    prefix: z.string().default(""),
    suffix: z.string().default(""),
})

export const TaskSchema = z.object({
    id: z.number().int().positive(),
    title: z.string().min(1).max(300),
    kind: z.enum(KINDS),
    area: z.enum(AREAS),
    status: z.enum(STATUSES),
    prev_status: z.enum(STATUSES).nullable().default(null),
    priority: z.number().int().min(0).max(3).default(2),
    visibility: z.enum(VISIBILITY).default("auto"),
    source: z.object({
        type: z.enum(SOURCE_TYPES),
        url: z.string().nullable().default(null),
        text: z.string().nullable().default(null),
    }),
    due_at: isoDate.nullable().default(null),
    snooze_until: isoDate.nullable().default(null),
    repos: z.array(RepoRefSchema).default([]),
    branch: z.string().nullable().default(null),
    slug: z.string().nullable().default(null),
    deliverables: z.array(DeliverableSchema).default([]),
    asana: z
        .object({
            gid: z.string().nullable().default(null),
            url: z.string().nullable().default(null),
            section_gid: z.string().nullable().default(null),
            no_section: z.boolean().default(false),
            attachments: z.array(z.string()).default([]),
            // trackingFingerprint() of the last synced state (asanaSync)
            tracking_hash: z.string().nullable().default(null),
            // the gid `attachments` were added to (a re-link starts over)
            synced_gid: z.string().nullable().default(null),
        })
        .default({
            gid: null,
            url: null,
            section_gid: null,
            no_section: false,
            attachments: [],
            tracking_hash: null,
            synced_gid: null,
        }),
    wants_asana: z.boolean().default(false),
    wants_agent: z.boolean().default(false),
    worker_kind: z.enum(WORKER_KINDS).nullable().default(null),
    links: z.array(LinkSchema).default([]),
    flags: z
        .object({
            enriching: z.boolean().default(false),
            now: z.boolean().default(false),
            now_reason: z.string().nullable().default(null),
            error: z.string().nullable().default(null),
        })
        .default({
            enriching: false,
            now: false,
            now_reason: null,
            error: null,
        }),
    created_at: isoDate,
    updated_at: isoDate,
    done_at: isoDate.nullable().default(null),
})

/** Fields a caller may PATCH. id/created_at/updated_at are service-owned. */
export const TaskPatchSchema = TaskSchema.omit({
    id: true,
    created_at: true,
    updated_at: true,
}).partial()

/** Input for creating a task (capture). Everything optional but text/title. */
export const TaskCreateSchema = z
    .object({
        text: z.string().max(20000).optional(),
        title: z.string().min(1).max(300).optional(),
        url: z.string().url().optional(),
        kind: z.enum(KINDS).optional(),
        area: z.enum(AREAS).optional(),
        due_at: isoDate.optional(),
        visibility: z.enum(VISIBILITY).optional(),
        wants_asana: z.boolean().optional(),
        wants_agent: z.boolean().optional(),
        source_type: z.enum(SOURCE_TYPES).optional(),
    })
    .refine((v) => Boolean(v.text || v.title || v.url), {
        message: "text, title or url is required",
    })

// comments.jsonl records (append-only, folded into threads on read)
export const CommentCreateRecord = z.object({
    op: z.literal("create"),
    id: z.string().min(1),
    parent_id: z.string().nullable().default(null),
    anchor: AnchorSchema.nullable().default(null),
    body: z.string().min(1).max(20000),
    intent: z.enum(COMMENT_INTENTS),
    author: ActorSchema,
    job_id: z.string().nullable().default(null),
    at: isoDate,
})
export const CommentStatusRecord = z.object({
    op: z.literal("status"),
    id: z.string().min(1),
    status: z.enum(COMMENT_STATUSES),
    resolution: z.string().nullable().default(null),
    by: ActorSchema,
    at: isoDate,
})
export const CommentRecordSchema = z.discriminatedUnion("op", [
    CommentCreateRecord,
    CommentStatusRecord,
])

// feedback.jsonl records (phase 2; latest record per id wins)
export const FeedbackItemSchema = z.object({
    id: z.string().min(1),
    pr: z.string().min(1),
    round: z.number().int().positive(),
    kind: z.enum(["review_comment", "review", "issue_comment", "ci_failure"]),
    author: z.string().nullable().default(null),
    url: z.string().min(1),
    path: z.string().nullable().default(null),
    line: z.number().int().nullable().default(null),
    summary: z.string().default(""),
    actionable: z.boolean(),
    status: z.enum(["open", "fixed", "answered", "declined", "no_action"]),
    commit: z.string().nullable().default(null),
    reply_url: z.string().nullable().default(null),
    note: z.string().nullable().default(null),
    verified: z.boolean().default(false),
    // watcher verification failures (reopened once, then flagged for Leo)
    verify_failures: z.number().int().min(0).default(0),
    at: isoDate,
})

// events.jsonl records
export const EventRecordSchema = z.object({
    at: isoDate,
    actor: ActorSchema,
    type: z.string().min(1),
    data: z.record(z.string(), z.unknown()).default({}),
})

export const SCHEDULE_ACTIONS = [
    "surface",
    "center_job",
    "prompt_agent",
    "launch_agent",
]
export const ScheduleCreateSchema = z.object({
    task_id: z.number().int().positive().nullable(),
    fire_at: isoDate,
    action: z.enum(SCHEDULE_ACTIONS),
    payload: z.record(z.string(), z.unknown()).default({}),
})

/** Human id: 123 -> "T-123". */
export function taskKey(id) {
    return `T-${id}`
}

/** Folder name on disk: 123 -> "T-0123" (zero padded to 4, grows beyond). */
export function taskDirName(id) {
    return `T-${String(id).padStart(4, "0")}`
}
