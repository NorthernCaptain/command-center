/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { createBus } from "../../events/bus.js"
import { createFakeClock } from "../../util/clock.js"
import { createJobRunner } from "../jobRunner.js"
import { createProviderRegistry } from "../providers/registry.js"
import {
    createFakeStore,
    createMemoryJobsRepo,
    fakeProvider,
    makeCtx,
    makeTask,
} from "../testing/fakes.js"
import { systemPrompt } from "../prompts.js"
import job, {
    baselineSnapshot,
    brainIdempotencyKey,
    areaHintLine,
    enrichRepos,
    filterRepos,
    guardedFields,
    inputBaseline,
} from "./enrich.js"

const systemPromptText = () => systemPrompt("enrich")

const REPOS = [
    { name: "aws-lambda", description: "lambdas" },
    { name: "infrastructure", description: "" },
]

const OUTPUT = {
    title: "Fix upload retry",
    area: "infra",
    kind: "agent_task",
    summary: "Uploads fail.",
    context_md: "Ron reported it.",
    acceptance: ["retries work", "- [ ] tests pass"],
    plan_md: "Add backoff.",
    repos: [
        { name: "AWS-Lambda", role: "main" },
        { name: "made-up", role: "ref" },
        { name: "aws-lambda", role: "ref" },
    ],
    branch_suggestion: "t1-fix-upload-retry",
    wants_asana: true,
    wants_agent: false,
    due_at: "2026-11-10T17:00:00Z",
}

function setup(taskOver = {}, depsOver = {}) {
    const store = createFakeStore({
        tasks: [
            makeTask({
                id: 1,
                flags: {
                    enriching: true,
                    now: true,
                    now_reason: "r",
                    error: null,
                },
                ...taskOver,
            }),
        ],
    })
    const deps = {
        brain: { start: jest.fn(async () => "brain-1"), result: jest.fn() },
        repoTable: { list: jest.fn(async () => REPOS) },
        asanaService: {
            getTask: jest.fn(async () => ({
                name: "A",
                notes: "N",
                permalink_url: "u",
                completed: false,
            })),
        },
        ...depsOver,
    }
    return { store, deps, ctx: makeCtx({ store, deps }) }
}

const slack = {
    source: {
        type: "slack",
        url: "https://acme.slack.com/archives/C1/p123",
        text: "see thread",
    },
}
const asana = {
    source: {
        type: "asana",
        url: "https://app.asana.com/0/111/222333444",
        text: null,
    },
}

