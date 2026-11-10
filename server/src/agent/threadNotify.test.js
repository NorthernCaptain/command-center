/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { createFakeStore, makeTask } from "./testing/fakes.js"
import {
    EV_LINK,
    EV_LINK_FAILED,
    EV_MISSING,
    EV_RESULT,
    NOTICE_REASON,
    brainKey,
    createThreadNotifier,
    mountThreadNotice,
    noticeState,
    noticeTaskExtras,
    slackReplyPrompt,
    verdictOf,
} from "./threadNotify.js"

const THREAD = "https://acme.slack.com/archives/C1/p123"
const ASANA = "https://app.asana.com/0/1/999"
const JOB = "j_0123456789abcdef01234567"
const JOB2 = "j_0123456789abcdef01234568"

const POSTED = { status: "done", answer: "Posted it.\nRESULT: POSTED" }
const REFUSED = {
    status: "done",
    answer: "I couldn't post it: the tool adds a mention. Nothing was posted.",
}

function setup(over = {}, { start, results } = {}) {
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
    const queue = [...(results || [POSTED])]
    const brain = {
        start: jest.fn(start || (async () => JOB)),
        result: jest.fn(async () =>
            queue.length > 1 ? queue.shift() : queue[0]
        ),
    }
    const log = { warn: jest.fn(), info: jest.fn() }
    const sleep = jest.fn(async () => {})
    return {
        store,
        brain,
        log,
        sleep,
        notifier: createThreadNotifier({
            store,
            brain,
            log,
            sleep,
            watchPolls: 5,
        }),
    }
}

const events = async (store, type) =>
    (await store.listEvents(1, { limit: 100 })).filter((e) => e.type === type)
const flags = async (store) => (await store.getTask(1)).task.flags
// what the real store records when Leo changes the flags
async function clearByLeo(store) {
    await store.updateTask(1, { flags: { now: false, now_reason: null } })
    await store.appendEvent(
        1,
        { type: "updated", data: { changed: ["flags"] } },
        "me"
    )
}

describe("prompt, key, verdict", () => {
    test("asks for one reply in the thread and a verdict line", () => {
        const p = slackReplyPrompt({ threadUrl: THREAD, asanaUrl: ASANA })
        expect(p).toContain(`Slack thread at ${THREAD}`)
        expect(p).toContain(`"Tracking this in Asana: ${ASANA}"`)
        expect(p).toMatch(/once, as a reply in that thread/)
        // a required mention is fine (T-14: Brain refused over "no mentions")
        expect(p).toMatch(/address the person who started the thread/)
        expect(p).not.toMatch(/no other messages, reactions or mentions/)
        expect(p).toMatch(/RESULT: POSTED, or RESULT: NOT POSTED/)
        expect(brainKey(1, "999")).toBe("cc-T1-slack-asana-999")
        expect(brainKey(1, "999", 2)).toBe("cc-T1-slack-asana-999-2")
    })

    test("verdictOf", () => {
        expect(verdictOf("done.\nRESULT: POSTED")).toBe("posted")
        expect(verdictOf("RESULT: NOT POSTED - no access")).toBe("not_posted")
        expect(verdictOf("result: not_posted")).toBe("not_posted")
        // the last RESULT line decides; a quoted earlier one does not
        expect(
            verdictOf(
                "I cannot report RESULT: POSTED.\nRESULT: NOT POSTED - no access"
            )
        ).toBe("not_posted")
        expect(verdictOf("RESULT: NOT POSTED\nok\nRESULT: POSTED")).toBe(
            "posted"
        )
        expect(verdictOf("RESULT: POSTED, I think")).toBe("unknown")
        expect(verdictOf(REFUSED.answer)).toBe("not_posted")
        expect(verdictOf("I was unable to post in that channel")).toBe(
            "not_posted"
        )
        // without the RESULT line prose is never success
        expect(
            verdictOf("Posted the exact text once as a reply in the thread.")
        ).toBe("unknown")
        expect(
            verdictOf("The message will be posted once access is restored")
        ).toBe("unknown")
        expect(verdictOf("Hmm.")).toBe("unknown")
        // negations in prose never read as posted
        expect(verdictOf("No message was posted.")).toBe("not_posted")
        expect(verdictOf("The reply was never posted")).toBe("not_posted")
        expect(verdictOf("I won't be posting that")).toBe("not_posted")
        expect(verdictOf("Done, nothing else to do")).toBe("unknown")
        expect(verdictOf("Sent the message.")).toBe("unknown")
        expect(verdictOf(null)).toBe("unknown")
    })
})

