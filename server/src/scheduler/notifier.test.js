/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { appleScriptString, createNotifier, defaultExec } from "./notifier.js"

function fakeExec({ failHerdr = false, failOsascript = false } = {}) {
    const calls = []
    const exec = jest.fn(async (file, args) => {
        calls.push([file, args])
        if (file === "herdr" && failHerdr) throw new Error("herdr down")
        if (file === "osascript" && failOsascript) throw new Error("no gui")
        return { stdout: "", stderr: "" }
    })
    return { exec, calls }
}

function fakeLog() {
    return {
        debug: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
    }
}

describe("appleScriptString", () => {
    test("escapes backslashes, quotes and newlines", () => {
        expect(appleScriptString('say "hi" \\ bye\nnext')).toBe(
            '"say \\"hi\\" \\\\ bye next"'
        )
        expect(appleScriptString(null)).toBe('""')
    })
})

describe("defaultExec", () => {
    test("is a function (not invoked: never call real binaries)", () => {
        expect(typeof defaultExec).toBe("function")
    })
})

describe("createNotifier", () => {
    test("uses herdr first", async () => {
        const { exec, calls } = fakeExec()
        const n = createNotifier({ exec, log: fakeLog() })
        await expect(
            n.notify({ title: "Reminder", body: "T-1 Call Ron", sound: "done" })
        ).resolves.toBe(true)
        expect(calls).toEqual([
            [
                "herdr",
                [
                    "notification",
                    "show",
                    "--body=T-1 Call Ron",
                    "--sound=done",
                    "--",
                    "Reminder",
                ],
            ],
        ])
    })

    test("defaults sound to request, omits empty body", async () => {
        const { exec, calls } = fakeExec()
        const n = createNotifier({ exec })
        await n.notify({ title: "-dash title" })
        expect(calls[0][1]).toEqual([
            "notification",
            "show",
            "--sound=request",
            "--",
            "-dash title",
        ])
    })

    test("invalid sound becomes none; blank title gets a default", async () => {
        const { exec, calls } = fakeExec()
        const n = createNotifier({ exec })
        await n.notify({ title: "  ", body: "b", sound: "loud" })
        expect(calls[0][1]).toEqual([
            "notification",
            "show",
            "--body=b",
            "--sound=none",
            "--",
            "Command Center",
        ])
        await n.notify()
        expect(calls[1][1].at(-1)).toBe("Command Center")
    })

    test("falls back to osascript with escaping", async () => {
        const { exec, calls } = fakeExec({ failHerdr: true })
        const log = fakeLog()
        const n = createNotifier({ exec, log })
        const ok = await n.notify({
            title: 'Say "hi"',
            body: "path C:\\tmp",
            sound: "request",
        })
        expect(ok).toBe(true)
        expect(calls[1]).toEqual([
            "osascript",
            [
                "-e",
                'display notification "path C:\\\\tmp" with title "Say \\"hi\\""' +
                    ' sound name "Glass"',
            ],
        ])
        expect(log.debug).toHaveBeenCalled()
    })

    test("osascript without sound and without body uses the title", async () => {
        const { exec, calls } = fakeExec({ failHerdr: true })
        const n = createNotifier({ exec })
        await n.notify({ title: "Hello", sound: "none" })
        expect(calls[1][1]).toEqual([
            "-e",
            'display notification "Hello" with title "Hello"',
        ])
    })

    test("returns false and never throws when everything fails", async () => {
        const { exec } = fakeExec({ failHerdr: true, failOsascript: true })
        const log = fakeLog()
        const n = createNotifier({ exec, log })
        await expect(n.notify({ title: "x" })).resolves.toBe(false)
        expect(log.warn).toHaveBeenCalled()
    })

    test("survives non-Error rejections", async () => {
        const exec = jest.fn(async () => {
            throw undefined
        })
        const n = createNotifier({ exec })
        await expect(n.notify({ title: "x" })).resolves.toBe(false)
        expect(exec).toHaveBeenCalledTimes(2)
    })
})

