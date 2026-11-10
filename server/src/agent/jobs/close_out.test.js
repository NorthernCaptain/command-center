/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { createFakeStore, makeCtx, makeTask } from "../testing/fakes.js"
import job, {
    enqueueCloseOut,
    hasResult,
    openDeliverables,
} from "./close_out.js"

const ASANA = {
    gid: "777",
    url: "u",
    section_gid: null,
    no_section: false,
    attachments: [],
}
const CONCLUSION = {
    outcome: "Shipped the retry fix.",
    points: ["Fix in https://github.com/acme/api/pull/12"],
    open_items: [],
}
const OUT = { result_md: "Shipped PR #12.", asana_conclusion: CONCLUSION }
const NO_CONCLUSION = { outcome: " ", points: [], open_items: [] }

function setup(taskOver = {}, deps) {
    const store = createFakeStore({
        tasks: [makeTask({ id: 1, status: "active", ...taskOver })],
    })
    const asanaService = {
        comment: jest.fn(),
        commentHtml: jest.fn(),
        complete: jest.fn(),
        getTask: jest.fn(async () => ({ completed: false })),
    }
    return {
        store,
        asanaService,
        ctx: makeCtx({
            store,
            deps: deps === undefined ? { asanaService } : deps,
        }),
    }
}