describe("asanaCreated: start, follow the Brain job, record the outcome", () => {
    test("posted: started once, result recorded, no flag", async () => {
        const { notifier, brain, store, log } = setup(
            {},
            { results: [{ status: "running" }, POSTED] }
        )
        expect(await notifier.asanaCreated(1)).toEqual({
            started: true,
            brain_job: JOB,
        })
        expect(brain.start).toHaveBeenCalledWith({
            prompt: slackReplyPrompt({ threadUrl: THREAD, asanaUrl: ASANA }),
            title: "cc T-1 Asana link to Slack",
            idempotencyKey: "cc-T1-slack-asana-999",
        })
        await notifier.settled()
        expect(brain.result).toHaveBeenCalledWith(JOB, { waitSeconds: 30 })
        const [start] = await events(store, EV_LINK)
        expect(start).toMatchObject({
            data: { gid: "999", thread: THREAD, brain_job: JOB, attempt: 1 },
            actor: "center",
        })
        const [res] = await events(store, EV_RESULT)
        expect(res.data).toEqual({
            gid: "999",
            brain_job: JOB,
            status: "posted",
            answer: POSTED.answer,
        })
        expect(log.info).toHaveBeenCalledWith(
            { task_id: 1, brain_job: JOB, status: "posted" },
            "slack thread: Asana link posted"
        )
        expect((await flags(store)).now).toBe(false)
        // again: nothing
        expect(await notifier.asanaCreated(1)).toEqual({
            skipped: "already_started",
        })
        expect(brain.start).toHaveBeenCalledTimes(1)
    })

    test("Brain answered without posting: recorded, Now flag raised", async () => {
        const { notifier, store, log } = setup({}, { results: [REFUSED] })
        await notifier.asanaCreated(1)
        await notifier.settled()
        const [res] = await events(store, EV_RESULT)
        expect(res.data.status).toBe("not_posted")
        expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ status: "not_posted" }),
            "slack thread: Asana link not posted"
        )
        expect(await flags(store)).toMatchObject({
            now: true,
            now_reason: NOTICE_REASON,
        })
        const state = await notifier.state(1, (await store.getTask(1)).task)
        expect(state).toMatchObject({
            status: "not_posted",
            attempts: 1,
            brain_job: JOB,
            answer: REFUSED.answer,
        })
    })

    test("a failed Brain job, a long answer, a kept other Now flag", async () => {
        const { notifier, store } = setup(
            { flags: { now: true, now_reason: "PR feedback" } },
            {
                results: [
                    {
                        status: "failed",
                        answer: "x".repeat(2000),
                        error: "boom",
                    },
                ],
            }
        )
        await notifier.asanaCreated(1)
        await notifier.settled()
        const [res] = await events(store, EV_RESULT)
        expect(res.data).toMatchObject({ status: "failed", error: "boom" })
        expect(res.data.answer).toHaveLength(1000)
        expect((await flags(store)).now_reason).toBe("PR feedback")
    })

    test("Brain result errors: retried, then still pending (no new try)", async () => {
        const { notifier, store, brain, sleep, log } = setup()
        brain.result.mockRejectedValue(new Error("mcp down"))
        await notifier.asanaCreated(1)
        await notifier.settled()
        expect(brain.result).toHaveBeenCalledTimes(3)
        expect(sleep).toHaveBeenCalledTimes(2)
        expect(log.warn).toHaveBeenCalledWith(
            { task_id: 1, brain_job: JOB, err: "mcp down" },
            "slack thread: Brain result unavailable"
        )
        expect(await events(store, EV_RESULT)).toHaveLength(0)
        expect((await flags(store)).now_reason).toBe(NOTICE_REASON)
        // the same job is asked again later; no second post meanwhile
        expect(await notifier.post(1)).toEqual({ skipped: "pending" })
        brain.result.mockResolvedValue(POSTED)
        expect((await notifier.check(1)).status).toBe("posted")
        expect(brain.start).toHaveBeenCalledTimes(1)
    })

    test("still running when the watch gives up: pending, picked up later", async () => {
        const { notifier, store, brain, log } = setup(
            {},
            { results: [{ status: "running" }] }
        )
        await notifier.asanaCreated(1)
        await notifier.settled()
        expect(brain.result).toHaveBeenCalledTimes(5)
        expect(log.warn).toHaveBeenCalledWith(
            { task_id: 1, brain_job: JOB },
            "slack thread: Brain still running, stopped waiting"
        )
        expect(await events(store, EV_RESULT)).toHaveLength(0)
        // no answer in time: Leo should look
        expect((await flags(store)).now_reason).toBe(NOTICE_REASON)
        // Leo dismissed it: a later give-up does not raise it again
        await clearByLeo(store)
        await notifier.state(1, (await store.getTask(1)).task)
        await notifier.settled()
        expect((await flags(store)).now).toBe(false)
        // the page asks for the state: the watch starts again
        brain.result.mockResolvedValue(POSTED)
        const { task } = await store.getTask(1)
        expect((await notifier.state(1, task)).status).toBe("pending")
        await notifier.settled()
        expect((await events(store, EV_RESULT))[0].data.status).toBe("posted")
    })

    test("skips without Brain, a Slack source or an Asana link", async () => {
        const noBrain = createThreadNotifier({
            store: setup().store,
            brain: null,
        })
        expect(await noBrain.asanaCreated(1)).toEqual({ skipped: "no_brain" })
        expect(await noBrain.post(1)).toEqual({ skipped: "no_brain" })
        for (const source of [
            { type: "manual", url: null },
            { type: "slack", url: null },
            undefined,
        ])
            expect(await setup({ source }).notifier.asanaCreated(1)).toEqual({
                skipped: "no_slack",
            })
        for (const asana of [
            { gid: null, url: null, attachments: [] },
            { gid: "999", url: null, attachments: [] },
            null,
        ])
            expect(await setup({ asana }).notifier.asanaCreated(1)).toEqual({
                skipped: "no_asana",
            })
    })

    test("a Brain start failure is recorded, flagged and logged, not thrown", async () => {
        const { notifier, store, log } = setup(
            {},
            {
                start: async () => {
                    throw new Error("brain_do failed: down")
                },
            }
        )
        expect(await notifier.asanaCreated(1)).toEqual({
            started: false,
            error: "brain_do failed: down",
        })
        expect(log.warn).toHaveBeenCalled()
        expect(await events(store, EV_LINK_FAILED)).toHaveLength(1)
        expect(await events(store, EV_LINK)).toHaveLength(0)
        expect((await flags(store)).now_reason).toBe(NOTICE_REASON)
        const { task } = await store.getTask(1)
        expect(await notifier.state(1, task)).toMatchObject({
            status: "failed",
            error: "brain_do failed: down",
            attempts: 1,
        })
    })

    test("concurrent posts start one Brain job", async () => {
        const { notifier, brain } = setup(
            {},
            { results: [{ status: "running" }] }
        )
        const results = await Promise.all([
            notifier.post(1),
            notifier.post(1),
            notifier.asanaCreated(1),
        ])
        expect(brain.start).toHaveBeenCalledTimes(1)
        expect(results).toEqual([
            { started: true, brain_job: JOB },
            { skipped: "pending" },
            { skipped: "already_started" },
        ])
        await notifier.settled()
        // a failing step does not block the next one
        const { store } = setup()
        const n = createThreadNotifier({
            store: {
                ...store,
                getTask: async () => {
                    throw new Error("gone")
                },
            },
            brain,
        })
        await expect(n.post(1)).rejects.toThrow("gone")
        await expect(n.post(1)).rejects.toThrow("gone")
    })

    test("a retry after a failed start reuses its idempotency key", async () => {
        const { notifier, brain } = setup(
            {},
            {
                start: async () => {
                    throw new Error("timeout")
                },
            }
        )
        await notifier.asanaCreated(1)
        brain.start.mockResolvedValue(JOB)
        await notifier.post(1)
        // Brain may have made the first job: same key, so no second post
        expect(brain.start.mock.calls.map((c) => c[0].idempotencyKey)).toEqual([
            "cc-T1-slack-asana-999",
            "cc-T1-slack-asana-999",
        ])
    })

    test("even recording the failure may fail quietly", async () => {
        const { notifier, store } = setup(
            {},
            {
                start: async () => {
                    throw new Error("x")
                },
            }
        )
        store.appendEvent = async () => {
            throw new Error("disk")
        }
        expect(await notifier.asanaCreated(1)).toMatchObject({
            started: false,
        })
    })

    test("a store without events still starts; flag errors are logged", async () => {
        const { notifier, store, log } = setup({}, { results: [REFUSED] })
        store.listEvents = async () => null
        store.updateTask = async () => {
            throw new Error("locked")
        }
        store.withTaskLock = undefined // a store without locks still works
        expect(await notifier.asanaCreated(1)).toMatchObject({ started: true })
        await notifier.settled()
        expect(log.warn).toHaveBeenCalledWith(
            { task_id: 1, err: "locked" },
            "slack thread: Now flag not updated"
        )
    })

    test("a watch that throws stays pending", async () => {
        const { notifier, store, log } = setup()
        store.appendEvent = jest
            .fn()
            .mockResolvedValueOnce({})
            .mockRejectedValue(new Error("disk"))
        await notifier.asanaCreated(1)
        expect(await notifier.settled()).toEqual(["pending"])
        expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ err: "disk" }),
            "slack thread: watch failed"
        )
    })
})