describe("enrich", () => {
    test("slack source starts a brain job and parks", async () => {
        const { ctx, deps, store } = setup(slack)
        const res = await job.prepare(ctx)
        expect(res).toEqual({
            park: {
                kind: "brain",
                ref: "brain-1",
                snapshot: {
                    title: "Do the thing",
                    area: "other",
                    kind: "todo",
                },
                // the artifact baseline travels with the parked job
                artifact: await store.getArtifact(1),
            },
        })
        expect(deps.brain.start).toHaveBeenCalledWith({
            prompt: expect.stringContaining(
                "https://acme.slack.com/archives/C1/p123"
            ),
            title: "cc T-1 enrich",
            idempotencyKey: "cc-T1-enrich-j9",
        })
        expect(brainIdempotencyKey(5, "j_x")).toBe("cc-T5-enrich-j_x")
    })

    test("edits made while the job was queued are kept (baseline from enqueue)", async () => {
        const { ctx, store } = setup()
        const queued = await store.getArtifact(1)
        ctx.input = { baseline: queued }
        // Leo writes a plan before the job starts
        await store.setArtifact(
            1,
            queued.content.replace("## Plan\n", "## Plan\nmy own plan\n")
        )
        const { context } = await job.prepare(ctx)
        expect(context.artifact).toEqual(queued)
        await expect(job.apply(ctx, OUTPUT, context)).rejects.toThrow()
        const res = await job.apply({ ...ctx, attempt: 2 }, OUTPUT, context)
        const { content } = await store.getArtifact(1)
        expect(content).toContain("my own plan")
        expect(content).not.toContain("Add backoff.")
        expect(res.summary).toMatch(/kept your edits in Plan/)
    })

    test("a Slack job parks with the enqueue-time baseline", async () => {
        const { ctx, store } = setup(slack)
        const queued = await store.getArtifact(1)
        ctx.input = { baseline: queued }
        await store.setArtifact(1, queued.content + "\nlater edit\n")
        const { park } = await job.prepare(ctx)
        expect(park.artifact).toEqual(queued)
        expect(inputBaseline({ baseline: { content: 1 } })).toBeNull()
        expect(inputBaseline(null)).toBeNull()
        expect(inputBaseline({ baseline: { revision: "r" } })).toEqual({
            content: "",
            revision: "r",
        })
    })

    test("edits made while Brain works are kept (baseline from before parking)", async () => {
        const { ctx, deps, store } = setup(slack)
        const { park } = await job.prepare(ctx)
        // Leo writes a plan while the Slack thread is being fetched
        const art = await store.getArtifact(1)
        await store.setArtifact(
            1,
            art.content.replace("## Plan\n", "## Plan\nmy own plan\n")
        )
        deps.brain.result.mockResolvedValueOnce({
            status: "done",
            answer: "Ron: uploads fail",
        })
        const { context } = await job.resume(ctx, park)
        expect(context.artifact).toEqual(park.artifact)
        // attempt 1 is stale (the artifact moved on), the retry merges
        await expect(job.apply(ctx, OUTPUT, context)).rejects.toThrow()
        const res = await job.apply({ ...ctx, attempt: 2 }, OUTPUT, context)
        const { content } = await store.getArtifact(1)
        expect(content).toContain("my own plan")
        expect(content).not.toContain("Add backoff.")
        expect(content).toContain("Uploads fail.")
        expect(res.summary).toMatch(/kept your edits in Plan/)
    })

    test("slack without brain or with a brain error fails the job, task untouched", async () => {
        const a = setup(slack, { brain: null })
        await expect(job.prepare(a.ctx)).rejects.toMatchObject({
            code: "source_unavailable",
            message: expect.stringMatching(/Brain is not configured/),
        })
        const b = setup(slack, {
            brain: {
                start: async () => {
                    throw new Error(
                        "brain_do: principal 'leok' has no signed email"
                    )
                },
            },
        })
        const before = await b.store.getArtifact(1)
        const err = await job.prepare(b.ctx).catch((e) => e)
        expect(err.code).toBe("source_unavailable")
        expect(err.message).toMatch(
            /^Slack thread could not be fetched: brain_do: principal 'leok' has no signed email\. Task left unchanged/
        )
        // what the runner does next: onFailure clears enriching, sets error
        await job.onFailure(b.ctx, err)
        const { task } = await b.store.getTask(1)
        expect(task.flags).toMatchObject({ enriching: false })
        expect(task.flags.error).toMatch(/no signed email/)
        expect(task.title).toBe("Do the thing")
        expect(await b.store.getArtifact(1)).toEqual(before)
    })

    test("asana source fetches the task; failures become notes", async () => {
        const a = setup(asana)
        const { context } = await job.prepare(a.ctx)
        expect(a.deps.asanaService.getTask).toHaveBeenCalledWith("222333444")
        expect(context.asanaTask.name).toBe("A")
        const { prompt } = job.buildPrompt(a.ctx, context)
        expect(prompt).toMatch(/<<<BEGIN UNTRUSTED ASANA TASK>>>\nName: A/)

        const b = setup(asana, {
            asanaService: {
                getTask: async () => {
                    throw new Error("403")
                },
            },
        })
        await expect(job.prepare(b.ctx)).rejects.toMatchObject({
            code: "source_unavailable",
            message: expect.stringMatching(
                /Asana task could not be fetched: 403/
            ),
        })
        const c = setup({
            source: {
                type: "asana",
                url: "https://app.asana.com/x",
                text: null,
            },
        })
        await expect(job.prepare(c.ctx)).rejects.toThrow(
            /no task id in the link/
        )
        const empty = setup(asana, {
            asanaService: {
                getTask: async () => ({
                    gid: "222333444",
                    name: null,
                    notes: "",
                }),
            },
        })
        await expect(job.prepare(empty.ctx)).rejects.toThrow(
            /Asana returned an empty task/
        )
        const e = setup(asana, { asanaService: null })
        await expect(job.prepare(e.ctx)).rejects.toThrow(
            /Asana is not configured/
        )
        const d = setup(asana, {
            asanaService: null,
            asana: { getTask: async () => ({ name: "via asana" }) },
        })
        expect((await job.prepare(d.ctx)).context.asanaTask.name).toBe(
            "via asana"
        )
    })

    test("plain text: no fetch; repo table errors give empty repos", async () => {
        const a = setup(
            {},
            {
                repoTable: {
                    list: () => {
                        throw new Error("x")
                    },
                },
            }
        )
        const { context } = await job.prepare(a.ctx)
        expect(context.repos).toEqual([])
        const { prompt, system } = job.buildPrompt(a.ctx, context)
        expect(system).toMatch(/Job: enrich/)
        expect(prompt).toMatch(/no repo table available/)
        expect(prompt).toMatch(
            /Artifact sections \(use these exact names\): Summary, Context/
        )
        const b = setup({}, { repoTable: undefined })
        expect((await job.prepare(b.ctx)).context.repos).toEqual([])
    })

    test("resume: done / running / failed / errors / expired", async () => {
        const { ctx, deps } = setup(slack)
        deps.brain.result.mockResolvedValueOnce({
            status: "done",
            answer: "Ron: uploads fail",
        })
        const done = await job.resume(ctx, { kind: "brain", ref: "brain-1" })
        expect(deps.brain.result).toHaveBeenCalledWith("brain-1", {
            waitSeconds: 0,
        })
        expect(done.context.slackThread).toBe("Ron: uploads fail")
        const { prompt } = job.buildPrompt(ctx, done.context)
        expect(prompt).toMatch(
            /<<<BEGIN UNTRUSTED SLACK THREAD \(via Brain\)>>>\nRon: uploads fail/
        )
        expect(prompt).toMatch(/- aws-lambda: lambdas\n- infrastructure/)

        deps.brain.result.mockResolvedValueOnce({ status: "running" })
        expect(
            await job.resume(ctx, { kind: "brain", ref: "brain-1" })
        ).toEqual({
            park: {
                kind: "brain",
                ref: "brain-1",
                snapshot: null,
                artifact: null,
            },
        })
        deps.brain.result.mockResolvedValueOnce({ status: "running" })
        await expect(
            job.resume(ctx, { kind: "brain", ref: "b", expired: true })
        ).rejects.toThrow(/Brain timed out/)
        deps.brain.result.mockResolvedValueOnce({ status: "failed" })
        await expect(
            job.resume(ctx, { kind: "brain", ref: "b" })
        ).rejects.toThrow(
            /Slack thread could not be fetched: Brain job failed\./
        )
        deps.brain.result.mockResolvedValueOnce({
            status: "failed",
            error: "x".repeat(500),
        })
        const long = await job
            .resume(ctx, { kind: "brain", ref: "b" })
            .catch((e) => e)
        expect(long.message).toMatch(/Brain job failed \(x{300}\)/)
        deps.brain.result.mockResolvedValueOnce({
            status: "done",
            answer: "  ",
        })
        await expect(
            job.resume(ctx, { kind: "brain", ref: "b" })
        ).rejects.toThrow(/Brain returned nothing/)
        deps.brain.result.mockRejectedValueOnce(new Error("net"))
        const snap = { title: "T", area: "infra", kind: "todo" }
        expect(
            await job.resume(ctx, { kind: "brain", ref: "b", snapshot: snap })
        ).toEqual({
            park: { kind: "brain", ref: "b", snapshot: snap, artifact: null },
        })
        deps.brain.result.mockRejectedValueOnce(new Error("net"))
        await expect(
            job.resume(ctx, { kind: "brain", ref: "b", expired: true })
        ).rejects.toThrow(/Slack thread could not be fetched: net/)
    })

    test("apply writes sections and task metadata, filters repos, clears flags", async () => {
        const { ctx, store } = setup()
        const { context } = await job.prepare(ctx)
        const res = await job.apply(ctx, OUTPUT, context)
        const { task } = await store.getTask(1)
        expect(task).toMatchObject({
            title: "Fix upload retry",
            area: "infra",
            kind: "agent_task",
            repos: [{ name: "aws-lambda", role: "main" }],
            wants_asana: true,
            wants_agent: false,
            due_at: "2026-11-10T17:00:00.000Z",
            flags: {
                enriching: false,
                now: true,
                now_reason: "r",
                error: null,
            },
        })
        const { content } = await store.getArtifact(1)
        expect(content).toMatch(/## Summary\nUploads fail.\n/)
        expect(content).toMatch(
            /## Acceptance\n- \[ \] retries work\n- \[ \] tests pass\n/
        )
        expect(content).toMatch(
            /## Plan\nAdd backoff.\n\nSuggested branch: `t1-fix-upload-retry`/
        )
        expect(res.summary).toBe(
            "Enriched: Fix upload retry [infra/agent_task] (dropped 2 unknown repo(s))"
        )
    })

    test("apply keeps reminder kind, existing due and wants flags", async () => {
        const { ctx, store } = setup({
            kind: "reminder",
            due_at: "2026-11-09T00:00:00.000Z",
            wants_agent: true,
        })
        const { context } = await job.prepare(ctx)
        await job.apply(
            ctx,
            { ...OUTPUT, plan_md: "", branch_suggestion: null, repos: [] },
            context
        )
        const { task } = await store.getTask(1)
        expect(task).toMatchObject({
            kind: "reminder",
            due_at: "2026-11-09T00:00:00.000Z",
            wants_agent: true,
        })
    })

    test("stale retry keeps sections the user edited meanwhile", async () => {
        const { ctx, store } = setup()
        const { context } = await job.prepare(ctx)
        const art = await store.getArtifact(1)
        await store.setArtifact(
            1,
            art.content.replace("## Context\n", "## Context\n\nmy notes\n")
        )
        await expect(job.apply(ctx, OUTPUT, context)).rejects.toMatchObject({
            code: "stale_revision",
        })
        const res = await job.apply({ ...ctx, attempt: 2 }, OUTPUT, context)
        const { content } = await store.getArtifact(1)
        expect(content).toMatch(/## Context\n\nmy notes/)
        expect(content).toMatch(/## Summary\nUploads fail./)
        expect(res.summary).toMatch(/kept your edits in Context/)
    })

    test("area / kind chosen explicitly at capture are kept; auto fields are inferred", async () => {
        const { store, ctx } = setup({ area: "mobile", kind: "todo" })
        ctx.input = {
            snapshot: { title: "Do the thing", area: "mobile", kind: "todo" },
            pinned: ["area"],
        }
        const { context } = await job.prepare(ctx)
        const res = await job.apply(ctx, OUTPUT, context)
        const { task } = await store.getTask(1)
        expect(task.area).toBe("mobile") // chosen: kept
        expect(task.kind).toBe("agent_task") // auto: inferred
        expect(task.title).toBe("Fix upload retry")
        expect(res.summary).toMatch(/kept your area/)
        // unknown names in pinned are ignored
        expect(guardedFields(task, null, OUTPUT, ["bogus"]).patch.title).toBe(
            "Fix upload retry"
        )
    })

    describe("Create in Asana ticked at capture", () => {
        const runner = (pending = []) => ({
            list: jest.fn(() => pending),
            enqueue: jest.fn(() => ({ id: "j_asana" })),
        })
        const run = async (jobRunner, taskOver = {}) => {
            const { store, ctx } = setup(taskOver, { jobRunner })
            ctx.input = { create_asana: true }
            const { context } = await job.prepare(ctx)
            const res = await job.apply(ctx, OUTPUT, context)
            return { store, ctx, res }
        }

        test("starts asana_create after enriching", async () => {
            const jobRunner = runner()
            const { res } = await run(jobRunner)
            expect(jobRunner.enqueue).toHaveBeenCalledWith(
                "asana_create",
                {},
                { task_id: 1 }
            )
            expect(res.summary).toMatch(/Asana task requested/)
        })

        test("no duplicate while one is pending; none when already linked", async () => {
            const pending = runner([
                { id: "j0", type: "asana_create", status: "queued" },
            ])
            expect((await run(pending)).res.summary).toMatch(
                /Asana task requested/
            )
            expect(pending.enqueue).not.toHaveBeenCalled()
            const linked = runner()
            const { res } = await run(linked, {
                asana: { gid: "9", url: "u", attachments: [] },
            })
            expect(linked.enqueue).not.toHaveBeenCalled()
            expect(res.summary).not.toMatch(/Asana/)
        })

        test("the model's wants_asana alone never creates one", async () => {
            const jobRunner = runner()
            const { store, ctx } = setup({}, { jobRunner })
            const { context } = await job.prepare(ctx)
            await job.apply(ctx, { ...OUTPUT, wants_asana: true }, context)
            expect(jobRunner.enqueue).not.toHaveBeenCalled()
            expect((await store.getTask(1)).task.wants_asana).toBe(true)
        })

        test("a failed enrich still honours it; a cancelled one does not", async () => {
            const jobRunner = runner()
            const { ctx } = setup({}, { jobRunner })
            ctx.input = { create_asana: true }
            await job.onFailure(ctx, null, { cancelled: true })
            expect(jobRunner.enqueue).not.toHaveBeenCalled()
            await job.onFailure(ctx, new Error("provider down"))
            expect(jobRunner.enqueue).toHaveBeenCalledTimes(1)
        })

        test("a runner error is logged, not thrown", async () => {
            const warn = jest.fn()
            const jobRunner = {
                enqueue: () => {
                    throw new Error("db closed")
                },
            }
            const { ctx } = setup({}, { jobRunner })
            ctx.input = { create_asana: true }
            ctx.log = { ...ctx.log, warn }
            const { context } = await job.prepare(ctx)
            const res = await job.apply(ctx, OUTPUT, context)
            expect(res.summary).not.toMatch(/Asana/)
            expect(warn).toHaveBeenCalledWith(
                expect.objectContaining({ err: "db closed" }),
                "could not request the Asana task"
            )
            // without a runner at all nothing happens
            const none = setup({}, {})
            none.ctx.input = { create_asana: true }
            const c2 = (await job.prepare(none.ctx)).context
            expect((await job.apply(none.ctx, OUTPUT, c2)).summary).not.toMatch(
                /Asana/
            )
        })
    })

    test("onFailure clears enriching and records the error (not on cancel)", async () => {
        const { ctx, store } = setup()
        await job.onFailure(ctx, new Error("provider down"))
        expect((await store.getTask(1)).task.flags).toMatchObject({
            enriching: false,
            error: "Enrich failed: provider down",
            now: true,
        })
        await store.updateTask(1, {
            flags: {
                enriching: true,
                now: false,
                now_reason: null,
                error: null,
            },
        })
        await job.onFailure(ctx, null, { cancelled: true })
        expect((await store.getTask(1)).task.flags).toMatchObject({
            enriching: false,
            error: null,
        })
    })

    test("enrichRepos: keeps assigned repos, else the model's, else the area default", () => {
        const table = [...REPOS, { name: "aws-batch" }, { name: "web-trace" }]
        const mine = [{ name: "infrastructure", role: "main" }]
        expect(
            enrichRepos(
                { repos: mine },
                [{ name: "aws-lambda", role: "main" }],
                table,
                "batch"
            )
        ).toBe(mine)
        expect(
            enrichRepos(
                { repos: [] },
                [{ name: "AWS-Lambda", role: "main" }],
                table,
                "batch"
            )
        ).toEqual([{ name: "aws-lambda", role: "main" }])
        // the area's repo comes from config center.areaRepos
        const areaRepos = { batch: "aws-batch", web: "web-trace" }
        expect(enrichRepos({}, [], table, "batch", areaRepos)).toEqual([
            { name: "aws-batch", role: "main" },
        ])
        expect(enrichRepos({ repos: [] }, [], table, "web", areaRepos)).toEqual(
            [{ name: "web-trace", role: "main" }]
        )
        // no configured area repo, or it is not in the repo table
        expect(enrichRepos({ repos: [] }, [], table, "batch")).toEqual([])
        expect(
            enrichRepos({ repos: [] }, [], table, "infra", areaRepos)
        ).toEqual([])
        expect(
            enrichRepos({ repos: [] }, [], REPOS, "batch", areaRepos)
        ).toEqual([])
    })

    test("area hints line from config", () => {
        expect(
            areaHintLine({ batch: "aws-batch", web: "web-trace", x: "" })
        ).toBe(
            "Area hints (area -> its usual main repo): batch -> aws-batch, web -> web-trace"
        )
        expect(areaHintLine({})).toBe("")
        expect(areaHintLine(undefined)).toBe("")
    })

    test("the enrich prompt asks for a repo on every Slack / system task", () => {
        expect(systemPromptText()).toMatch(/ALWAYS assign at least one repo/)
        expect(systemPromptText()).toMatch(/captured from Slack/)
        expect(systemPromptText()).toMatch(
            /never plan a hand-off to a separate coding task/
        )
    })

    test("filterRepos handles junk input", () => {
        expect(filterRepos(null, null)).toEqual([])
        expect(filterRepos([{ name: null, role: "main" }], REPOS)).toEqual([])
    })

    test("end to end through the runner: park on brain, poll, finish", async () => {
        const clock = createFakeClock()
        const { store, deps } = setup(slack)
        deps.brain.result.mockResolvedValue({
            status: "done",
            answer: "thread text",
        })
        const provider = fakeProvider("claude-sdk", (args) => {
            expect(args.prompt).toMatch(/thread text/)
            return OUTPUT
        })
        const runner = createJobRunner({
            jobsRepo: createMemoryJobsRepo(),
            store,
            bus: createBus({ clock }),
            registry: createProviderRegistry({ providers: [provider] }),
            jobs: new Map([["enrich", job]]),
            clock,
            deps,
            pollMs: 0,
            idGen: () => "jE",
        })
        runner.start()
        runner.enqueue("enrich", {}, { task_id: 1 })
        await runner.idle()
        expect(runner.get("jE").status).toBe("parked")
        expect(deps.brain.start.mock.calls[0][0].idempotencyKey).toBe(
            "cc-T1-enrich-jE"
        )
        runner.poll()
        await runner.idle()
        expect(runner.get("jE")).toMatchObject({
            status: "done",
            model: "claude-haiku-5-5",
        })
        expect((await store.getTask(1)).task.flags.enriching).toBe(false)
    })

    test("Leo's title/area/kind edits made while enrich ran are kept", async () => {
        const { ctx, store, deps } = setup(slack)
        const parked = await job.prepare(ctx)
        // Leo renames and re-areas the task while Brain is working
        await store.updateTask(1, { title: "My title", area: "security" })
        deps.brain.result.mockResolvedValueOnce({
            status: "done",
            answer: "thread",
        })
        const { context } = await job.resume(ctx, {
            ...parked.park,
            parked_at: "x",
            expired: false,
        })
        const res = await job.apply(ctx, OUTPUT, context)
        const { task } = await store.getTask(1)
        expect(task).toMatchObject({
            title: "My title",
            area: "security",
            kind: "agent_task",
        })
        expect(res.summary).toMatch(/My title \[security\/agent_task\]/)
        expect(res.summary).toMatch(/kept your title, area/)
    })

    describe("reminders found by enrich", () => {
        const run = async (taskOver, out, withScheduler = true) => {
            const scheduler = { remind: jest.fn(async () => ({ id: 5 })) }
            const { store, ctx } = setup(
                { kind: "todo", status: "inbox", ...taskOver },
                withScheduler ? { scheduler } : {}
            )
            const { context } = await job.prepare(ctx)
            const res = await job.apply(ctx, { ...OUTPUT, ...out }, context)
            return {
                store,
                scheduler,
                res,
                task: (await store.getTask(1)).task,
            }
        }

        test("schedule the reminder and move the inbox task to waiting", async () => {
            const { scheduler, res, task } = await run({}, { kind: "reminder" })
            expect(scheduler.remind).toHaveBeenCalledWith(
                1,
                "2026-11-10T17:00:00.000Z"
            )
            expect(task).toMatchObject({
                kind: "reminder",
                status: "waiting",
                due_at: "2026-11-10T17:00:00.000Z",
            })
            expect(res.summary).toMatch(
                /reminder set for 2026-11-10T17:00:00.000Z/
            )
        })

        test("an existing due date is used; a status Leo set is kept", async () => {
            const { scheduler, task } = await run(
                { status: "active", due_at: "2026-11-12T09:00:00.000Z" },
                { kind: "reminder", due_at: null }
            )
            expect(scheduler.remind).toHaveBeenCalledWith(
                1,
                "2026-11-12T09:00:00.000Z"
            )
            expect(task.status).toBe("active")
        })

        test("no reminder without a future due date, a reminder kind or a scheduler", async () => {
            const past = await run(
                {},
                { kind: "reminder", due_at: "2020-01-01T00:00:00Z" }
            )
            expect(past.scheduler.remind).not.toHaveBeenCalled()
            expect(past.task.status).toBe("inbox")
            const todo = await run({}, { kind: "todo" })
            expect(todo.scheduler.remind).not.toHaveBeenCalled()
            const none = await run({}, { kind: "reminder" }, false)
            expect(none.task.status).toBe("inbox")
            expect(none.res.summary).not.toMatch(/reminder set/)
        })

        test("a kind Leo changed since capture wins", async () => {
            const scheduler = { remind: jest.fn() }
            const { store, ctx } = setup(
                { kind: "todo", status: "inbox" },
                { scheduler }
            )
            const { context } = await job.prepare(ctx)
            await store.updateTask(1, { kind: "agent_task" })
            await job.apply(ctx, { ...OUTPUT, kind: "reminder" }, context)
            const { task } = await store.getTask(1)
            expect(task.kind).toBe("agent_task")
            expect(task.status).toBe("inbox")
            expect(scheduler.remind).not.toHaveBeenCalled()
        })
    })

    describe("edits made while the job waited in the queue", () => {
        const ENQUEUED = "2026-11-07T11:00:00.000Z"
        const withJob = (ctx, input = {}) => ({
            ...ctx,
            input,
            job: { id: "j9", task_id: 1, type: "enrich", created_at: ENQUEUED },
        })
        const event = (at, changed, extra = {}) => ({
            at,
            actor: "me",
            type: "updated",
            data: { changed, ...extra },
        })

        test("input.snapshot is the baseline when present", async () => {
            const { ctx, store } = setup()
            // Leo renamed the task after capture, before enrich started
            await store.updateTask(1, { title: "Leo's title" })
            const c = withJob(ctx, {
                snapshot: {
                    title: "Do the thing",
                    area: "other",
                    kind: "todo",
                },
            })
            const { context } = await job.prepare(c)
            expect(context.snapshot).toEqual({
                title: "Do the thing",
                area: "other",
                kind: "todo",
            })
            const res = await job.apply(c, OUTPUT, context)
            const { task } = await store.getTask(1)
            expect(task).toMatchObject({
                title: "Leo's title",
                area: "infra",
                kind: "agent_task",
            })
            expect(res.summary).toMatch(/kept your title;/)
        })

        test("a partial or junk input.snapshot falls back per field", async () => {
            const { ctx, store } = setup()
            const task = (await store.getTask(1)).task
            expect(
                await baselineSnapshot(
                    withJob(ctx, { snapshot: { title: "T0", area: 5 } }),
                    task
                )
            ).toEqual({ title: "T0", area: "other", kind: "todo" })
            expect(
                await baselineSnapshot(withJob(ctx, { snapshot: "nope" }), task)
            ).toEqual({ title: "Do the thing", area: "other", kind: "todo" })
            expect(
                await baselineSnapshot(withJob(ctx, { snapshot: {} }), task)
            ).toEqual({ title: "Do the thing", area: "other", kind: "todo" })
        })

        test("without input.snapshot, fields changed since enqueue (events) are kept", async () => {
            const { ctx, store } = setup()
            await store.updateTask(1, {
                title: "Leo's title",
                area: "security",
            })
            store.state.get(1).events.push(
                {
                    at: "2026-11-07T10:00:00.000Z",
                    actor: "me",
                    type: "created",
                    data: { status: "inbox" },
                },
                event("2026-11-07T10:30:00.000Z", ["area"]), // before enqueue
                event("2026-11-07T11:30:00.000Z", ["title", "priority"]),
                event("2026-11-07T11:40:00.000Z", ["kind"], {
                    reason: "enrich",
                }),
                {
                    at: "2026-11-07T11:45:00.000Z",
                    actor: "me",
                    type: "comment",
                    data: {},
                },
                {
                    at: "2026-11-07T11:46:00.000Z",
                    actor: "me",
                    type: "updated",
                },
                event("2026-11-07T11:50:00.000Z", "junk")
            )
            const c = withJob(ctx)
            const { context } = await job.prepare(c)
            expect(context.snapshot).toEqual({
                title: null,
                area: "security",
                kind: "todo",
            })
            await job.apply(c, OUTPUT, context)
            expect((await store.getTask(1)).task).toMatchObject({
                title: "Leo's title",
                area: "infra",
                kind: "agent_task",
            })
        })

        test("the null baseline survives a Brain park (JSON round trip)", async () => {
            const { ctx, store } = setup(slack)
            store.state
                .get(1)
                .events.push(event("2026-11-07T11:30:00.000Z", ["kind"]))
            const parked = await job.prepare(withJob(ctx))
            const park = JSON.parse(JSON.stringify(parked.park))
            expect(park.snapshot.kind).toBeNull()
            const tk = (await store.getTask(1)).task
            expect(guardedFields(tk, park.snapshot, OUTPUT).kept).toEqual([
                "kind",
            ])
        })

        test("no event history: prepare-time values", async () => {
            const a = setup()
            a.store.listEvents = async () => {
                throw new Error("gone")
            }
            const task = (await a.store.getTask(1)).task
            const snap = { title: "Do the thing", area: "other", kind: "todo" }
            expect(await baselineSnapshot(withJob(a.ctx), task)).toEqual(snap)
            delete a.store.listEvents
            expect(await baselineSnapshot(withJob(a.ctx), task)).toEqual(snap)
            a.store.listEvents = async () => null
            expect(await baselineSnapshot(withJob(a.ctx), task)).toEqual(snap)
            // no job.created_at (legacy row): prepare-time values
            expect(await baselineSnapshot(a.ctx, task)).toEqual(snap)
        })

        test("through the runner: input.snapshot from enqueue protects a rename made in the queue", async () => {
            const clock = createFakeClock()
            const { store, deps } = setup()
            const runner = createJobRunner({
                jobsRepo: createMemoryJobsRepo(),
                store,
                bus: createBus({ clock }),
                registry: createProviderRegistry({
                    providers: [fakeProvider("claude-sdk", () => OUTPUT)],
                }),
                jobs: new Map([["enrich", job]]),
                clock,
                deps,
                pollMs: 0,
                idGen: () => "jQ",
            })
            runner.enqueue(
                "enrich",
                {
                    snapshot: {
                        title: "Do the thing",
                        area: "other",
                        kind: "todo",
                    },
                },
                { task_id: 1 }
            )
            await store.updateTask(1, { title: "Renamed in queue" })
            runner.start()
            await runner.idle()
            expect(runner.get("jQ").status).toBe("done")
            expect((await store.getTask(1)).task).toMatchObject({
                title: "Renamed in queue",
                area: "infra",
            })
        })
    })

    test("guardedFields", () => {
        const task = makeTask({ title: "A", area: "infra", kind: "bug" })
        const out = { ...OUTPUT, title: "  New  " }
        expect(guardedFields(task, null, out).patch).toEqual({
            title: "New",
            area: "infra",
            kind: "agent_task",
        })
        expect(
            guardedFields(
                task,
                { title: "A", area: "infra", kind: "todo" },
                out
            )
        ).toEqual({
            patch: { title: "New", area: "infra" },
            kept: ["kind"],
        })
        const rem = makeTask({ kind: "reminder" })
        expect(guardedFields(rem, null, out).patch.kind).toBeUndefined()
    })
})
