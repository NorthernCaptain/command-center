/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { createFakeStore, makeCtx, makeTask } from "../testing/fakes.js"
import job, { listIntents } from "./asana_create.js"

const PROSE = { summary: "S", context: "C", acceptance: ["a"], approach: "A" }

function setup(taskOver = {}, created = {}) {
    const store = createFakeStore({ tasks: [makeTask({ id: 1, ...taskOver })] })
    const asanaService = {
        createForTask: jest.fn(async () => ({
            gid: "999",
            url: "https://app.asana.com/0/1/999",
            section_gid: "s1",
            no_section: false,
            attachments: ["http://cc/t/1"],
            ...created,
        })),
    }
    return {
        store,
        asanaService,
        ctx: makeCtx({ store, deps: { asanaService } }),
    }
}

describe("asana_create", () => {
    test("module shape", () => {
        expect(job).toMatchObject({
            type: "asana_create",
            lane: "background",
            weight: "heavy",
            lock: true,
        })
    })

    test("prepare requires the service and no existing Asana task", async () => {
        const a = setup()
        await expect(job.prepare({ ...a.ctx, deps: {} })).rejects.toMatchObject(
            { code: "asana_unavailable" }
        )
        const b = setup({
            asana: {
                gid: "1",
                url: "u",
                section_gid: null,
                no_section: false,
                attachments: [],
            },
        })
        await expect(job.prepare(b.ctx)).rejects.toMatchObject({
            code: "already_exists",
        })
        const { context } = await job.prepare(a.ctx)
        const { system, prompt } = job.buildPrompt(a.ctx, context)
        expect(system).toMatch(/Job: asana_create/)
        expect(prompt).toMatch(/Title: "Do the thing"/)
        expect(prompt).toMatch(/<<<BEGIN UNTRUSTED ARTIFACT>>>/)
    })

    test("apply creates once, records asana, link, wants_asana and event", async () => {
        const { ctx, store, asanaService } = setup()
        const context = {}
        const res = await job.apply(ctx, PROSE, context)
        expect(asanaService.createForTask).toHaveBeenCalledWith(
            expect.objectContaining({ id: 1 }),
            PROSE,
            {
                marker: expect.stringMatching(
                    /^Command-Center-Task: T-1 [0-9a-f]{12}$/
                ),
                priorMarkers: [],
                since: "2026-11-07T11:50:00.000Z",
            }
        )
        const { task } = await store.getTask(1)
        expect(task.asana).toEqual({
            gid: "999",
            url: "https://app.asana.com/0/1/999",
            section_gid: "s1",
            no_section: false,
            attachments: ["http://cc/t/1"],
            synced_gid: "999",
        })
        expect(task.wants_asana).toBe(true)
        expect(task.links).toEqual([
            expect.objectContaining({
                type: "asana",
                url: "https://app.asana.com/0/1/999",
                label: "Asana",
                added_by: "center",
            }),
        ])
        expect(store.state.get(1).events).toEqual([
            expect.objectContaining({
                type: "asana_create_intent",
                data: {
                    nonce: expect.stringMatching(/^[0-9a-f]{12}$/),
                    at: "2026-11-07T12:00:00.000Z",
                },
            }),
            expect.objectContaining({
                type: "asana_created",
                data: {
                    gid: "999",
                    url: "https://app.asana.com/0/1/999",
                    no_section: false,
                    adopted: false,
                },
            }),
        ])
        expect(res.summary).toBe(
            "Asana task created: https://app.asana.com/0/1/999"
        )

        // retry of apply (e.g. after stale) reuses the created task
        await job.apply({ ...ctx, attempt: 2 }, PROSE, context)
        expect(asanaService.createForTask).toHaveBeenCalledTimes(1)
        expect((await store.getTask(1)).task.links).toHaveLength(1)
        expect(store.state.get(1).events).toHaveLength(2)
    })

    test("no section and no url", async () => {
        const { ctx, store } = setup(
            {},
            {
                no_section: true,
                url: null,
                section_gid: undefined,
                attachments: undefined,
            }
        )
        const res = await job.apply(ctx, PROSE, {})
        expect(res.summary).toBe(
            "Asana task created (no sprint section this week): 999"
        )
        const { task } = await store.getTask(1)
        expect(task.asana).toMatchObject({
            url: null,
            section_gid: null,
            no_section: true,
            attachments: [],
        })
        expect(task.links).toEqual([])
    })

    test("apply refuses when an Asana task appeared meanwhile", async () => {
        const { ctx, store } = setup()
        await store.updateTask(1, {
            asana: {
                gid: "5",
                url: null,
                section_gid: null,
                no_section: false,
                attachments: [],
            },
        })
        await expect(job.apply(ctx, PROSE, {})).rejects.toThrow(
            /already has an Asana task: 5/
        )
    })

    test("a retry after a failed/timed-out POST passes the earlier marker so the service can adopt", async () => {
        const { ctx, store, asanaService } = setup({}, { adopted: true })
        asanaService.createForTask.mockRejectedValueOnce(
            new Error("Asana request failed: timeout")
        )
        await expect(job.apply(ctx, PROSE, {})).rejects.toThrow(/timeout/)
        const first = asanaService.createForTask.mock.calls[0][2]

        // new job, 30 minutes later
        const later = {
            ...ctx,
            clock: { now: () => new Date("2026-11-07T12:30:00.000Z") },
        }
        const res = await job.apply(later, PROSE, {})
        const second = asanaService.createForTask.mock.calls[1][2]
        expect(second.priorMarkers).toEqual([first.marker])
        expect(second.marker).not.toBe(first.marker)
        expect(second.since).toBe("2026-11-07T11:50:00.000Z")
        expect(res.summary).toBe(
            "Asana task adopted (created by an earlier attempt): https://app.asana.com/0/1/999"
        )
        expect((await store.getTask(1)).task.asana.gid).toBe("999")
        const intents = await listIntents({ store, task_id: 1 })
        expect(intents.map((i) => i.at)).toEqual([
            "2026-11-07T12:00:00.000Z",
            "2026-11-07T12:30:00.000Z",
        ])
    })

    test("listIntents tolerates stores without events and bad records", async () => {
        expect(await listIntents({ store: {}, task_id: 1 })).toEqual([])
        const store = createFakeStore({ tasks: [makeTask({ id: 1 })] })
        await store.appendEvent(1, { type: "asana_create_intent", data: {} })
        await store.appendEvent(1, {
            type: "asana_create_intent",
            data: { nonce: "abc" },
        })
        const out = await listIntents({ store, task_id: 1 })
        expect(out).toEqual([{ nonce: "abc", at: expect.any(String) }])
    })
})

