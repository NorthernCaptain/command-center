/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { createFakeStore, makeCtx, makeTask } from "../testing/fakes.js"
import job from "./parse_quick.js"

function setup(task = {}, deps = {}) {
    const store = createFakeStore({ tasks: [makeTask({ id: 1, ...task })] })
    const scheduler = { remind: jest.fn() }
    const ctx = makeCtx({
        store,
        deps: { scheduler, timezone: "America/Los_Angeles", ...deps },
        input: { text: "ping ron re 123 after lunch tmrw" },
    })
    return { store, scheduler, ctx }
}

describe("parse_quick", () => {
    test("module shape", () => {
        expect(job).toMatchObject({
            type: "parse_quick",
            lane: "interactive",
            weight: "light",
            lock: true,
        })
    })

    test("prompt quotes the capture as untrusted data with the current time", async () => {
        const { ctx } = setup()
        const { context } = await job.prepare(ctx)
        const { system, prompt } = job.buildPrompt(ctx, context)
        expect(system).toMatch(/parse_quick/)
        expect(prompt).toMatch(
            /<<<BEGIN UNTRUSTED CAPTURE>>>\nping ron re 123 after lunch tmrw\n<<<END UNTRUSTED CAPTURE>>>/
        )
        expect(prompt).toMatch(/Current time: 2026-11-07T12:00:00.000Z/)
        expect(prompt).toMatch(/America\/Los_Angeles/)
        const noText = { ...ctx, input: {} }
        expect(job.buildPrompt(noText, context).prompt).toMatch(/do the thing/)
    })

    test("reminder with future due -> waiting + reminder scheduled", async () => {
        const { ctx, store, scheduler } = setup()
        const res = await job.apply(ctx, {
            kind: "reminder",
            title: " Ping Ron about 123 ",
            due_at: "2026-11-08T13:00:00-08:00",
        })
        const { task } = await store.getTask(1)
        expect(task).toMatchObject({
            kind: "reminder",
            title: "Ping Ron about 123",
            status: "waiting",
            due_at: "2026-11-08T21:00:00.000Z",
        })
        expect(scheduler.remind).toHaveBeenCalledWith(
            1,
            "2026-11-08T21:00:00.000Z"
        )
        expect(res.summary).toBe(
            "reminder: Ping Ron about 123 (due 2026-11-08T21:00:00.000Z, reminder set)"
        )
    })

    test("past or invalid due is ignored; no scheduler is fine", async () => {
        const { ctx, store, scheduler } = setup()
        await job.apply(ctx, {
            kind: "reminder",
            title: "x",
            due_at: "2026-11-01T10:00:00Z",
        })
        expect((await store.getTask(1)).task).toMatchObject({
            status: "inbox",
            due_at: null,
        })
        expect(scheduler.remind).not.toHaveBeenCalled()
        const ctx2 = { ...ctx, deps: {} }
        const res = await job.apply(ctx2, {
            kind: "todo",
            title: "y",
            due_at: "garbage",
        })
        expect(res.summary).toBe("todo: y")
    })

    test("already waiting task keeps status; due without remind support", async () => {
        const { ctx, store } = setup({ status: "waiting" })
        const ctx2 = { ...ctx, deps: { scheduler: {} } }
        const res = await job.apply(ctx2, {
            kind: "reminder",
            title: "z",
            due_at: "2026-11-09T09:00:00Z",
        })
        expect(
            store.calls.find((c) => c[0] === "updateTask")[2]
        ).not.toHaveProperty("status")
        expect(res.summary).toBe("reminder: z (due 2026-11-09T09:00:00.000Z)")
    })
})

describe("parse_quick snapshot guard", () => {
    test("keeps a title/kind Leo changed after capture", async () => {
        const { ctx, store } = setup({ title: "Leo renamed", kind: "todo" })
        ctx.input = {
            text: "remind me ...",
            snapshot: { title: "remind me ...", area: "other", kind: "todo" },
        }
        const res = await job.apply(ctx, {
            kind: "reminder",
            title: "Model title",
            due_at: "2026-11-08T13:00:00-08:00",
        })
        const { task } = await store.getTask(1)
        expect(task.title).toBe("Leo renamed")
        expect(task.kind).toBe("reminder")
        expect(task.status).toBe("waiting")
        expect(res.summary).toMatch(/^reminder: Leo renamed/)
    })

    test("keeps the kind too when Leo changed it", async () => {
        const { ctx, store } = setup({ title: "same", kind: "agent_task" })
        ctx.input = {
            text: "same",
            snapshot: { title: "same", area: "other", kind: "todo" },
        }
        await job.apply(ctx, { kind: "reminder", title: "New", due_at: null })
        const { task } = await store.getTask(1)
        expect(task).toMatchObject({ title: "New", kind: "agent_task" })
        expect(task.status).not.toBe("waiting")
    })
})

describe("parse_quick keeps due date and status Leo changed", () => {
    const OUT = {
        kind: "reminder",
        title: "Ping Ron",
        due_at: "2026-11-09T09:00:00Z",
    }
    const snapshot = {
        title: "remind me ping ron",
        area: "other",
        kind: "reminder",
        due_at: null,
        status: "inbox",
    }

    test("edited due_at and status win; no reminder for the parsed date", async () => {
        const { ctx, store, scheduler } = setup({
            title: "remind me ping ron",
            kind: "reminder",
            status: "active",
            due_at: "2026-11-20T09:00:00.000Z",
        })
        ctx.input = { text: "remind me ping ron", snapshot }
        const res = await job.apply(ctx, OUT)
        const { task } = await store.getTask(1)
        expect(task).toMatchObject({
            title: "Ping Ron",
            status: "active",
            due_at: "2026-11-20T09:00:00.000Z",
        })
        expect(scheduler.remind).not.toHaveBeenCalled()
        expect(res.summary).toMatch(/kept yours/)
    })

    test("only the status changed: due date applies and is scheduled, status kept", async () => {
        const { ctx, store, scheduler } = setup({
            title: "remind me ping ron",
            kind: "reminder",
            status: "active",
        })
        ctx.input = { text: "x", snapshot }
        await job.apply(ctx, OUT)
        const { task } = await store.getTask(1)
        expect(task.status).toBe("active")
        expect(task.due_at).toBe("2026-11-09T09:00:00.000Z")
        expect(scheduler.remind).toHaveBeenCalledWith(
            1,
            "2026-11-09T09:00:00.000Z"
        )
    })

    test("untouched task: due date, waiting and the reminder all apply", async () => {
        const { ctx, store, scheduler } = setup({
            title: "remind me ping ron",
            kind: "reminder",
            status: "inbox",
        })
        ctx.input = { text: "x", snapshot }
        await job.apply(ctx, OUT)
        const { task } = await store.getTask(1)
        expect(task).toMatchObject({
            status: "waiting",
            due_at: "2026-11-09T09:00:00.000Z",
        })
        expect(scheduler.remind).toHaveBeenCalledTimes(1)
    })
})
