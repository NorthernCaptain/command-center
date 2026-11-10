/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { jest } from "@jest/globals"
import { createBus } from "../events/bus.js"
import { openDb } from "../store/db.js"
import { getSectionBody } from "../store/artifact.js"
import { createStore } from "../store/store.js"
import { createFakeClock } from "../util/clock.js"
import {
    agentActor,
    contextFromHeaders,
    createAgentTools,
    toTaskId,
    TOOL_NAMES,
    TOOL_SCHEMAS,
} from "./tools.js"

const BRANCH = "t1-fix-upload-retry"
const SESSION = "t1-fix-upload-retry"
const PR = "https://github.com/acme/aws-lambda/pull/812"

let root
let db
let store
let clock
let deps
let tools
let id

function makeDeps(over = {}) {
    return {
        store,
        clock,
        scheduler: { add: jest.fn(async (s) => ({ id: 5, ...s })) },
        dateParser: {
            parseWhen: jest.fn(async (t) =>
                t === "in 30m" ? "2026-11-07T12:30:00.000Z" : null
            ),
        },
        identity: { checkBranch: jest.fn(async () => ({ ok: true })) },
        prWatcher: {
            claim: jest.fn(async () => ({ ok: true, deliverable: {} })),
            roundResolved: jest.fn(async () => {}),
        },
        workerService: {
            agentState: jest.fn(async () => ({ name: SESSION })),
        },
        notifier: { notify: jest.fn(async () => true) },
        bus: { emit: jest.fn() },
        log: {
            error: jest.fn(),
            warn: jest.fn(),
            info: jest.fn(),
            debug: jest.fn(),
        },
        ...over,
    }
}

async function seedTask(over = {}) {
    const { task } = await store.createTask(
        {
            title: "Fix upload retry",
            area: "backend",
            status: "active",
            repos: [
                { name: "aws-lambda", role: "main" },
                { name: "infrastructure", role: "ref" },
            ],
            branch: BRANCH,
            slug: "k7q2",
            deliverables: [
                {
                    repo: "aws-lambda",
                    branch: BRANCH,
                    role: "work",
                    created_at: "2026-11-07T11:00:00.000Z",
                    disposition: "pending",
                },
            ],
            ...over,
        },
        "me"
    )
    return task.id
}

const getTask = async () => (await store.getTask(id)).task
const section = async (name) =>
    getSectionBody((await store.getArtifact(id)).content, name)

beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-mcp-"))
    db = openDb(":memory:")
    clock = createFakeClock()
    store = createStore({
        tasksDir: path.join(root, "tasks"),
        db,
        bus: createBus({ clock }),
        clock,
    })
    deps = makeDeps()
    tools = createAgentTools(deps)
    id = await seedTask()
})

afterEach(async () => {
    await store.close()
    fs.rmSync(root, { recursive: true, force: true })
})

async function expectError(promise, code, status) {
    await expect(promise).rejects.toMatchObject({ code, status })
}

describe("helpers", () => {
    test("toTaskId", () => {
        expect(toTaskId(12)).toBe(12)
        expect(toTaskId("T-12")).toBe(12)
        expect(toTaskId(" t-3 ")).toBe(3)
        expect(() => toTaskId("x")).toThrow("invalid task id")
        expect(() => toTaskId(0)).toThrow("invalid task id")
        expect(() => toTaskId(undefined)).toThrow("invalid task id")
    })

    test("agentActor", () => {
        expect(agentActor("t1-x")).toBe("agent:t1-x")
        expect(agentActor("agent:T1-X")).toBe("agent:t1-x")
        expect(agentActor("bad name")).toBeNull()
        expect(agentActor(null)).toBeNull()
    })

    test("contextFromHeaders", () => {
        expect(
            contextFromHeaders({ "x-cc-task": " 7 ", "x-cc-agent": ["a1"] })
        ).toEqual({ callerTaskId: "7", agent: "a1" })
        expect(contextFromHeaders({ "x-cc-task": "" })).toEqual({
            callerTaskId: null,
            agent: null,
        })
        expect(contextFromHeaders()).toEqual({
            callerTaskId: null,
            agent: null,
        })
    })

    test("a schema per tool", () => {
        expect(TOOL_NAMES).toHaveLength(8)
        for (const n of TOOL_NAMES) expect(TOOL_SCHEMAS[n]).toBeTruthy()
        expect(Object.keys(tools).sort()).toEqual([...TOOL_NAMES].sort())
    })
})

describe("wrong task and actor", () => {
    test("X-CC-Task must match task_id", async () => {
        await expectError(
            tools.cc_get_task({ task_id: id }, { callerTaskId: "999" }),
            "wrong_task",
            403
        )
        await expectError(
            tools.cc_get_task({ task_id: id }, { callerTaskId: "nope" }),
            "wrong_task",
            403
        )
        const ok = await tools.cc_get_task(
            { task_id: `T-${id}` },
            { callerTaskId: `T-${id}` }
        )
        expect(ok.task.id).toBe(id)
    })

    test("invalid args are validation errors; unknown task is 404", async () => {
        await expectError(tools.cc_get_task({}), "validation", 400)
        await expectError(tools.cc_get_task(), "validation", 400)
        await expectError(
            tools.cc_get_task({ task_id: "abc" }),
            "validation",
            400
        )
        await expectError(tools.cc_get_task({ task_id: 999 }), "not_found", 404)
    })

    test("actor: ctx.actor, header, live session, unknown", async () => {
        const line = async (ctx) =>
            (
                await tools.cc_log_decision(
                    { task_id: id, decision: "d", rationale: "r" },
                    ctx
                )
            ).line
        expect(await line({ actor: "agent:zed" })).toContain("· agent:zed ·")
        expect(await line({ actor: "me", agent: "hdr" })).toContain(
            "· agent:hdr ·"
        )
        expect(await line({})).toContain(`· agent:${SESSION} ·`)
        deps.workerService.agentState.mockResolvedValueOnce(null)
        expect(await line({})).toContain("· agent:unknown ·")
        deps.workerService.agentState.mockRejectedValueOnce(new Error("x"))
        expect(await line({})).toContain("· agent:unknown ·")
        const bare = createAgentTools(makeDeps({ workerService: null }))
        const r = await bare.cc_log_decision({
            task_id: id,
            decision: "d",
            rationale: "r",
        })
        expect(r.line).toContain("· agent:unknown ·")
    })
})