describe("push fan-out", () => {
    function settings(enabled) {
        return { get: jest.fn(async () => enabled) }
    }

    test("sends to push when push.enabled is true", async () => {
        const { exec } = fakeExec()
        const push = { sendAll: jest.fn(async () => ({ sent: 1 })) }
        const settingsRepo = settings(true)
        const n = createNotifier({ exec, log: fakeLog(), push, settingsRepo })
        await n.notify({ title: "Reminder", body: "T-1", url: "/tasks/1" })
        await n.flushPush()
        expect(settingsRepo.get).toHaveBeenCalledWith("push.enabled", false)
        expect(push.sendAll).toHaveBeenCalledWith({
            title: "Reminder",
            body: "T-1",
            url: "/tasks/1",
        })
    })

    test("defaults url to / and skips when disabled or unwired", async () => {
        const { exec } = fakeExec()
        const push = { sendAll: jest.fn(async () => ({})) }
        const off = createNotifier({
            exec,
            log: fakeLog(),
            push,
            settingsRepo: settings(false),
        })
        await off.notify({ title: "x" })
        await off.flushPush()
        expect(push.sendAll).not.toHaveBeenCalled()

        const noSettings = createNotifier({ exec, log: fakeLog(), push })
        await noSettings.notify({ title: "x" })
        await noSettings.flushPush()
        expect(push.sendAll).not.toHaveBeenCalled()

        const late = createNotifier({
            exec,
            log: fakeLog(),
            settingsRepo: settings(true),
        })
        await late.notify({ title: "before" })
        await late.flushPush()
        late.setPush(push)
        await late.notify({ title: "after" })
        await late.flushPush()
        expect(push.sendAll).toHaveBeenCalledTimes(1)
        expect(push.sendAll).toHaveBeenCalledWith({
            title: "after",
            body: "",
            url: "/",
        })
        late.setPush(null)
        await late.notify({ title: "unbound" })
        await late.flushPush()
        expect(push.sendAll).toHaveBeenCalledTimes(1)

        // settings can be bound together with the sender
        const bare = createNotifier({ exec, log: fakeLog() })
        bare.setPush(push, settings(true))
        await bare.notify({ title: "both" })
        await bare.flushPush()
        expect(push.sendAll).toHaveBeenCalledTimes(2)
    })

    test("push failure never breaks the local notification", async () => {
        const { exec, calls } = fakeExec()
        const log = fakeLog()
        const push = {
            sendAll: jest.fn(async () => {
                throw new Error("push service down")
            }),
        }
        const n = createNotifier({
            exec,
            log,
            push,
            settingsRepo: settings(true),
        })
        await expect(n.notify({ title: "Hi" })).resolves.toBe(true)
        await n.flushPush()
        expect(calls[0][0]).toBe("herdr")
        expect(log.warn).toHaveBeenCalledWith(
            { err: "push service down" },
            "push notification failed"
        )
    })
})

describe("drainPush", () => {
    test("waits for every outstanding fan-out, not only the latest", async () => {
        const releases = []
        const sent = []
        const push = {
            sendAll: jest.fn(
                ({ title }) =>
                    new Promise((r) =>
                        releases.push(() => {
                            sent.push(title)
                            r({ sent: 1 })
                        })
                    )
            ),
        }
        const settingsRepo = { get: async () => true }
        const n = createNotifier({
            exec: async () => ({ stdout: "" }),
            push,
            settingsRepo,
        })
        await n.notify({ title: "a" })
        await n.notify({ title: "b" })
        await new Promise((r) => setImmediate(r))
        expect(push.sendAll).toHaveBeenCalledTimes(2)
        let drained = false
        const d = n.drainPush().then(() => (drained = true))
        releases[1]() // the latest finishes first
        await n.flushPush()
        await new Promise((r) => setImmediate(r))
        expect(drained).toBe(false) // "a" is still running
        releases[0]()
        await d
        expect(sent.sort()).toEqual(["a", "b"])
        await n.drainPush() // nothing left: resolves at once
    })
})