describe("never tried (older tasks)", () => {
    test("the page raises the Now flag once per Asana task", async () => {
        const { notifier, store, log } = setup()
        const task = async () => (await store.getTask(1)).task
        expect((await notifier.state(1, await task())).status).toBe("missing")
        expect(await flags(store)).toMatchObject({
            now: true,
            now_reason: NOTICE_REASON,
        })
        expect(await events(store, EV_MISSING)).toHaveLength(1)
        expect(log.warn).toHaveBeenCalledWith(
            { task_id: 1, gid: "999" },
            "slack thread: never told about the Asana task"
        )
        // another writer (PR watcher) cleared it: raised again
        await store.updateTask(1, { flags: { now: false, now_reason: null } })
        await store.appendEvent(
            1,
            { type: "updated", data: { changed: ["flags"] } },
            "system"
        )
        await notifier.state(1, await task())
        expect((await flags(store)).now_reason).toBe(NOTICE_REASON)
        // Leo cleared it: it stays cleared, no second marker
        await clearByLeo(store)
        expect((await notifier.state(1, await task())).status).toBe("missing")
        expect((await flags(store)).now).toBe(false)
        expect(await events(store, EV_MISSING)).toHaveLength(1)
    })

    test("a closed task is never raised to Now", async () => {
        const { notifier, store } = setup(
            { status: "done" },
            { results: [REFUSED] }
        )
        await notifier.asanaCreated(1)
        await notifier.settled()
        await notifier.state(1, (await store.getTask(1)).task)
        expect((await flags(store)).now).toBe(false)
    })

    test("a failed notice gets Now back once another reason is cleared", async () => {
        const { notifier, store } = setup(
            { flags: { now: true, now_reason: "PR feedback: 1 new item(s)" } },
            { results: [REFUSED] }
        )
        await notifier.asanaCreated(1)
        await notifier.settled()
        // PR feedback held the flag: kept
        expect((await flags(store)).now_reason).toBe(
            "PR feedback: 1 new item(s)"
        )
        // feedback addressed: the watcher clears it -> the notice takes Now
        await store.updateTask(1, { flags: { now: false, now_reason: null } })
        await notifier.state(1, (await store.getTask(1)).task)
        expect((await flags(store)).now_reason).toBe(NOTICE_REASON)
        // Leo dismisses it: stays dismissed
        await clearByLeo(store)
        await notifier.state(1, (await store.getTask(1)).task)
        expect((await flags(store)).now).toBe(false)
    })

    test("stop ends running watches after their current request", async () => {
        const { notifier, brain, store } = setup(
            {},
            { results: [{ status: "running" }] }
        )
        let release
        brain.result.mockImplementationOnce(
            () => new Promise((r) => (release = r))
        )
        await notifier.asanaCreated(1)
        const stopped = notifier.stop()
        release({ status: "running" })
        expect(await stopped).toEqual(["pending"])
        // only the request in flight: no more polls, no result, no new watch
        expect(brain.result).toHaveBeenCalledTimes(1)
        expect(await events(store, EV_RESULT)).toHaveLength(0)
        const { task } = await store.getTask(1)
        expect((await notifier.state(1, task)).status).toBe("pending")
        expect(await notifier.settled()).toEqual([])
        expect(await notifier.sweep()).toBe(0)
    })

    test("stop during a result error skips the retry pause", async () => {
        const { notifier, brain, sleep } = setup()
        let fail
        brain.result.mockImplementationOnce(
            () => new Promise((_, rej) => (fail = rej))
        )
        await notifier.asanaCreated(1)
        const stopped = notifier.stop()
        fail(new Error("down"))
        expect(await stopped).toEqual(["pending"])
        expect(sleep).not.toHaveBeenCalled()
    })

    test("sweep reconciles open Slack tasks; start / stop the timer", async () => {
        const { notifier, store, log } = setup()
        store.query = jest.fn(async () => ({
            tasks: [
                {
                    id: 1,
                    source: { type: "slack", url: THREAD },
                    asana: { gid: "999", url: ASANA },
                },
                { id: 2, source: {} },
            ],
        }))
        expect(await notifier.sweep()).toBe(1)
        expect((await flags(store)).now_reason).toBe(NOTICE_REASON)
        // a task that went away is logged, the sweep goes on
        store.query.mockResolvedValueOnce({
            tasks: [
                {
                    id: 9,
                    source: { type: "slack", url: THREAD },
                    asana: { gid: "1", url: ASANA },
                },
            ],
        })
        expect(await notifier.sweep()).toBe(0)
        expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ task_id: 9 }),
            "slack thread: sweep failed"
        )
        store.query.mockRejectedValueOnce(new Error("db"))
        expect(await notifier.sweep()).toBe(0)
        store.query.mockResolvedValueOnce(null)
        expect(await notifier.sweep()).toBe(0)

        const timers = {
            setInterval: jest.fn(() => ({ unref: jest.fn() })),
            clearInterval: jest.fn(),
        }
        const n = createThreadNotifier({ store, brain: null, timers })
        n.start(5000)
        n.start(5000) // already running
        expect(timers.setInterval).toHaveBeenCalledTimes(1)
        expect(timers.setInterval.mock.calls[0][1]).toBe(5000)
        await n.stop()
        expect(timers.clearInterval).toHaveBeenCalledTimes(1)
        await n.stop()
        expect(timers.clearInterval).toHaveBeenCalledTimes(1)
        // a timer without unref (default interval)
        const t2 = { setInterval: jest.fn(() => 7), clearInterval: jest.fn() }
        const n2 = createThreadNotifier({ store, brain: null, timers: t2 })
        n2.start()
        expect(t2.setInterval.mock.calls[0][1]).toBe(600000)
        await n2.stop()
    })

    test("a store error while flagging is logged", async () => {
        const { notifier, store, log } = setup()
        store.appendEvent = async () => {
            throw new Error("disk")
        }
        const { task } = await store.getTask(1)
        expect((await notifier.state(1, task)).status).toBe("missing")
        expect(log.warn).toHaveBeenCalledWith(
            { task_id: 1, err: "disk" },
            "slack thread: Now flag not updated"
        )
    })
})

