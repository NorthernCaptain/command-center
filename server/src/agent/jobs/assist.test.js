/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { createFakeStore, makeCtx, makeTask } from "../testing/fakes.js"
import job, { findThread } from "./assist.js"

async function setup(input, deps = {}) {
    const store = createFakeStore({ tasks: [makeTask({ id: 1 })] })
    const root = await store.appendComment(1, {
        op: "create",
        parent_id: null,
        anchor: {
            section: "Plan",
            exact: "Add backoff",
            prefix: "",
            suffix: "",
        },
        body: "make the plan concrete",
        intent: "change",
        author: "me",
        job_id: null,
    })
    const reply = await store.appendComment(1, {
        op: "create",
        parent_id: root.id,
        anchor: null,
        body: "ok",
        intent: "note",
        author: "center",
        job_id: null,
    })
    const ctx = makeCtx({
        store,
        deps,
        input: {
            comment_id: root.id,
            message: "make it concrete",
            intent: "change",
            ...input,
        },
    })
    return { store, ctx, root, reply }
}

const statusOf = async (store, id) =>
    (await store.listComments(1)).find((t) => t.id === id)

describe("assist", () => {
    test("prepare marks the thread working and finds it by a reply id", async () => {
        const { ctx, store, root, reply } = await setup({})
        const c2 = { ...ctx, input: { ...ctx.input, comment_id: reply.id } }
        const { context } = await job.prepare(c2)
        expect(context.rootId).toBe(root.id)
        expect(context.anchor.exact).toBe("Add backoff")
        expect((await statusOf(store, root.id)).status).toBe("working")
    })

    test("prompt shows artifact sections, anchor, thread and message", async () => {
        const { ctx } = await setup({})
        const { context } = await job.prepare(ctx)
        const { system, prompt, mcpServers } = job.buildPrompt(ctx, context)
        expect(system).toMatch(/Job: assist/)
        expect(prompt).toMatch(
            /Artifact sections \(use these exact names\): Summary, Context, Acceptance, Plan/
        )
        expect(prompt).toMatch(
            /Anchor in section "Plan":\n<<<BEGIN UNTRUSTED ANCHOR QUOTE>>>\nAdd backoff/
        )
        expect(prompt).toMatch(
            /\[me \/ change\] make the plan concrete\n\[center\] ok/
        )
        expect(prompt).toMatch(
            /Intent: change\nLeo's message:\nmake it concrete/
        )
        expect(mcpServers).toBeUndefined()
    })

    test("ask gets mcp servers; unknown intent is chat", async () => {
        const mcp = { "tracebot-mcp": { type: "http", url: "u" } }
        const { ctx } = await setup(
            { intent: "ask", comment_id: undefined },
            { mcpServers: mcp }
        )
        const { context } = await job.prepare(ctx)
        expect(context.rootId).toBeNull()
        const built = job.buildPrompt(ctx, context)
        expect(built.mcpServers).toBe(mcp)
        // exact read-only tools only, never the whole server
        expect(built.allowedTools).toEqual([
            "mcp__tracebot-mcp__brain_do",
            "mcp__tracebot-mcp__brain_job_result",
            "mcp__tracebot-mcp__wiki_search",
            "mcp__tracebot-mcp__wiki_read",
        ])
        expect(built.allowedTools).not.toContain("mcp__tracebot-mcp")
        const chat = { ...ctx, input: { message: "hi", intent: "weird" } }
        expect(job.buildPrompt(chat, context).prompt).toMatch(/Intent: chat/)
    })

    test("change: edits applied, reply posted on the root, thread resolved", async () => {
        const { ctx, store, root } = await setup({})
        const { context } = await job.prepare(ctx)
        const res = await job.apply(
            ctx,
            {
                reply: "Made the plan concrete.",
                edits: [
                    {
                        section: "## Plan",
                        op: "replace",
                        content: "## Plan\n1. Add backoff\n2. Test",
                    },
                    {
                        section: "Decisions",
                        op: "append",
                        content: "- use exponential backoff",
                    },
                ],
            },
            context
        )
        expect(res.summary).toBe("Updated Plan, Decisions")
        const { content } = await store.getArtifact(1)
        expect(content).toMatch(/## Plan\n1. Add backoff\n2. Test\n/)
        expect(content).toMatch(/## Decisions\n- use exponential backoff/)
        const thread = await statusOf(store, root.id)
        expect(thread).toMatchObject({
            status: "resolved",
            resolution: "center updated Plan, Decisions",
        })
        const posted = thread.replies.at(-1)
        expect(posted).toMatchObject({
            body: "Made the plan concrete.",
            intent: "note",
            author: "center",
            job_id: "j9",
            parent_id: root.id,
        })
    })

    test("ask: edits ignored, answer resolves", async () => {
        const { ctx, store, root } = await setup({ intent: "ask" })
        const { context } = await job.prepare(ctx)
        const before = (await store.getArtifact(1)).content
        const res = await job.apply(
            ctx,
            {
                reply: "42",
                edits: [{ section: "Plan", op: "replace", content: "x" }],
            },
            context
        )
        expect((await store.getArtifact(1)).content).toBe(before)
        expect(res.summary).toBe("Replied")
        expect(await statusOf(store, root.id)).toMatchObject({
            status: "resolved",
            resolution: "center answered",
        })
    })

    test("change with conflict on retry stays open and says so; reply posted once", async () => {
        const { ctx, store, root } = await setup({})
        const { context } = await job.prepare(ctx)
        const art = await store.getArtifact(1)
        await store.setArtifact(
            1,
            art.content.replace("## Plan\n", "## Plan\n\nhuman edit\n")
        )
        const out = {
            reply: "",
            edits: [
                { section: "Plan", op: "replace", content: "bot" },
                { section: "", op: "append", content: "x" },
            ],
        }
        await expect(job.apply(ctx, out, context)).rejects.toMatchObject({
            code: "stale_revision",
        })
        const res = await job.apply({ ...ctx, attempt: 2 }, out, context)
        expect(res.summary).toBe("No edits applied")
        const thread = await statusOf(store, root.id)
        expect(thread.status).toBe("open")
        const posted = thread.replies.filter((r) => r.job_id === "j9")
        expect(posted).toHaveLength(1)
        expect(posted[0].body).toMatch(
            /Not applied \(section changed meanwhile\): Plan/
        )
        expect(posted[0].body).toMatch(/Skipped invalid edit\(s\): \(empty\)/)
        expect((await store.getArtifact(1)).content).toMatch(/human edit/)
    })

    test("no comment id: top-level note, empty reply fallback text", async () => {
        const { ctx, store } = await setup({
            comment_id: undefined,
            intent: "chat",
        })
        const { context } = await job.prepare(ctx)
        await job.apply(ctx, { reply: "", edits: [] }, context)
        const threads = await store.listComments(1)
        expect(threads.at(-1)).toMatchObject({
            parent_id: null,
            body: "No change.",
            author: "center",
        })
        expect(
            store.calls.filter((c) => c[0] === "setCommentStatus")
        ).toHaveLength(0)
    })

    test("empty reply after applying edits says what changed", async () => {
        const { ctx, store, root } = await setup({ intent: "chat" })
        const { context } = await job.prepare(ctx)
        await job.apply(
            ctx,
            {
                reply: " ",
                edits: [{ section: "Summary", op: "replace", content: "s" }],
            },
            context
        )
        const thread = await statusOf(store, root.id)
        expect(thread.replies.at(-1).body).toBe("Updated Summary.")
        expect(thread.status).toBe("open")
    })

    test("prepare tolerates setCommentStatus failures", async () => {
        const { ctx, store } = await setup({ comment_id: "c_missing" })
        const { context } = await job.prepare(ctx)
        expect(context.rootId).toBe("c_missing")
        expect(store.calls.some((c) => c[0] === "setCommentStatus")).toBe(true)
    })

    test("onFailure reopens the thread", async () => {
        const { ctx, store, root, reply } = await setup({})
        await job.onFailure(
            { ...ctx, input: { ...ctx.input, comment_id: reply.id } },
            new Error("boom")
        )
        expect(await statusOf(store, root.id)).toMatchObject({
            status: "open",
            resolution: "center failed: boom",
        })
        await job.onFailure(ctx, null, { cancelled: true })
        expect((await statusOf(store, root.id)).resolution).toBe(
            "center cancelled"
        )
        await job.onFailure({ ...ctx, input: {} }, new Error("x"))
    })

    test("findThread", () => {
        expect(findThread([], null)).toBeNull()
        expect(findThread([{ id: "a" }], "zz")).toBeNull()
    })
})
