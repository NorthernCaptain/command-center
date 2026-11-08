/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */
import {
    TaskSchema,
    TaskCreateSchema,
    TaskPatchSchema,
    CommentRecordSchema,
    FeedbackItemSchema,
    EventRecordSchema,
    ScheduleCreateSchema,
    ActorSchema,
    taskKey,
    taskDirName,
} from "./schemas.js"

const now = "2026-11-07T12:00:00.000Z"

test("task defaults are filled", () => {
    const t = TaskSchema.parse({
        id: 1,
        title: "x",
        kind: "todo",
        area: "web",
        status: "inbox",
        source: { type: "manual" },
        created_at: now,
        updated_at: now,
    })
    expect(t.flags.enriching).toBe(false)
    expect(t.asana.attachments).toEqual([])
    expect(t.visibility).toBe("auto")
    expect(t.priority).toBe(2)
    expect(t.source.url).toBeNull()
})

test("task rejects bad enums and ids", () => {
    const bad = {
        id: 0,
        title: "x",
        kind: "todo",
        area: "nope",
        status: "inbox",
        source: { type: "manual" },
        created_at: now,
        updated_at: now,
    }
    expect(TaskSchema.safeParse(bad).success).toBe(false)
})

test("create requires text, title or url", () => {
    expect(TaskCreateSchema.safeParse({}).success).toBe(false)
    expect(TaskCreateSchema.safeParse({ text: "hi" }).success).toBe(true)
    expect(
        TaskCreateSchema.safeParse({ url: "https://slack.com/x" }).success
    ).toBe(true)
    expect(TaskCreateSchema.safeParse({ url: "not a url" }).success).toBe(false)
})

test("patch cannot carry service-owned fields", () => {
    const p = TaskPatchSchema.parse({ id: 9, status: "ready" })
    expect(p.id).toBeUndefined()
    expect(p.status).toBe("ready")
})

test("comment records discriminate on op", () => {
    expect(
        CommentRecordSchema.parse({
            op: "create",
            id: "c1",
            body: "b",
            intent: "ask",
            author: "me",
            at: now,
        }).anchor
    ).toBeNull()
    expect(
        CommentRecordSchema.parse({
            op: "status",
            id: "c1",
            status: "resolved",
            by: "center",
            at: now,
        }).resolution
    ).toBeNull()
    expect(CommentRecordSchema.safeParse({ op: "x" }).success).toBe(false)
})

test("feedback, events, schedules", () => {
    expect(
        FeedbackItemSchema.parse({
            id: "gh-1",
            pr: "p",
            round: 1,
            kind: "ci_failure",
            url: "u",
            actionable: true,
            status: "open",
            at: now,
        }).verified
    ).toBe(false)
    expect(
        EventRecordSchema.parse({ at: now, actor: "system", type: "x" }).data
    ).toEqual({})
    expect(
        ScheduleCreateSchema.parse({
            task_id: null,
            fire_at: now,
            action: "surface",
        }).payload
    ).toEqual({})
})

test("actors", () => {
    for (const a of ["me", "center", "system", "recovery", "agent:t12-x"])
        expect(ActorSchema.safeParse(a).success).toBe(true)
    for (const a of ["you", "agent:", "agent:Bad Name"])
        expect(ActorSchema.safeParse(a).success).toBe(false)
})

test("keys and dir names", () => {
    expect(taskKey(12)).toBe("T-12")
    expect(taskDirName(12)).toBe("T-0012")
    expect(taskDirName(12345)).toBe("T-12345")
})

test("areas include batch (aws-batch) and match the web UI list", async () => {
    const { AREAS } = await import("./schemas.js")
    const web = await import("../../../web/src/lib/constants.js")
    expect(AREAS).toContain("batch")
    expect(web.AREAS).toEqual(AREAS)
    const t = TaskSchema.parse({
        id: 1,
        title: "Rerun game 123 in the pipeline",
        kind: "todo",
        area: "batch",
        status: "inbox",
        source: { type: "manual" },
        created_at: now,
        updated_at: now,
    })
    expect(t.area).toBe("batch")
})