describe("post again and check", () => {
    test("post: a new attempt after a refusal; posted clears the flag", async () => {
        const { notifier, store, brain } = setup({}, { results: [REFUSED] })
        await notifier.asanaCreated(1)
        await notifier.settled()
        brain.start.mockResolvedValue(JOB2)
        brain.result.mockResolvedValue(POSTED)
        expect(await notifier.post(1)).toEqual({
            started: true,
            brain_job: JOB2,
        })
        expect(brain.start).toHaveBeenLastCalledWith(
            expect.objectContaining({
                idempotencyKey: "cc-T1-slack-asana-999-2",
            })
        )
        await notifier.settled()
        const { task } = await store.getTask(1)
        expect(await notifier.state(1, task)).toMatchObject({
            status: "posted",
            attempts: 2,
            brain_job: JOB2,
        })
        expect(await flags(store)).toMatchObject({
            now: false,
            now_reason: null,
        })
        // posted: no more posts
        expect(await notifier.post(1)).toEqual({ skipped: "already_posted" })
    })

    test("post: never tried (an older task) and while one is running", async () => {
        const { notifier, brain } = setup(
            {},
            { results: [{ status: "running" }] }
        )
        expect(await notifier.post(1)).toMatchObject({ started: true })
        expect(brain.start).toHaveBeenCalledWith(
            expect.objectContaining({ idempotencyKey: "cc-T1-slack-asana-999" })
        )
        await notifier.settled()
        expect(await notifier.post(1)).toEqual({ skipped: "pending" })
    })

    test("check asks Brain once without waiting", async () => {
        const { notifier, brain } = setup(
            {},
            { results: [{ status: "running" }] }
        )
        await notifier.asanaCreated(1)
        await notifier.settled()
        brain.result.mockClear()
        brain.result.mockResolvedValue(POSTED)
        expect((await notifier.check(1)).status).toBe("posted")
        expect(brain.result).toHaveBeenCalledTimes(1)
        expect(brain.result).toHaveBeenCalledWith(JOB, { waitSeconds: 0 })
        // nothing pending: no Brain call
        expect((await notifier.check(1)).status).toBe("posted")
        expect(brain.result).toHaveBeenCalledTimes(1)
    })

    test("without brain.result nothing is watched", async () => {
        const { store } = setup()
        const n = createThreadNotifier({
            store,
            brain: { start: async () => JOB },
        })
        await n.asanaCreated(1)
        expect(await n.settled()).toEqual([])
        expect((await n.check(1)).status).toBe("pending")
    })
})

