/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { createFakeStore, makeTask } from "./testing/fakes.js"
import {
    EV_LINK,
    EV_LINK_FAILED,
    brainKey,
    createThreadNotifier,
    slackReplyPrompt,
} from "./threadNotify.js"

const THREAD = "https://acme.slack.com/archives/C1/p123"
const ASANA = "https://app.asana.com/0/1/999"
const JOB = "j_0123456789abcdef01234567"

function setup(over = {}, brainImpl) {
    const store = createFakeStore({
        tasks: [
            makeTask({
                id: 1,
                source: { type: "slack", url: THREAD, text: THREAD },
                asana: {
                    gid: "999",
                    url: ASANA,
                    section_gid: null,
                    no_section: false,
                    attachments: [],
                },
                ...over,
            }),
        ],
    })
    const brain = { start: jest.fn(brainImpl || (async () => JOB)) }
    const log = { warn: jest.fn() }
    return {
        store,
        brain,
        log,
        notifier: createThreadNotifier({ store, brain, log }),
    }
}

const events = async (store, type) =>
    (await store.listEvents(1, { limit: 100 })).filter((e) => e.type === type)

describe("slackReplyPrompt / brainKey", () => {
    test("asks for one reply in the thread with the Asana link", () => {
        const p = slackReplyPrompt({ threadUrl: THREAD, asanaUrl: ASANA })
        expect(p).toContain(`Slack thread at ${THREAD}`)
        expect(p).toContain(`"Tracking this in Asana: ${ASANA}"`)
        expect(p).toMatch(/once, as a reply in that thread/)
        expect(brainKey(1, "999")).toBe("cc-T1-slack-asana-999")
    })
})

describe("threadNotifier.asanaCreated", () => {
    test("starts a Brain job once per Asana task and records it", async () => {
        const { notifier, brain, store } = setup()
        expect(await notifier.asanaCreated(1)).toEqual({
            posted: true,
            brain_job: JOB,
        })
        expect(brain.start).toHaveBeenCalledWith({
            prompt: slackReplyPrompt({ threadUrl: THREAD, asanaUrl: ASANA }),
            title: "cc T-1 Asana link to Slack",
            idempotencyKey: "cc-T1-slack-asana-999",
        })
        const ev = await events(store, EV_LINK)
        expect(ev).toHaveLength(1)
        expect(ev[0]).toMatchObject({
            data: { gid: "999", thread: THREAD, brain_job: JOB },
            actor: "center",
        })
        // again: nothing
        expect(await notifier.asanaCreated(1)).toEqual({
            skipped: "already_posted",
        })
        expect(brain.start).toHaveBeenCalledTimes(1)
    })

    test("skips without Brain, a Slack source or an Asana link", async () => {
        const noBrain = createThreadNotifier({
            store: setup().store,
            brain: null,
        })
        expect(await noBrain.asanaCreated(1)).toEqual({ skipped: "no_brain" })
        expect(
            await setup({
                source: { type: "manual", url: null },
            }).notifier.asanaCreated(1)
        ).toEqual({ skipped: "no_slack" })
        expect(
            await setup({
                source: { type: "slack", url: null },
            }).notifier.asanaCreated(1)
        ).toEqual({ skipped: "no_slack" })
        expect(
            await setup({ source: undefined }).notifier.asanaCreated(1)
        ).toEqual({
            skipped: "no_slack",
        })
        expect(
            await setup({
                asana: { gid: null, url: null, attachments: [] },
            }).notifier.asanaCreated(1)
        ).toEqual({ skipped: "no_asana" })
        expect(
            await setup({
                asana: { gid: "999", url: null, attachments: [] },
            }).notifier.asanaCreated(1)
        ).toEqual({ skipped: "no_asana" })
    })

    test("a Brain failure is recorded and logged, not thrown", async () => {
        const { notifier, store, log } = setup({}, async () => {
            throw new Error("brain_do failed: down")
        })
        expect(await notifier.asanaCreated(1)).toEqual({
            posted: false,
            error: "brain_do failed: down",
        })
        expect(log.warn).toHaveBeenCalled()
        expect(await events(store, EV_LINK_FAILED)).toHaveLength(1)
        expect(await events(store, EV_LINK)).toHaveLength(0)
    })

    test("even recording the failure may fail quietly", async () => {
        const { notifier, store } = setup({}, async () => {
            throw new Error("x")
        })
        store.appendEvent = async () => {
            throw new Error("disk")
        }
        expect(await notifier.asanaCreated(1)).toMatchObject({ posted: false })
    })

    test("a store without events still posts", async () => {
        const { notifier, store } = setup()
        store.listEvents = async () => null
        expect(await notifier.asanaCreated(1)).toMatchObject({ posted: true })
    })
})