describe("asana_create -> Slack thread", () => {
    test("apply asks the notifier once, outside the task lock", async () => {
        const { store, asanaService } = setup()
        const threadNotifier = {
            asanaCreated: jest.fn(async () => ({ posted: true })),
        }
        const outside = jest.fn((fn) => fn())
        store.outsideLocks = outside
        const ctx = makeCtx({ store, deps: { asanaService, threadNotifier } })
        const context = {}
        await job.apply(ctx, PROSE, context)
        expect(outside).toHaveBeenCalledTimes(1)
        expect(threadNotifier.asanaCreated).toHaveBeenCalledWith(1)
        // a stale-revision retry of apply does not ask again
        await job.apply({ ...ctx, attempt: 2 }, PROSE, context)
        expect(threadNotifier.asanaCreated).toHaveBeenCalledTimes(1)
    })

    test("notifier errors are logged; without outsideLocks it runs directly", async () => {
        const { store, asanaService } = setup()
        delete store.outsideLocks
        const warn = jest.fn()
        const threadNotifier = {
            asanaCreated: jest.fn(async () => {
                throw new Error("boom")
            }),
        }
        const ctx = {
            ...makeCtx({ store, deps: { asanaService, threadNotifier } }),
            log: { warn },
        }
        await job.apply(ctx, PROSE, {})
        await new Promise((r) => setImmediate(r))
        expect(threadNotifier.asanaCreated).toHaveBeenCalledWith(1)
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ err: "boom" }),
            "slack thread notify failed"
        )
    })
})