describe("close_out", () => {
    test("prompt", async () => {
        const { ctx } = setup()
        const { context } = await job.prepare(ctx)
        const { system, prompt } = job.buildPrompt(ctx, context)
        expect(system).toMatch(/Job: close_out/)
        expect(prompt).toMatch(/T-1 \| status: active/)
    })

    test("writes Result, comments + completes Asana once, sets done", async () => {
        const { ctx, store, asanaService } = setup({ asana: ASANA })
        const { context } = await job.prepare(ctx)
        const res = await job.apply(ctx, OUT, context)
        expect((await store.getArtifact(1)).content).toMatch(
            /## Result\nShipped PR #12.\n/
        )
        expect(asanaService.commentHtml).toHaveBeenCalledWith(
            "777",
            '<body><strong>Done</strong>\nShipped the retry fix.\n\n<strong>Details</strong>\n<ul><li>Fix in <a href="https://github.com/acme/api/pull/12">https://github.com/acme/api/pull/12</a></li></ul></body>'
        )
        expect(asanaService.comment).not.toHaveBeenCalled()
        expect(asanaService.complete).toHaveBeenCalledWith("777")
        expect((await store.getTask(1)).task.status).toBe("done")
        expect(res.summary).toBe("Closed out (Asana completed)")
        await job.apply({ ...ctx, attempt: 2 }, OUT, context)
        expect(asanaService.commentHtml).toHaveBeenCalledTimes(1)
        expect(asanaService.complete).toHaveBeenCalledTimes(1)
    })

    test("empty comment skips the comment but completes", async () => {
        const { ctx, asanaService } = setup({ asana: ASANA })
        const { context } = await job.prepare(ctx)
        await job.apply(
            ctx,
            { ...OUT, asana_conclusion: NO_CONCLUSION },
            context
        )
        expect(asanaService.comment).not.toHaveBeenCalled()
        expect(asanaService.commentHtml).not.toHaveBeenCalled()
        expect(asanaService.complete).toHaveBeenCalled()
    })

    test("gid without service, no gid, illegal transition, already done", async () => {
        const a = setup({ asana: ASANA }, {})
        const ca = (await job.prepare(a.ctx)).context
        expect((await job.apply(a.ctx, OUT, ca)).summary).toBe(
            "Closed out (Asana not configured; task not completed there)"
        )

        const b = setup({ status: "cancelled" })
        await expect(job.prepare(b.ctx)).rejects.toMatchObject({
            code: "invalid_state",
            message: "T-1 is cancelled and cannot move to done",
        })

        const c = setup({ status: "done" })
        const cc = (await job.prepare(c.ctx)).context
        expect((await job.apply(c.ctx, OUT, cc)).summary).toBe("Closed out")
        expect(c.store.calls.filter((x) => x[0] === "updateTask")).toHaveLength(
            0
        )
    })

    test("a written Result is kept; the conclusion is based on it", async () => {
        const { ctx, store, asanaService } = setup({ asana: ASANA })
        const art = await store.getArtifact(1)
        await store.setArtifact(
            1,
            art.content.replace(
                /## Result\n[^#]*/,
                "## Result\n<!-- filled by close_out -->\nRoot cause: radio off.\n"
            )
        )
        const { context } = await job.prepare(ctx)
        expect(context.keepResult).toBe(true)
        expect(job.buildPrompt(ctx, context).prompt).toMatch(
            /Result section is already written: keep it/
        )
        const res = await job.apply(
            ctx,
            { ...OUT, result_md: "a rewrite" },
            context
        )
        const content = (await store.getArtifact(1)).content
        expect(content).toMatch(/Root cause: radio off\./)
        expect(content).not.toMatch(/a rewrite/)
        expect(asanaService.commentHtml).toHaveBeenCalledTimes(1)
        expect(res.summary).toBe(
            "Closed out (kept the written Result; Asana completed)"
        )
    })

    test("an empty Result needs result_md", async () => {
        const { ctx, store, asanaService } = setup({ asana: ASANA })
        const { context } = await job.prepare(ctx)
        expect(context.keepResult).toBe(false)
        expect(job.buildPrompt(ctx, context).prompt).toMatch(
            /Result section is empty: write result_md/
        )
        await expect(
            job.apply(ctx, { ...OUT, result_md: "  " }, context)
        ).rejects.toMatchObject({ code: "invalid_output" })
        expect(asanaService.commentHtml).not.toHaveBeenCalled()
        expect((await store.getTask(1)).task.status).toBe("active")
    })

    test("hasResult", () => {
        expect(
            hasResult("# x\n\n## Result\n<!-- filled by close_out -->\n")
        ).toBe(false)
        expect(hasResult("# x\n\n## Summary\nok\n")).toBe(false)
        expect(hasResult(null)).toBe(false)
        expect(hasResult("# x\n\n## Result\nShipped.\n")).toBe(true)
    })

    test("Result edited meanwhile is kept on retry", async () => {
        const { ctx, store } = setup()
        const { context } = await job.prepare(ctx)
        const art = await store.getArtifact(1)
        await store.setArtifact(
            1,
            art.content.replace("## Result\n", "## Result\n\nmine\n")
        )
        await expect(job.apply(ctx, OUT, context)).rejects.toMatchObject({
            code: "stale_revision",
        })
        const res = await job.apply({ ...ctx, attempt: 2 }, OUT, context)
        expect(res.summary).toBe(
            "Closed out (Result section changed meanwhile, kept yours)"
        )
        expect((await store.getArtifact(1)).content).toMatch(
            /## Result\n\nmine/
        )
    })

    const dl = (over) => ({
        repo: "aws-lambda",
        branch: "t1-x",
        role: "work",
        created_at: "2026-11-01T00:00:00.000Z",
        disposition: "pr",
        pr: "https://github.com/acme/aws-lambda/pull/1",
        claimed_at: null,
        merged_at: null,
        ...over,
    })

    test("open deliverables block close-out before any Asana side effect", async () => {
        const { ctx, asanaService, store } = setup({
            asana: ASANA,
            deliverables: [
                dl({ merged_at: "2026-11-05T00:00:00.000Z" }),
                dl({ repo: "infra", disposition: "no_change", pr: null }),
                dl({ repo: "web", branch: "t1-web" }),
            ],
        })
        await expect(job.prepare(ctx)).rejects.toMatchObject({
            code: "deliverables_open",
            message: expect.stringContaining("web@t1-web"),
        })
        expect(openDeliverables((await store.getTask(1)).task)).toHaveLength(1)
        expect(asanaService.comment).not.toHaveBeenCalled()
        expect(asanaService.complete).not.toHaveBeenCalled()
    })

    test("an unmerged PR is re-checked on GitHub first: merged meanwhile -> closes", async () => {
        const store0 = createFakeStore({
            tasks: [
                makeTask({
                    id: 1,
                    status: "pr_open",
                    asana: ASANA,
                    deliverables: [dl({})],
                }),
            ],
        })
        const prWatcher = {
            pollTask: jest.fn(async (id) => {
                // the watcher finds the merge and records it
                const { task } = await store0.getTask(id)
                await store0.updateTask(id, {
                    deliverables: task.deliverables.map((d) => ({
                        ...d,
                        merged_at: "2026-11-07T11:00:00.000Z",
                    })),
                })
                return { errors: [] }
            }),
        }
        const ctx = makeCtx({ store: store0, deps: { prWatcher } })
        const { context } = await job.prepare(ctx)
        expect(prWatcher.pollTask).toHaveBeenCalledWith(1)
        expect(context.task.deliverables[0].merged_at).toBeTruthy()
    })

    test("PR still open on GitHub -> blocked, naming the PR", async () => {
        const warn = jest.fn()
        const prWatcher = {
            pollTask: jest.fn(async () => ({ errors: ["gh: rate limited"] })),
        }
        const { ctx } = setup(
            { status: "pr_open", deliverables: [dl({})] },
            { prWatcher }
        )
        ctx.log.warn = warn
        await expect(job.prepare(ctx)).rejects.toMatchObject({
            code: "deliverables_open",
            message: expect.stringContaining(
                "aws-lambda@t1-x (https://github.com/acme/aws-lambda/pull/1 is not merged)"
            ),
        })
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ err: "gh: rate limited" }),
            "close_out: PR re-check incomplete"
        )
    })

    test("a failing re-check is logged and the recorded state decides", async () => {
        const warn = jest.fn()
        const prWatcher = {
            pollTask: jest.fn(async () => {
                throw new Error("boom")
            }),
        }
        const { ctx } = setup(
            { status: "pr_open", deliverables: [dl({})] },
            { prWatcher }
        )
        ctx.log.warn = warn
        await expect(job.prepare(ctx)).rejects.toMatchObject({
            code: "deliverables_open",
        })
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ err: "boom" }),
            "close_out: PR re-check failed"
        )
        // poll summary with a top-level error
        prWatcher.pollTask.mockResolvedValueOnce({ error: "no task" })
        await expect(job.prepare(ctx)).rejects.toMatchObject({
            code: "deliverables_open",
        })
        expect(warn).toHaveBeenLastCalledWith(
            expect.objectContaining({ err: "no task" }),
            "close_out: PR re-check incomplete"
        )
    })

    test("no re-check without an unmerged PR (or without the watcher)", async () => {
        const prWatcher = { pollTask: jest.fn(async () => ({})) }
        const merged = setup(
            {
                deliverables: [
                    dl({ merged_at: "2026-11-05T00:00:00.000Z" }),
                    dl({ repo: "web", disposition: "pending", pr: null }),
                ],
            },
            { prWatcher }
        )
        await expect(job.prepare(merged.ctx)).rejects.toMatchObject({
            code: "deliverables_open",
            message: expect.not.stringContaining("is not merged"),
        })
        expect(prWatcher.pollTask).not.toHaveBeenCalled()
        const none = setup({ deliverables: [dl({})] }, { prWatcher: {} })
        await expect(job.prepare(none.ctx)).rejects.toMatchObject({
            code: "deliverables_open",
        })
    })

    test("state re-checked in apply: changed meanwhile -> no side effects", async () => {
        const { ctx, asanaService, store } = setup({ asana: ASANA })
        const { context } = await job.prepare(ctx)
        await store.updateTask(1, { status: "cancelled" })
        await expect(job.apply(ctx, OUT, context)).rejects.toMatchObject({
            code: "invalid_state",
        })
        expect(asanaService.comment).not.toHaveBeenCalled()
        expect(asanaService.complete).not.toHaveBeenCalled()
        expect((await store.getArtifact(1)).content).not.toMatch(/Shipped/)
    })

    test("a new job after a partial run does not re-comment or re-complete", async () => {
        const { ctx, asanaService, store } = setup({ asana: ASANA })
        // first run: comment posted, then complete fails
        asanaService.complete.mockRejectedValueOnce(new Error("asana 500"))
        const c1 = (await job.prepare(ctx)).context
        await expect(job.apply(ctx, OUT, c1)).rejects.toThrow(/asana 500/)
        expect(asanaService.commentHtml).toHaveBeenCalledTimes(1)
        const events = (await store.listEvents(1)).map((e) => e.type)
        expect(events).toContain("asana_close_commented")
        expect(events).not.toContain("asana_completed")

        // retry (fresh context): no second comment, completes now
        const c2 = (await job.prepare(ctx)).context
        await job.apply(ctx, OUT, c2)
        expect(asanaService.commentHtml).toHaveBeenCalledTimes(1)
        expect(asanaService.complete).toHaveBeenCalledTimes(2) // 1 failed + 1
        expect((await store.listEvents(1)).map((e) => e.type)).toContain(
            "asana_completed"
        )
        expect((await store.getTask(1)).task.status).toBe("done")
    })

    test("already completed in Asana -> complete is not called again", async () => {
        const { ctx, asanaService } = setup({ asana: ASANA })
        asanaService.getTask.mockResolvedValueOnce({ completed: true })
        const { context } = await job.prepare(ctx)
        await job.apply(
            ctx,
            { ...OUT, asana_conclusion: NO_CONCLUSION },
            context
        )
        expect(asanaService.complete).not.toHaveBeenCalled()
    })

    test("works with a store without listEvents and a service without getTask", async () => {
        const { ctx, store } = setup({ asana: ASANA })
        const svc = { comment: jest.fn(), complete: jest.fn() }
        const bare = { ...store, listEvents: undefined }
        const c = { ...ctx, store: bare, deps: { asanaService: svc } }
        const { context } = await job.prepare(c)
        await job.apply(c, OUT, context)
        // no rich-text support: the plain version
        expect(svc.comment).toHaveBeenCalledWith(
            "777",
            "Done\nShipped the retry fix.\n\nDetails\n- Fix in https://github.com/acme/api/pull/12"
        )
        expect(svc.complete).toHaveBeenCalledTimes(1)
    })
})