describe("noticeState", () => {
    const task = (over = {}) => ({
        source: { type: "slack", url: THREAD },
        asana: { gid: "999" },
        ...over,
    })
    test("not applicable, missing, other gids ignored", () => {
        expect(noticeState(task({ source: {} }), [])).toBeNull()
        expect(noticeState(task({ asana: null }), [])).toBeNull()
        expect(noticeState(null, [])).toBeNull()
        const other = { type: EV_LINK, data: { gid: "1", brain_job: JOB } }
        expect(noticeState(task(), [other, null])).toMatchObject({
            status: "missing",
            attempts: 0,
            thread: THREAD,
        })
        expect(noticeState(task(), null).status).toBe("missing")
    })
    test("the latest attempt decides (events newest first)", () => {
        const ev = [
            {
                type: EV_RESULT,
                at: "3",
                data: { gid: "999", brain_job: JOB2, status: "posted" },
            },
            { type: EV_LINK, at: "2", data: { gid: "999", brain_job: JOB2 } },
            { type: EV_LINK_FAILED, at: "1", data: { gid: "999" } },
        ]
        expect(noticeState(task(), ev)).toMatchObject({
            status: "posted",
            attempts: 2,
            answer: null,
            error: null,
            at: "3",
        })
        expect(noticeState(task(), ev.slice(2))).toMatchObject({
            status: "failed",
            error: null,
        })
    })
})