describe("cc_get_task", () => {
    test("returns the brief", async () => {
        const c1 = await store.appendComment(
            id,
            { body: "open one", intent: "ask" },
            "me"
        )
        const c2 = await store.appendComment(
            id,
            { body: "done one", intent: "note" },
            "me"
        )
        await store.setCommentStatus(id, c2.id, { status: "resolved" }, "me")
        await store.appendFeedback(id, {
            id: "gh-rc-1",
            pr: PR,
            round: 1,
            kind: "review_comment",
            url: `${PR}#discussion_r1`,
            actionable: true,
            status: "open",
        })
        await store.appendFeedback(id, {
            id: "gh-ic-2",
            pr: PR,
            round: 1,
            kind: "issue_comment",
            url: `${PR}#issuecomment-2`,
            actionable: false,
            status: "no_action",
        })
        const art = await store.getArtifact(id)
        const r = await tools.cc_get_task({ task_id: id })
        expect(r.task.id).toBe(id)
        expect(r.revision).toBe(art.revision)
        expect(r.artifact).toBe(art.content)
        expect(r.open_comments.map((c) => c.id)).toEqual([c1.id])
        expect(r.feedback_open.map((f) => f.id)).toEqual(["gh-rc-1"])
        expect(r.deliverables).toHaveLength(1)
        expect(r.links).toEqual([])
        expect(r.asana_url).toBeNull()
    })
})

describe("cc_update_artifact", () => {
    test("append without base_revision", async () => {
        const r = await tools.cc_update_artifact({
            task_id: id,
            section: "Progress",
            op: "append",
            content: "- step one",
        })
        expect(r.revision).toBe((await store.getArtifact(id)).revision)
        expect(await section("Progress")).toContain("- step one")
    })

    test("replace requires base_revision", async () => {
        await expectError(
            tools.cc_update_artifact({
                task_id: id,
                section: "Plan",
                op: "replace",
                content: "x",
            }),
            "validation",
            400
        )
    })

    test("replace with a stale base_revision returns the current content", async () => {
        const art = await store.getArtifact(id)
        const err = await tools
            .cc_update_artifact({
                task_id: id,
                section: "Plan",
                op: "replace",
                content: "x",
                base_revision: "deadbeef",
            })
            .catch((e) => e)
        expect(err).toMatchObject({ code: "stale_revision", status: 409 })
        expect(err.details).toEqual({
            revision: art.revision,
            content: art.content,
        })
    })

    test("replace with the current base_revision", async () => {
        const art = await store.getArtifact(id)
        const r = await tools.cc_update_artifact({
            task_id: id,
            section: "Plan",
            op: "replace",
            content: "1. do it",
            base_revision: art.revision,
        })
        expect(r.revision).not.toBe(art.revision)
        expect(await section("Plan")).toBe("1. do it")
    })

    test("section names", async () => {
        await expectError(
            tools.cc_update_artifact({
                task_id: id,
                section: "## Plan",
                op: "append",
                content: "x",
            }),
            "validation",
            400
        )
        await expectError(
            tools.cc_update_artifact({
                task_id: id,
                section: "a\nb",
                op: "append",
                content: "x",
            }),
            "validation",
            400
        )
    })
})

describe("cc_log_decision", () => {
    test("appends a dated one-line entry to Decisions", async () => {
        const r = await tools.cc_log_decision(
            {
                task_id: id,
                decision: "use  exponential\nbackoff",
                rationale: "fewer retries",
            },
            { agent: "t1-a" }
        )
        expect(r.line).toBe(
            "- 2026-11-07 · agent:t1-a · use exponential backoff · fewer retries"
        )
        expect(await section("Decisions")).toContain(r.line)
    })
})

describe("cc_add_link: branch", () => {
    test("requires repo and a valid name", async () => {
        await expectError(
            tools.cc_add_link({ task_id: id, type: "branch", url: "b" }),
            "validation",
            400
        )
        await expectError(
            tools.cc_add_link({
                task_id: id,
                type: "branch",
                url: "-bad",
                repo: "aws-lambda",
            }),
            "validation",
            400
        )
    })

    test("no identity service -> 503", async () => {
        const t = createAgentTools(makeDeps({ identity: null }))
        await expectError(
            t.cc_add_link({
                task_id: id,
                type: "branch",
                url: "b",
                repo: "aws-lambda",
            }),
            "unavailable",
            503
        )
    })

    test("conflict flags the task and returns the suggestion", async () => {
        deps.identity.checkBranch.mockResolvedValueOnce({
            ok: false,
            reason: "used by T-9",
            suggestion: "t1-other",
        })
        const r = await tools.cc_add_link({
            task_id: id,
            type: "branch",
            url: "feature/x",
            repo: "aws-lambda",
        })
        expect(r).toEqual({
            ok: false,
            conflict: "used by T-9",
            suggestion: "t1-other",
        })
        expect(deps.identity.checkBranch).toHaveBeenCalledWith(
            "aws-lambda",
            "feature/x",
            id
        )
        const t = await getTask()
        expect(t.branch).toBe(BRANCH)
        expect(t.flags.now).toBe(true)
        expect(t.flags.now_reason).toMatch(/Branch conflict/)
        expect(t.links).toEqual([])
    })

    test("conflict with an empty answer", async () => {
        deps.identity.checkBranch.mockResolvedValueOnce(null)
        const r = await tools.cc_add_link({
            task_id: id,
            type: "branch",
            url: "x",
            repo: "aws-lambda",
        })
        expect(r).toEqual({
            ok: false,
            conflict: "branch rejected",
            suggestion: null,
        })
    })

    test("ok on the main repo sets task.branch and the deliverable", async () => {
        const r = await tools.cc_add_link({
            task_id: id,
            type: "branch",
            url: "feature/t1-upload",
            repo: "aws-lambda",
        })
        expect(r.ok).toBe(true)
        expect(r.link).toMatchObject({
            type: "branch",
            url: "feature/t1-upload",
            label: "aws-lambda",
            added_by: `agent:${SESSION}`,
        })
        const t = await getTask()
        expect(t.branch).toBe("feature/t1-upload")
        expect(t.deliverables[0].branch).toBe("feature/t1-upload")
        expect(t.links).toHaveLength(1)
        // same link again: updated, not duplicated; label stays the repo
        await tools.cc_add_link({
            task_id: id,
            type: "branch",
            url: "feature/t1-upload",
            repo: "aws-lambda",
            label: "main",
        })
        const t2 = await getTask()
        expect(t2.links).toHaveLength(1)
        expect(t2.links[0].label).toBe("aws-lambda")
    })

    test("ok on another repo leaves task.branch alone", async () => {
        await tools.cc_add_link({
            task_id: id,
            type: "branch",
            url: "infra-branch",
            repo: "infrastructure",
        })
        const t = await getTask()
        expect(t.branch).toBe(BRANCH)
        expect(t.deliverables[0].branch).toBe(BRANCH)
    })
})

