/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { createFakeStore, makeCtx, makeTask } from "../testing/fakes.js"
import { jest } from "@jest/globals"
import job, {
    asksAgent,
    chatHistory,
    findThread,
    linkType,
    urlsIn,
} from "./assist.js"

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

// like the runner: apply (under the lock), then afterApply
async function run(ctx, out, context) {
    const full = { title: null, message_agent: false, ...out }
    const r = await job.apply(ctx, full, context)
    return (await job.afterApply(ctx, full, context)) || r
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
        const res = await run(
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
        expect(res.summary).toBe("Made the plan concrete.")
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
        const res = await run(
            ctx,
            {
                reply: "42",
                edits: [{ section: "Plan", op: "replace", content: "x" }],
            },
            context
        )
        expect((await store.getArtifact(1)).content).toBe(before)
        expect(res.summary).toBe("42")
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
        await expect(
            job.apply(
                ctx,
                { ...out, title: null, message_agent: false },
                context
            )
        ).rejects.toMatchObject({
            code: "stale_revision",
        })
        const res = await run({ ...ctx, attempt: 2 }, out, context)
        expect(res.summary).toMatch(
            /^Not applied \(section changed meanwhile\)/
        )
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
        await run(ctx, { reply: "", edits: [] }, context)
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
        await run(
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

describe("assist: rename and messages to the herdr agent", () => {
    const workers = (over = {}) => ({
        agentState: jest.fn(async () => ({ state: "idle" })),
        send: jest.fn(async () => ({ ok: true, delivery: { status: "sent" } })),
        ...over,
    })
    const out = (over = {}) => ({
        reply: "Passing it on.",
        edits: [],
        title: null,
        message_agent: true,
        ...over,
    })

    test("asksAgent: only an instruction to the agent in Leo's words", () => {
        for (const yes of [
            "Tell the herdr agent to create a pr",
            "please ask the agent to rebase",
            "have codex fix the tests",
            "Agent: create the PR",
            "@claude, rerun CI",
            "tell the task's agent to stop",
        ])
            expect(asksAgent(yes)).toBe(true)
        for (const no of [
            "What did the agent find?",
            "Do not message the agent",
            "don't tell the agent yet",
            "create a PR",
            "summarize the agent's findings",
            "tell me what the agent did",
            undefined,
        ])
            expect(asksAgent(no)).toBe(false)
    })

    test("Leo's message goes to the agent verbatim, once; reply says so", async () => {
        const w = workers()
        const { ctx, store, root } = await setup(
            { intent: "chat", message: "Tell the herdr agent to create a pr" },
            { workers: w }
        )
        const { context } = await job.prepare(ctx)
        const res = await run(ctx, out(), context)
        expect(w.send).toHaveBeenCalledWith(
            1,
            "From Leo via the task chat: Tell the herdr agent to create a pr"
        )
        expect(res.summary).toBe("Passing it on.\n\n→ Sent to the herdr agent.")
        const thread = await statusOf(store, root.id)
        expect(thread.replies.at(-1).body).toBe(res.summary)
        // the longest message that fits the worker's limit with the prefix
        // goes whole; one character more is refused, never truncated
        const fits = `tell the agent ${"x".repeat(19972 - 15)}`
        const big = await setup(
            { intent: "chat", message: fits },
            { workers: w }
        )
        const bc = await job.prepare(big.ctx)
        await run(big.ctx, out(), bc.context)
        expect(w.send.mock.calls.at(-1)[1]).toHaveLength(20000)
        w.send.mockClear()
        const over = await setup(
            { intent: "chat", message: `${fits}y` },
            { workers: w }
        )
        const oc = await job.prepare(over.ctx)
        expect((await run(over.ctx, out(), oc.context)).summary).toMatch(
            /too long to pass on \(19973 characters, at most 19972\)/
        )
        expect(w.send).not.toHaveBeenCalled()
        // a second afterApply (retry) does not send again
        await job.afterApply(ctx, out(), context)
        expect(w.send).not.toHaveBeenCalled()
    })

    test("each delivery outcome is reported", async () => {
        const cases = [
            [{ status: "queued" }, /Queued for the herdr agent \(it is busy/],
            [{ status: "blocked" }, /waiting for your answer in herdr/],
            [
                { status: "failed", error: "pane gone" },
                /Not delivered to the agent \(failed\): pane gone; it is in the agent's queue/,
            ],
            [undefined, /Not delivered to the agent \(unknown\)/],
        ]
        for (const [delivery, re] of cases) {
            const w = workers({ send: jest.fn(async () => ({ delivery })) })
            const { ctx } = await setup(
                { intent: "chat", message: "ask the agent to check CI" },
                { workers: w }
            )
            const { context } = await job.prepare(ctx)
            expect((await run(ctx, out(), context)).summary).toMatch(re)
        }
    })

    test("not sent: not an instruction (hostile artifact), no agent, workers off, send throws", async () => {
        const go = async (input, deps, o = out()) => {
            const { ctx } = await setup(input, deps)
            const { context } = await job.prepare(ctx)
            return (await run(ctx, o, context)).summary
        }
        const w = workers()
        // the model asks to message (e.g. steered by the artifact), but
        // Leo's words are a question: nothing is sent
        expect(
            await go(
                { intent: "chat", message: "What did the agent find?" },
                { workers: w }
            )
        ).toMatch(
            /Not sent to the agent: start your message with "tell the agent/
        )
        expect(w.send).not.toHaveBeenCalled()
        // the model says no: no line at all
        expect(
            await go(
                { intent: "chat", message: "tell the agent to stop" },
                { workers: w },
                out({ message_agent: false })
            )
        ).toBe("Passing it on.")
        expect(w.send).not.toHaveBeenCalled()
        const none = workers({ agentState: jest.fn(async () => null) })
        expect(
            await go(
                { intent: "chat", message: "tell the agent" },
                { workers: none }
            )
        ).toMatch(/T-1 has no agent yet \(press Start\)/)
        expect(
            await go({ intent: "chat", message: "tell the agent" }, {})
        ).toMatch(/herdr workers are off/)
        const boom = workers({
            send: jest.fn(async () => {
                throw new Error("task_closed")
            }),
        })
        expect(
            await go(
                { intent: "change", message: "tell the agent" },
                { workers: boom }
            )
        ).toMatch(/Not sent to the agent: task_closed/)
        const ask = workers()
        expect(
            await go(
                { intent: "ask", message: "tell the agent" },
                { workers: ask }
            )
        ).toBe("Passing it on.")
        expect(ask.send).not.toHaveBeenCalled()
    })

    test("rename: applied once, counts as a clean change; same title or failure", async () => {
        const { ctx, store, root } = await setup({
            intent: "change",
            message: "rename it",
        })
        const { context } = await job.prepare(ctx)
        const o = out({
            reply: "",
            title: "  Wasabi   cost answers ",
            message_agent: false,
        })
        const res = await run(ctx, o, context)
        expect((await store.getTask(1)).task.title).toBe("Wasabi cost answers")
        expect(res.summary).toBe('Renamed the task to "Wasabi cost answers".')
        expect((await statusOf(store, root.id)).status).toBe("resolved")
        // a retried apply does not rename again
        store.updateTask = jest.fn()
        await job.apply(ctx, o, context)
        expect(store.updateTask).not.toHaveBeenCalled()

        const same = await setup({ intent: "chat" })
        const c2 = await job.prepare(same.ctx)
        const t = (await same.store.getTask(1)).task.title
        const r2 = await run(
            same.ctx,
            out({ reply: "ok", title: t, message_agent: false }),
            c2.context
        )
        expect(r2.summary).toBe("ok")

        const bad = await setup({ intent: "chat" })
        const c3 = await job.prepare(bad.ctx)
        bad.store.updateTask = async () => {
            throw new Error("disk")
        }
        const r3 = await run(
            bad.ctx,
            out({ reply: "ok", title: "New", message_agent: false }),
            c3.context
        )
        expect(r3.summary).toBe("ok\n\nTitle not changed: disk")
    })
})

describe("assist: chat history", () => {
    const chat = (store, body) =>
        store.appendComment(1, {
            op: "create",
            parent_id: null,
            anchor: null,
            body,
            intent: "chat",
            author: "me",
            job_id: null,
        })
    const answer = (store, parent, body) =>
        store.appendComment(1, {
            op: "create",
            parent_id: parent.id,
            anchor: null,
            body,
            intent: "note",
            author: "center",
            job_id: null,
        })

    test("a chat prompt carries the earlier chat exchanges, oldest first", async () => {
        const { store, ctx } = await setup({})
        const first = await chat(store, "The repo is aws-lambda")
        await answer(store, first, "Noted. Say update the artifact.")
        const second = await chat(store, "Add my note to the task")
        await answer(store, second, "Which note?")
        const current = await chat(store, "update the artifact")
        // a later message is not history for this one
        await chat(store, "later")
        const c = {
            ...ctx,
            input: {
                comment_id: current.id,
                message: "update the artifact",
                intent: "chat",
            },
        }
        const { context } = await job.prepare(c)
        expect(context.history).toBe(
            "[me] The repo is aws-lambda\n[center] Noted. Say update the artifact.\n\n[me] Add my note to the task\n[center] Which note?"
        )
        const { prompt, system } = job.buildPrompt(c, context)
        expect(prompt).toMatch(
            /Earlier messages in this task's chat, oldest first:\n<<<BEGIN UNTRUSTED CHAT HISTORY>>>\n\[me\] The repo is aws-lambda/
        )
        // the anchored change thread is not chat history
        expect(context.history).not.toMatch(/make the plan concrete/)
        expect(system).toMatch(/Never ask him to repeat/)
    })

    test("comment intents (change / ask) get no chat history", async () => {
        const { store, ctx } = await setup({})
        await chat(store, "earlier chat")
        const { context } = await job.prepare(ctx)
        expect(context.history).toBe("")
        expect(job.buildPrompt(ctx, context).prompt).not.toMatch(/CHAT HISTORY/)
    })

    test("chatHistory keeps the last exchanges and the newest text", () => {
        const t = (id, body, replies = []) => ({
            id,
            parent_id: null,
            intent: "chat",
            author: "me",
            body,
            replies,
        })
        const many = Array.from({ length: 12 }, (_, i) => t(`c${i}`, `m${i}`))
        // unknown current id: everything is earlier
        const h = chatHistory(many, "nope").split("\n\n")
        expect(h).toHaveLength(8)
        expect(h[0]).toBe("[me] m4")
        expect(h.at(-1)).toBe("[me] m11")
        expect(chatHistory(null, "x")).toBe("")
        // long messages are clipped; past the size budget only the newest stay
        const big = "x".repeat(5000)
        const long = chatHistory(
            [
                t("a", big),
                t("b", big),
                t("c", big),
                t("d", big),
                t("e", "last"),
            ],
            "e"
        ).split("\n\n")
        expect(long[0]).toBe(`[me] ${"x".repeat(3000)}…`)
        expect(long).toHaveLength(3)
        // a single oversize exchange is still kept
        expect(
            chatHistory([t("a", big, [{ author: "center", body: big }])], "z")
        ).toMatch(/^\[me\] x+…\n\[center\] x+…$/)
    })
})

describe("assist: links", () => {
    const SLACK = "https://acme.slack.com/archives/C1/p17"
    async function chatSetup(message) {
        const { store, ctx } = await setup({})
        const root = await store.appendComment(1, {
            op: "create",
            parent_id: null,
            anchor: null,
            body: message,
            intent: "chat",
            author: "me",
            job_id: null,
        })
        const c = {
            ...ctx,
            input: { comment_id: root.id, message, intent: "chat" },
        }
        const { context } = await job.prepare(c)
        return { store, ctx: c, context, root }
    }

    test("adds a link from Leo's message as a task link", async () => {
        const { store, ctx, context, root } = await chatSetup(
            `add this slack ${SLACK} as related (bugs found after testing)`
        )
        const res = await run(
            ctx,
            {
                reply: "Added.",
                edits: [
                    // the rendered section is never edited as text
                    { section: "## Links", op: "append", content: SLACK },
                ],
                links: [
                    { url: SLACK, label: "Slack: bugs found after testing" },
                    { url: SLACK, label: "dup" },
                    { url: " ", label: "empty" },
                ],
            },
            context
        )
        const { task } = await store.getTask(1)
        expect(task.links).toEqual([
            expect.objectContaining({
                type: "slack",
                url: SLACK,
                label: "Slack: bugs found after testing",
                role: null,
                added_by: "center",
            }),
        ])
        expect(task.links[0].id).toMatch(/^l_/)
        expect((await store.getArtifact(1)).content).not.toContain(SLACK)
        expect(res.summary).toBe(
            "Added.\n\nNot edited: the Links and PR feedback sections are filled from the task.\n\nAdded link: Slack: bugs found after testing."
        )
        expect((await statusOf(store, root.id)).status).toBe("resolved")

        // again: same URL updates the label, adds nothing
        const { context: c2 } = await job.prepare(ctx)
        const res2 = await run(
            ctx,
            {
                reply: "ok",
                edits: [],
                links: [
                    { url: SLACK, label: "Bugs" },
                    { url: SLACK, label: "" },
                ],
            },
            c2
        )
        const links = (await store.getTask(1)).task.links
        expect(links.map((l) => l.label)).toEqual(["Bugs"])
        expect(res2.summary).toBe("ok")
    })

    test("a URL Leo did not write is refused; earlier comments count", async () => {
        const { store, ctx, context } = await chatSetup("add the doc I sent")
        // a URL from his own earlier comment is fine (prepare reads them)
        await store.appendComment(1, {
            op: "create",
            parent_id: null,
            anchor: null,
            body: "doc: https://docs.google.com/d/1",
            intent: "note",
            author: "me",
            job_id: null,
        })
        const { context: fresh } = await job.prepare(ctx)
        const res = await run(
            ctx,
            {
                reply: "",
                edits: [],
                links: [
                    { url: "https://docs.google.com/d/1", label: "" },
                    { url: "https://evil.example.com/x", label: "x" },
                ],
            },
            fresh
        )
        expect(res.summary).toBe(
            "Not added as a link (only links from your messages): https://evil.example.com/x\n\nAdded link: https://docs.google.com/d/1."
        )
        const links = (await store.getTask(1)).task.links
        expect(links.map((l) => [l.type, l.label])).toEqual([["doc", null]])
        // nothing allowed at all -> no task update
        const calls = store.calls.filter((c) => c[0] === "updateTask").length
        await run(
            ctx,
            {
                reply: "no",
                edits: [],
                links: [{ url: "https://x.example.com/a", label: "" }],
            },
            context
        )
        expect(store.calls.filter((c) => c[0] === "updateTask")).toHaveLength(
            calls
        )
    })

    test("a store error is reported in the reply; ask never adds links", async () => {
        const { store, ctx, context } = await chatSetup(`add ${SLACK}`)
        store.updateTask = async () => {
            throw new Error("disk full")
        }
        const res = await run(
            ctx,
            { reply: "", edits: [], links: [{ url: SLACK, label: "s" }] },
            context
        )
        expect(res.summary).toBe("Links not added: disk full")

        const ask = await chatSetup(`what is ${SLACK}?`)
        const askCtx = {
            ...ask.ctx,
            input: { ...ask.ctx.input, intent: "ask" },
        }
        await run(
            askCtx,
            {
                reply: "a thread",
                edits: [],
                links: [{ url: SLACK, label: "s" }],
            },
            ask.context
        )
        expect((await ask.store.getTask(1)).task.links || []).toEqual([])
    })

    test("linkType and urlsIn", () => {
        expect(linkType(SLACK)).toBe("slack")
        expect(linkType("https://app.asana.com/0/1/2")).toBe("asana")
        expect(linkType("https://github.com/acme/api/pull/3")).toBe("pr")
        expect(linkType("https://github.com/acme/api/tree/t1-x")).toBe("branch")
        expect(linkType("https://acme.notion.so/page")).toBe("doc")
        expect(linkType("https://example.com")).toBe("other")
        expect(
            urlsIn("see https://a.example.com/x, and (https://b.example.com).")
        ).toEqual(["https://a.example.com/x", "https://b.example.com"])
        expect(urlsIn(null)).toEqual([])
    })
})