describe("routes and task extras", () => {
    function fakeApi() {
        const routes = {}
        return {
            routes,
            post: (path, fn) => {
                routes[path] = fn
            },
        }
    }
    const res = () => {
        const r = { body: null }
        r.json = (b) => {
            r.body = b
        }
        return r
    }
    const helpers = {
        parseTaskId: (v) => Number(v),
        isViewer: (req) => Boolean(req.viewer),
    }

    test("post and check answer with the new state; viewers are refused", async () => {
        const { notifier } = setup({}, { results: [REFUSED] })
        const api = fakeApi()
        mountThreadNotice(api, helpers, { notifier })
        const r1 = res()
        await api.routes["/tasks/:id/slack-notice"]({ params: { id: "1" } }, r1)
        expect(r1.body.result).toEqual({ started: true, brain_job: JOB })
        await notifier.settled()
        const r2 = res()
        await api.routes["/tasks/:id/slack-notice/check"](
            { params: { id: "1" } },
            r2
        )
        expect(r2.body.slack_notice.status).toBe("not_posted")
        await expect(
            api.routes["/tasks/:id/slack-notice"](
                { params: { id: "1" }, viewer: true },
                res()
            )
        ).rejects.toMatchObject({ status: 403 })
        // without isViewer every caller is the owner
        const api2 = fakeApi()
        mountThreadNotice(api2, { parseTaskId: Number }, { notifier })
        const r3 = res()
        await api2.routes["/tasks/:id/slack-notice/check"](
            { params: { id: "1" } },
            r3
        )
        expect(r3.body.slack_notice.status).toBe("not_posted")
    })

    test("noticeTaskExtras", async () => {
        const { notifier, store } = setup()
        const { task } = await store.getTask(1)
        expect(await noticeTaskExtras(notifier)(1, task)).toEqual({
            slack_notice: expect.objectContaining({ status: "missing" }),
        })
    })
})