describe("cc_add_link: branch of a claimed PR", () => {
    const owning = () =>
        makeDeps({
            prWatcher: {
                claim: jest.fn(),
                roundResolved: jest.fn(),
                ownsBranch: jest.fn(
                    (taskId, repo, branch) =>
                        taskId === id &&
                        repo === "aws-lambda" &&
                        branch === "fix/existing"
                ),
            },
        })

    test("the head of a claimed PR skips the remote check and clears the conflict flag", async () => {
        const d = owning()
        const t = createAgentTools(d)
        await store.updateTask(
            id,
            {
                flags: {
                    now: true,
                    now_reason: "Branch conflict: fix/existing in aws-lambda",
                },
            },
            { actor: "me" }
        )
        const r = await t.cc_add_link({
            task_id: id,
            type: "branch",
            url: "fix/existing",
            repo: "aws-lambda",
        })
        expect(r).toMatchObject({ ok: true, branch: "fix/existing" })
        expect(d.identity.checkBranch).not.toHaveBeenCalled()
        const task = await getTask()
        expect(task.branch).toBe("fix/existing")
        expect(task.deliverables[0].branch).toBe("fix/existing")
        expect(task.flags).toMatchObject({ now: false, now_reason: null })
    })

    test("other branches still go through the checks; other flags stay", async () => {
        const d = owning()
        const t = createAgentTools(d)
        await store.updateTask(
            id,
            { flags: { now: true, now_reason: "Ready for PR" } },
            { actor: "me" }
        )
        await t.cc_add_link({
            task_id: id,
            type: "branch",
            url: "fix/other",
            repo: "aws-lambda",
        })
        expect(d.identity.checkBranch).toHaveBeenCalledWith(
            "aws-lambda",
            "fix/other",
            id
        )
        expect((await getTask()).flags.now_reason).toBe("Ready for PR")
    })

    test("a conflict flag for another repo stays", async () => {
        await store.updateTask(
            id,
            {
                flags: {
                    now: true,
                    now_reason: "Branch conflict: x in infrastructure",
                },
            },
            { actor: "me" }
        )
        await tools.cc_add_link({
            task_id: id,
            type: "branch",
            url: "fix/ok",
            repo: "aws-lambda",
        })
        expect((await getTask()).flags.now_reason).toBe(
            "Branch conflict: x in infrastructure"
        )
    })

    test("folder with a different branch moves the existing deliverable", async () => {
        const d = owning()
        const t = createAgentTools(d)
        await store.updateTask(
            id,
            {
                flags: {
                    now: true,
                    now_reason: "Branch conflict: fix/existing in aws-lambda",
                },
            },
            { actor: "me" }
        )
        const r = await t.cc_add_link({
            task_id: id,
            type: "folder",
            url: `/Users/me/work/tree/aws-lambda--${BRANCH}--k7q2`,
            role: "work",
            branch: "fix/existing",
        })
        expect(r.ok).toBe(true)
        expect(r.deliverable.branch).toBe("fix/existing")
        const task = await getTask()
        expect(task.deliverables).toHaveLength(1)
        expect(task.deliverables[0].branch).toBe("fix/existing")
        expect(task.branch).toBe("fix/existing")
        expect(task.flags.now).toBe(false)
    })

    test("folder with the deliverable's branch clears that repo's conflict", async () => {
        await store.updateTask(
            id,
            {
                flags: {
                    now: true,
                    now_reason: `Branch conflict: ${BRANCH} in aws-lambda`,
                },
            },
            { actor: "me" }
        )
        const r = await tools.cc_add_link({
            task_id: id,
            type: "folder",
            url: `/Users/me/work/tree/aws-lambda--${BRANCH}--k7q2`,
            role: "work",
            branch: BRANCH,
        })
        expect(r.ok).toBe(true)
        expect(deps.identity.checkBranch).not.toHaveBeenCalled()
        expect((await getTask()).flags.now).toBe(false)
    })

    test("folder with a rejected branch flags and leaves the deliverable", async () => {
        deps.identity.checkBranch.mockResolvedValueOnce({
            ok: false,
            reason: "exists on remote",
            suggestion: "t1-x",
        })
        const r = await tools.cc_add_link({
            task_id: id,
            type: "folder",
            url: `/Users/me/work/tree/aws-lambda--${BRANCH}--k7q2`,
            role: "work",
            branch: "fix/taken",
        })
        expect(r).toEqual({
            ok: false,
            conflict: "exists on remote",
            suggestion: "t1-x",
        })
        const task = await getTask()
        expect(task.deliverables[0].branch).toBe(BRANCH)
        expect(task.flags.now_reason).toBe(
            "Branch conflict: fix/taken in aws-lambda"
        )
        expect(task.links).toEqual([])
    })

    test("folder with the same branch runs no checks", async () => {
        const r = await tools.cc_add_link({
            task_id: id,
            type: "folder",
            url: `/Users/me/work/tree/aws-lambda--${BRANCH}--k7q2`,
            role: "work",
            branch: BRANCH,
        })
        expect(r.ok).toBe(true)
        expect(deps.identity.checkBranch).not.toHaveBeenCalled()
    })
})