describe("enqueueCloseOut", () => {
    test("enqueues when nothing is pending", () => {
        const runner = {
            list: jest.fn(() => []),
            enqueue: jest.fn(() => ({ id: "j1" })),
        }
        expect(enqueueCloseOut(runner, 4)).toEqual({
            job: { id: "j1" },
            existing: false,
        })
        expect(runner.enqueue).toHaveBeenCalledWith(
            "close_out",
            {},
            {
                task_id: 4,
            }
        )
    })
    test("returns the pending close_out", () => {
        const pending = { id: "j0", type: "close_out", status: "parked" }
        const runner = { list: () => [pending], enqueue: jest.fn() }
        expect(enqueueCloseOut(runner, 4)).toEqual({
            job: pending,
            existing: true,
        })
        expect(runner.enqueue).not.toHaveBeenCalled()
    })
    test("works without list and fails without a runner", () => {
        const runner = { enqueue: () => ({ id: "j2" }) }
        expect(enqueueCloseOut(runner, 4).job).toEqual({ id: "j2" })
        expect(() => enqueueCloseOut(null, 4)).toThrow(/runner unavailable/)
        expect(() => enqueueCloseOut({}, 4)).toThrow(/runner unavailable/)
    })

    test("SOC2 areas need a complete change record (prepare and apply)", async () => {
        const { ctx, store } = setup({ area: "infra" })
        await store.setArtifact(
            1,
            "# T-1 — x\n\n## Change record (SOC2)\n- What: rotate keys\n- Why:\n- Risk: TBD\n"
        )
        await expect(job.prepare(ctx)).rejects.toMatchObject({
            code: "change_record_missing",
            status: 409,
            details: { missing: ["why", "risk", "rollback", "tested"] },
        })

        const full =
            "# T-1 — x\n\n## Change record (SOC2)\n- What: rotate keys\n" +
            "- Why: audit\n- Risk: low\n- Rollback: old key\n- Tested: staging\n"
        await store.setArtifact(1, full)
        const { context } = await job.prepare(ctx)
        // emptied while the LLM ran: apply re-checks before any side effect
        await store.setArtifact(1, "# T-1 — x\n")
        await expect(job.apply(ctx, OUT, context)).rejects.toMatchObject({
            code: "change_record_missing",
        })
        expect((await store.getTask(1)).task.status).toBe("active")
        await store.setArtifact(1, full)
        await job.apply(ctx, OUT, context)
        expect((await store.getTask(1)).task.status).toBe("done")
    })
})