describe("cc_add_link: folder", () => {
    test("work folder adds a deliverable and promotes the repo", async () => {
        const folder = `/Users/me/work/tree/infrastructure--${BRANCH}--k7q2/`
        const r = await tools.cc_add_link({
            task_id: id,
            type: "folder",
            url: folder,
            role: "work",
        })
        expect(r.deliverable).toMatchObject({
            repo: "infrastructure",
            branch: BRANCH,
            disposition: "pending",
            created_at: "2026-11-07T12:00:00.000Z",
        })
        const t = await getTask()
        expect(t.deliverables.map((d) => d.repo)).toEqual([
            "aws-lambda",
            "infrastructure",
        ])
        expect(t.repos.find((x) => x.name === "infrastructure").role).toBe(
            "work"
        )
        expect(t.links[0]).toMatchObject({
            type: "folder",
            role: "work",
            label: "infrastructure",
        })
        // again: no duplicate deliverable
        const again = await tools.cc_add_link({
            task_id: id,
            type: "folder",
            url: folder,
            role: "work",
        })
        expect(again.deliverable.repo).toBe("infrastructure")
        expect((await getTask()).deliverables).toHaveLength(2)
    })

    test("work folder for a repo not in task.repos", async () => {
        await tools.cc_add_link({
            task_id: id,
            type: "folder",
            url: "/tmp/somewhere",
            role: "work",
            repo: "web-app",
        })
        const t = await getTask()
        expect(t.repos.at(-1)).toEqual({ name: "web-app", role: "work" })
        expect(t.deliverables.at(-1)).toMatchObject({
            repo: "web-app",
            branch: BRANCH,
        })
    })

    test("work folder of the main repo keeps repos", async () => {
        const r = await tools.cc_add_link({
            task_id: id,
            type: "folder",
            url: `aws-lambda--${BRANCH}--k7q2`,
            role: "work",
        })
        expect(r.deliverable.repo).toBe("aws-lambda")
        expect((await getTask()).repos[0]).toEqual({
            name: "aws-lambda",
            role: "main",
        })
    })

    test("work folder errors", async () => {
        await expectError(
            tools.cc_add_link({
                task_id: id,
                type: "folder",
                url: "/tmp/x",
                role: "work",
            }),
            "validation",
            400
        )
        const other = await seedTask({ branch: null, deliverables: [] })
        await expectError(
            tools.cc_add_link({
                task_id: other,
                type: "folder",
                url: "/tmp/x",
                role: "work",
                repo: "aws-lambda",
            }),
            "validation",
            400
        )
    })

    test("slashed task branch: never inferred from the folder name", async () => {
        const other = await seedTask({
            branch: "feature/upload",
            deliverables: [],
        })
        const r = await tools.cc_add_link({
            task_id: other,
            type: "folder",
            url: "/tree/infra--feature-upload--k7q2",
            role: "work",
        })
        expect(r.deliverable).toMatchObject({
            repo: "infra",
            branch: "feature/upload",
        })
    })

    test("the repo's registered branch wins over task.branch", async () => {
        await tools.cc_add_link({
            task_id: id,
            type: "branch",
            url: "infra/t1-x",
            repo: "infrastructure",
        })
        const r = await tools.cc_add_link({
            task_id: id,
            type: "folder",
            url: `/tree/infrastructure--infra-t1-x--k7q2`,
            role: "work",
        })
        expect(r.deliverable.branch).toBe("infra/t1-x")
    })

    test("an inherited task branch taken in the new repo is a conflict", async () => {
        deps.identity.checkBranch.mockResolvedValueOnce({
            ok: false,
            reason: "branch used by T-7 in infra",
            suggestion: `${BRANCH}-2`,
        })
        const r = await tools.cc_add_link({
            task_id: id,
            type: "folder",
            url: "/tree/infra--x--k7q2",
            role: "work",
        })
        expect(r).toMatchObject({
            ok: false,
            conflict: "branch used by T-7 in infra",
            suggestion: `${BRANCH}-2`,
        })
        const { task } = await deps.store.getTask(id)
        expect(task.deliverables.some((d) => d.repo === "infra")).toBe(false)
        expect(task.flags.now_reason).toBe(
            `Branch conflict: ${BRANCH} in infra`
        )
    })

    test("explicit branch argument", async () => {
        const same = await tools.cc_add_link({
            task_id: id,
            type: "folder",
            url: "/tree/web--x--k7q2",
            role: "work",
            branch: BRANCH,
        })
        expect(same.deliverable.branch).toBe(BRANCH)
        // the task branch is new for repo "web": checked for that repo
        expect(deps.identity.checkBranch).toHaveBeenCalledWith(
            "web",
            BRANCH,
            id
        )

        const fresh = await tools.cc_add_link({
            task_id: id,
            type: "folder",
            url: "/tree/infra--feat-y--k7q2",
            role: "work",
            branch: "feat/y",
        })
        expect(fresh.deliverable.branch).toBe("feat/y")
        expect(deps.identity.checkBranch).toHaveBeenCalledWith(
            "infra",
            "feat/y",
            id
        )

        deps.identity.checkBranch.mockResolvedValueOnce({
            ok: false,
            reason: "taken",
            suggestion: "t1-z",
        })
        const bad = await tools.cc_add_link({
            task_id: id,
            type: "folder",
            url: "/tree/api--z--k7q2",
            role: "work",
            branch: "z",
        })
        expect(bad).toEqual({
            ok: false,
            conflict: "taken",
            suggestion: "t1-z",
        })
        const t = await getTask()
        expect(t.deliverables.map((d) => d.repo)).not.toContain("api")
        expect(t.flags.now_reason).toBe("Branch conflict: z in api")

        deps.identity.checkBranch.mockResolvedValueOnce(null)
        const rejected = await tools.cc_add_link({
            task_id: id,
            type: "folder",
            url: "/tree/api--z--k7q2",
            role: "work",
            branch: "z",
        })
        expect(rejected).toMatchObject({
            ok: false,
            conflict: "branch rejected",
            suggestion: null,
        })

        await expectError(
            tools.cc_add_link({
                task_id: id,
                type: "folder",
                url: "/tree/x",
                role: "work",
                repo: "api",
                branch: "bad branch",
            }),
            "validation",
            400
        )
        const noId = createAgentTools(makeDeps({ identity: null }))
        await expectError(
            noId.cc_add_link({
                task_id: id,
                type: "folder",
                url: "/tree/api--z--k7q2",
                role: "work",
                branch: "z",
            }),
            "unavailable",
            503
        )
    })

    test("task note branch (scanFolders) when nothing else is known", async () => {
        const other = await seedTask({
            branch: null,
            slug: "ab12",
            deliverables: [],
        })
        const folder = "/tree/infra--feature-upload--ab12"
        const add = (t) =>
            t.cc_add_link({
                task_id: other,
                type: "folder",
                url: folder,
                role: "work",
            })
        const withScan = (impl) =>
            createAgentTools(
                makeDeps({
                    identity: {
                        checkBranch: jest.fn(async () => ({ ok: true })),
                        scanFolders: jest.fn(impl),
                    },
                })
            )
        // name fallback (no note): rejected
        await expectError(
            add(
                withScan(async () => [
                    {
                        folder: "infra--feature-upload--ab12",
                        repo: "infra",
                        branch: "feature-upload",
                    },
                ])
            ),
            "validation",
            400
        )
        // scan failure, or folder missing from the scan: rejected
        await expectError(
            add(
                withScan(async () => {
                    throw new Error("io")
                })
            ),
            "validation",
            400
        )
        await expectError(add(withScan(async () => null)), "validation", 400)
        // note branch with slashes
        const t = withScan(async (slug) =>
            slug === "ab12"
                ? [
                      {
                          folder: "infra--feature-upload--ab12",
                          repo: "infra",
                          branch: "feature/upload",
                      },
                  ]
                : []
        )
        const r = await add(t)
        expect(r.deliverable.branch).toBe("feature/upload")
    })

    test("a note branch equal to the name part counts when the note was read", async () => {
        const other = await seedTask({
            branch: null,
            slug: "ab12",
            deliverables: [],
        })
        const t = createAgentTools(
            makeDeps({
                identity: {
                    checkBranch: jest.fn(async () => ({ ok: true })),
                    scanFolders: () => [
                        {
                            folder: "infra--t9-x--ab12",
                            repo: "infra",
                            branch: "t9-x",
                            status: "in-progress",
                        },
                    ],
                },
            })
        )
        const r = await t.cc_add_link({
            task_id: other,
            type: "folder",
            url: "infra--t9-x--ab12",
            role: "work",
        })
        expect(r.deliverable.branch).toBe("t9-x")
    })

    test("no slug: no scan", async () => {
        const other = await seedTask({
            branch: null,
            slug: null,
            deliverables: [],
        })
        const scanFolders = jest.fn()
        const t = createAgentTools(
            makeDeps({ identity: { checkBranch: jest.fn(), scanFolders } })
        )
        await expectError(
            t.cc_add_link({
                task_id: other,
                type: "folder",
                url: "/tree/infra--a--zz99",
                role: "work",
            }),
            "validation",
            400
        )
        expect(scanFolders).not.toHaveBeenCalled()
    })

    test("ref folder is a link only", async () => {
        const r = await tools.cc_add_link({
            task_id: id,
            type: "folder",
            url: "/tmp/plain",
            role: "ref",
        })
        expect(r.deliverable).toBeNull()
        expect(r.link).toMatchObject({ role: "ref", label: null })
        expect((await getTask()).deliverables).toHaveLength(1)
    })
})

describe("cc_add_link: pr and others", () => {
    test("pr goes through the watcher's claim", async () => {
        const r = await tools.cc_add_link({ task_id: id, type: "pr", url: PR })
        expect(r).toEqual({ ok: true, deliverable: {} })
        expect(deps.prWatcher.claim).toHaveBeenCalledWith(id, PR, {
            manual: false,
            reported: true,
            actor: expect.stringMatching(/^agent:/),
        })
        const t = createAgentTools(makeDeps({ prWatcher: null }))
        await expectError(
            t.cc_add_link({ task_id: id, type: "pr", url: PR }),
            "unavailable",
            503
        )
    })

    test("doc is a plain link", async () => {
        const r = await tools.cc_add_link({
            task_id: id,
            type: "doc",
            url: "https://example.com/spec",
            label: "Spec",
        })
        expect(r.ok).toBe(true)
        expect((await getTask()).links[0]).toMatchObject({
            type: "doc",
            label: "Spec",
            role: null,
        })
    })
})

describe("cc_report", () => {
    test("progress appends and keeps status", async () => {
        const r = await tools.cc_report({
            task_id: id,
            status: "progress",
            summary: "wired the retry\nadded tests",
            checks: ["unit ok", "lint ok"],
            next_steps: "review",
        })
        expect(r).toMatchObject({ ok: true, status: "active" })
        const body = await section("Progress")
        expect(body).toContain(
            `- 2026-11-07T12:00:00.000Z · agent:${SESSION} · progress: wired the retry\n  added tests`
        )
        expect(body).toContain("  - Checks: unit ok; lint ok")
        expect(body).toContain("  - Next steps: review")
        const events = await store.listEvents(id)
        expect(events[0]).toMatchObject({
            type: "agent_report",
            data: { status: "progress" },
        })
    })

    test("ready_for_pr requires work_repos", async () => {
        await expectError(
            tools.cc_report({
                task_id: id,
                status: "ready_for_pr",
                summary: "done",
            }),
            "validation",
            400
        )
    })

    test("ready_for_pr with matching repos", async () => {
        const r = await tools.cc_report({
            task_id: id,
            status: "ready_for_pr",
            summary: "done",
            work_repos: ["aws-lambda"],
            checks: "tests pass, review GOOD_TO_GO",
        })
        expect(r).toMatchObject({ ok: true, status: "ready_for_pr" })
        const t = await getTask()
        expect(t.status).toBe("ready_for_pr")
        expect(t.flags).toMatchObject({ now: true, now_reason: "Ready for PR" })
        expect(deps.notifier.notify).toHaveBeenCalledWith(
            expect.objectContaining({ title: "Ready for PR", url: `/t/${id}` })
        )
        const body = await section("Progress")
        expect(body).toContain("  - Work repos: aws-lambda")
        expect(body).toContain("  - Checks: tests pass, review GOOD_TO_GO")
    })

    test("ready_for_pr ignores deliverables Leo marked no_change", async () => {
        const mixed = await seedTask({
            deliverables: [
                {
                    repo: "aws-lambda",
                    branch: BRANCH,
                    role: "work",
                    created_at: "2026-11-07T11:00:00.000Z",
                    disposition: "pending",
                },
                {
                    repo: "infrastructure",
                    branch: BRANCH,
                    role: "work",
                    created_at: "2026-11-07T11:00:00.000Z",
                    disposition: "no_change",
                },
            ],
        })
        const r = await tools.cc_report({
            task_id: mixed,
            status: "ready_for_pr",
            summary: "done",
            work_repos: ["aws-lambda"],
        })
        expect(r).toMatchObject({ ok: true, status: "ready_for_pr" })
        expect((await store.getTask(mixed)).task.status).toBe("ready_for_pr")
        // reporting the no_change repo as changed is now a mismatch
        const again = await seedTask({
            deliverables: [
                {
                    repo: "aws-lambda",
                    branch: BRANCH,
                    role: "work",
                    created_at: "2026-11-07T11:00:00.000Z",
                    disposition: "no_change",
                },
            ],
        })
        const r2 = await tools.cc_report({
            task_id: again,
            status: "ready_for_pr",
            summary: "done",
            work_repos: ["aws-lambda"],
        })
        expect(r2).toMatchObject({ ok: false })
    })

    test("ready_for_pr with different repos flags Now and keeps status", async () => {
        const r = await tools.cc_report({
            task_id: id,
            status: "ready_for_pr",
            summary: "done",
            work_repos: ["aws-lambda", "infrastructure"],
        })
        expect(r).toMatchObject({
            ok: false,
            status: "active",
            mismatch: {
                reported: ["aws-lambda", "infrastructure"],
                deliverables: ["aws-lambda"],
            },
        })
        const t = await getTask()
        expect(t.status).toBe("active")
        expect(t.flags.now_reason).toMatch(/^Work repos differ/)
    })

    test("ready_for_pr with no deliverables", async () => {
        const other = await seedTask({ deliverables: [] })
        const r = await tools.cc_report({
            task_id: other,
            status: "ready_for_pr",
            summary: "done",
            work_repos: ["aws-lambda"],
        })
        expect(r.ok).toBe(false)
        expect((await store.getTask(other)).task.flags.now_reason).toMatch(
            /deliverables none/
        )
    })

    test("review moves to review and Now", async () => {
        const r = await tools.cc_report({
            task_id: id,
            status: "review",
            summary: "wrote the doc",
        })
        expect(r.status).toBe("review")
        expect((await getTask()).flags.now).toBe(true)
    })

    const dlv = (repo, disposition = "pending", over = {}) => ({
        repo,
        branch: BRANCH,
        role: "work",
        created_at: "2026-11-07T11:00:00.000Z",
        disposition,
        ...over,
    })

    test("review again from pr_open (more work after review, PR still open)", async () => {
        const t1 = await seedTask({
            status: "pr_open",
            deliverables: [
                dlv("aws-lambda", "pr", {
                    pr: "https://github.com/acme/aws-lambda/pull/9",
                }),
            ],
        })
        const r = await tools.cc_report({
            task_id: t1,
            status: "review",
            summary: "answered the follow-up",
        })
        expect(r).toMatchObject({ ok: true, status: "review" })
        expect((await store.getTask(t1)).task.flags.now_reason).toBe(
            "Ready for review"
        )
    })

    test("review with no_change_repos marks those deliverables no_change", async () => {
        const t1 = await seedTask({ deliverables: [dlv("aws-lambda")] })
        const r = await tools.cc_report({
            task_id: t1,
            status: "review",
            summary: "investigated: nothing to change",
            no_change_repos: ["AWS-Lambda"],
        })
        expect(r).toMatchObject({ ok: true, status: "review" })
        const t = (await store.getTask(t1)).task
        expect(t.deliverables[0].disposition).toBe("no_change")
        const events = await store.listEvents(t1, { limit: 50 })
        expect(
            events.find((e) => e.type === "deliverable_no_change")
        ).toMatchObject({
            data: { repo: "aws-lambda" },
            actor: `agent:${SESSION}`,
        })
        expect(
            events.find((e) => e.type === "agent_report").data
        ).toMatchObject({
            no_change_repos: ["AWS-Lambda"],
        })
        const body = (await store.getArtifact(t1)).content
        expect(body).toContain("  - No change needed: AWS-Lambda")
        // again: already no_change, nothing new
        await tools.cc_report({
            task_id: t1,
            status: "review",
            summary: "still nothing",
            no_change_repos: ["aws-lambda"],
        })
        const again = await store.listEvents(t1, { limit: 50 })
        expect(
            again.filter((e) => e.type === "deliverable_no_change")
        ).toHaveLength(1)
    })

    test("ready_for_pr: work_repos + no_change_repos cover the deliverables", async () => {
        const t2 = await seedTask({
            deliverables: [dlv("aws-lambda"), dlv("infrastructure")],
        })
        const r = await tools.cc_report({
            task_id: t2,
            status: "ready_for_pr",
            summary: "lambda changed, infra untouched",
            work_repos: ["aws-lambda"],
            no_change_repos: ["infrastructure"],
        })
        expect(r).toMatchObject({ ok: true, status: "ready_for_pr" })
        const t = (await store.getTask(t2)).task
        expect(t.deliverables.map((d) => d.disposition)).toEqual([
            "pending",
            "no_change",
        ])
    })

    test("no_change_repos is rejected for other statuses, unknown repos, overlaps and PRs", async () => {
        const t3 = await seedTask({
            deliverables: [
                dlv("aws-lambda"),
                dlv("infrastructure", "pr", {
                    pr: "https://github.com/o/infrastructure/pull/1",
                }),
            ],
        })
        const base = { task_id: t3, summary: "x" }
        await expectError(
            tools.cc_report({
                ...base,
                status: "progress",
                no_change_repos: ["aws-lambda"],
            }),
            "validation",
            400
        )
        await expectError(
            tools.cc_report({
                ...base,
                status: "review",
                no_change_repos: ["web-trace"],
            }),
            "validation",
            400
        )
        await expectError(
            tools.cc_report({
                ...base,
                status: "ready_for_pr",
                work_repos: ["aws-lambda"],
                no_change_repos: ["aws-lambda"],
            }),
            "validation",
            400
        )
        await expectError(
            tools.cc_report({
                ...base,
                status: "review",
                no_change_repos: ["infrastructure"],
            }),
            "invalid_state",
            409
        )
        // nothing was changed by the rejected reports
        const t = (await store.getTask(t3)).task
        expect(t.status).toBe("active")
        expect(t.deliverables.map((d) => d.disposition)).toEqual([
            "pending",
            "pr",
        ])
    })

    test("blocked flags Now and notifies; notifier failures are logged", async () => {
        deps.notifier.notify.mockRejectedValueOnce(new Error("no herdr"))
        const r = await tools.cc_report({
            task_id: id,
            status: "blocked",
            summary: "need AWS access",
        })
        expect(r.status).toBe("active")
        expect((await getTask()).flags.now_reason).toBe(
            "Agent blocked: need AWS access"
        )
        expect(deps.log.warn).toHaveBeenCalled()
        const quiet = createAgentTools(makeDeps({ notifier: null }))
        await quiet.cc_report({
            task_id: id,
            status: "blocked",
            summary: "again",
        })
    })
})

describe("cc_feedback", () => {
    const item = (over) => ({
        pr: PR,
        round: 1,
        url: `${PR}#x`,
        actionable: true,
        status: "open",
        ...over,
    })

    beforeEach(async () => {
        await store.appendFeedback(
            id,
            item({ id: "gh-rc-1", kind: "review_comment", path: "a.js" })
        )
        await store.appendFeedback(
            id,
            item({ id: "ci-unit-abc1234", kind: "ci_failure" })
        )
        await store.appendFeedback(
            id,
            item({ id: "gh-ic-3", kind: "issue_comment", status: "no_action" })
        )
        await store.appendFeedback(
            id,
            item({ id: "gh-rv-9", kind: "review", round: 2 })
        )
    })

    const fb = (args, ctx) => tools.cc_feedback({ task_id: id, ...args }, ctx)

    test("item must exist and be open", async () => {
        await expectError(
            fb({ item_id: "nope", status: "fixed", commit: "abc1234" }),
            "not_found",
            404
        )
        const err = await fb({
            item_id: "gh-ic-3",
            status: "answered",
            reply_url: "https://github.com/x",
        }).catch((e) => e)
        expect(err).toMatchObject({ code: "item_not_open", status: 409 })
        expect(err.details).toEqual({ status: "no_action" })
    })

    test("required fields by kind", async () => {
        await expectError(
            fb({
                item_id: "gh-rc-1",
                status: "fixed",
                reply_url: "https://g/x",
            }),
            "validation",
            400
        )
        const e = await fb({
            item_id: "gh-rc-1",
            status: "fixed",
            commit: "abc1234",
        }).catch((x) => x)
        expect(e.message).toBe("review_comment fixed requires reply_url")
        await expectError(
            fb({ item_id: "gh-rv-9", status: "answered" }),
            "validation",
            400
        )
        await expectError(
            fb({ item_id: "ci-unit-abc1234", status: "answered" }),
            "validation",
            400
        )
        await expectError(
            fb({ item_id: "ci-unit-abc1234", status: "declined" }),
            "validation",
            400
        )
        await expectError(
            fb({
                item_id: "gh-rc-1",
                status: "answered",
                reply_url: "javascript:alert(1)",
            }),
            "validation",
            400
        )
        await expectError(
            fb({ item_id: "gh-rc-1", status: "no_action" }),
            "validation",
            400
        )
        await expectError(
            fb({ item_id: "gh-rc-1", status: "fixed", commit: "zzz" }),
            "validation",
            400
        )
    })

    test("resolving the last open item of a round calls roundResolved", async () => {
        const r1 = await fb({
            item_id: "ci-unit-abc1234",
            status: "fixed",
            commit: "abc1234",
        })
        expect(r1).toMatchObject({ ok: true, round: 1, round_resolved: false })
        // refresh event even though the round is still open
        expect(deps.bus.emit).toHaveBeenCalledTimes(1)
        expect(deps.bus.emit).toHaveBeenCalledWith("feedback.updated", {
            task_id: id,
            data: {},
        })
        expect(r1.item).toMatchObject({
            status: "fixed",
            commit: "abc1234",
            reply_url: null,
            verified: false,
            kind: "ci_failure",
        })
        expect(deps.prWatcher.roundResolved).not.toHaveBeenCalled()
        const r2 = await fb({
            item_id: "gh-rc-1",
            status: "answered",
            reply_url: "https://github.com/x#r2",
            note: "explained",
        })
        expect(r2.round_resolved).toBe(true)
        expect(deps.prWatcher.roundResolved).toHaveBeenCalledWith(id)
        expect(deps.bus.emit).toHaveBeenCalledTimes(2)
        const latest = await store.listFeedback(id)
        expect(latest.find((i) => i.id === "gh-rc-1")).toMatchObject({
            status: "answered",
            note: "explained",
            path: "a.js",
            at: "2026-11-07T12:00:00.000Z",
        })
    })

    test("declined flags Now and notifies", async () => {
        const r = await fb({
            item_id: "ci-unit-abc1234",
            status: "declined",
            reply_url: "https://github.com/x#c",
            note: "flaky",
        })
        expect(r.ok).toBe(true)
        expect((await getTask()).flags.now_reason).toBe(
            "Agent declined feedback ci-unit-abc1234"
        )
        expect(deps.notifier.notify).toHaveBeenCalledWith(
            expect.objectContaining({ title: "Agent declined PR feedback" })
        )
        // declined without a note
        const r2 = await fb({
            item_id: "gh-rv-9",
            status: "declined",
            reply_url: "https://github.com/x#d",
        })
        expect(r2.round_resolved).toBe(true)
    })

    test("no event on a rejected resolution; emit failures are logged", async () => {
        await fb({ item_id: "gh-rc-1", status: "fixed" }).catch(() => {})
        expect(deps.bus.emit).not.toHaveBeenCalled()
        deps.bus.emit.mockImplementationOnce(() => {
            throw new Error("bus down")
        })
        const r = await fb({
            item_id: "gh-rv-9",
            status: "fixed",
            commit: "abcdef1",
            reply_url: "https://github.com/x#f",
        })
        expect(r.ok).toBe(true)
        expect(deps.log.warn).toHaveBeenCalled()
    })

    test("works without a PR watcher or bus", async () => {
        const t = createAgentTools(makeDeps({ prWatcher: null, bus: null }))
        const r = await t.cc_feedback({
            task_id: id,
            item_id: "gh-rv-9",
            status: "fixed",
            commit: "abcdef1",
            reply_url: "https://github.com/x#e",
        })
        expect(r.round_resolved).toBe(true)
    })
})

describe("cc_schedule", () => {
    const sch = (args) => tools.cc_schedule({ task_id: id, ...args })

    test("prompt is required for prompt_agent and center_job", async () => {
        await expectError(
            sch({ at: "in 30m", action: "prompt_agent" }),
            "validation",
            400
        )
        await expectError(
            sch({ at: "in 30m", action: "center_job" }),
            "validation",
            400
        )
    })

    test("ISO time", async () => {
        const r = await sch({
            at: "2026-11-08T09:00:00+01:00",
            action: "prompt_agent",
            prompt: "re-check CI",
        })
        expect(deps.dateParser.parseWhen).not.toHaveBeenCalled()
        expect(deps.scheduler.add).toHaveBeenCalledWith({
            task_id: id,
            fire_at: "2026-11-08T08:00:00.000Z",
            action: "prompt_agent",
            payload: {
                prompt: "re-check CI",
                requested_by: `agent:${SESSION}`,
            },
            note: `requested by agent:${SESSION}`,
        })
        expect(r.ok).toBe(true)
        expect(r.schedule.id).toBe(5)
    })

    test("phrase, surface payloads", async () => {
        await sch({ at: "in 30m", action: "surface" })
        expect(deps.scheduler.add.mock.calls[0][0]).toMatchObject({
            fire_at: "2026-11-07T12:30:00.000Z",
            payload: { reason: "Agent follow-up" },
        })
        await sch({ at: "in 30m", action: "surface", prompt: "look\nat PR" })
        expect(deps.scheduler.add.mock.calls[1][0].payload.reason).toBe(
            "Follow-up: look at PR"
        )
    })

    test("center_job runs an assist ask", async () => {
        await sch({
            at: "in 30m",
            action: "center_job",
            prompt: "summarize PR changes",
        })
        expect(deps.scheduler.add.mock.calls[0][0].payload).toEqual({
            job_type: "assist",
            input: {
                intent: "ask",
                message: `Scheduled request from agent:${SESSION}: summarize PR changes`,
            },
            requested_by: `agent:${SESSION}`,
        })
    })

    test("unparseable time", async () => {
        await expectError(
            sch({ at: "whenever", action: "surface" }),
            "validation",
            400
        )
    })
})

describe("cc_create_task", () => {
    test("spin-off with an explicit parent", async () => {
        const r = await tools.cc_create_task(
            {
                title: "Clean up old retries",
                details: "found while fixing T-1",
                parent_id: id,
            },
            { callerTaskId: String(id) }
        )
        expect(r.ok).toBe(true)
        const { task } = await store.getTask(r.task.id)
        expect(task).toMatchObject({
            title: "Clean up old retries",
            status: "inbox",
            source: {
                type: "manual",
                text: "Clean up old retries\n\nfound while fixing T-1",
            },
        })
        expect(task.links[0]).toMatchObject({
            type: "doc",
            url: `/t/${id}`,
            label: `spun off from T-${id}`,
            added_by: `agent:${SESSION}`,
        })
        const events = await store.listEvents(id)
        expect(events[0]).toMatchObject({
            type: "spun_off",
            data: { task_id: r.task.id },
        })
    })

    test("parent defaults to the caller's task", async () => {
        const r = await tools.cc_create_task(
            { title: "Follow-up" },
            { callerTaskId: `T-${id}` }
        )
        const { task } = await store.getTask(r.task.id)
        expect(task.links[0].url).toBe(`/t/${id}`)
        expect(task.source.text).toBe("Follow-up")
    })

    test("no parent", async () => {
        const r = await tools.cc_create_task({ title: "Standalone" })
        const { task } = await store.getTask(r.task.id)
        expect(task.links).toEqual([])
        expect(task.links).toHaveLength(0)
    })

    test("parent mismatch and unknown parent", async () => {
        await expectError(
            tools.cc_create_task(
                { title: "x", parent_id: id },
                { callerTaskId: "999" }
            ),
            "wrong_task",
            403
        )
        await expectError(
            tools.cc_create_task({ title: "x", parent_id: 999 }),
            "not_found",
            404
        )
        await expectError(tools.cc_create_task({}), "validation", 400)
    })
})
