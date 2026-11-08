/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { ApiError } from "./api.js"
import { snoozeTask } from "./snooze.js"

describe("snoozeTask", () => {
    const task = { id: 4 }

    it("patches waiting + snooze_until for presets", async () => {
        const api = {
            patchTask: jest.fn(async () => ({
                task: { id: 4 },
                revision: "r",
            })),
        }
        const res = await snoozeTask(api, task, {
            at: "2026-11-08T09:00:00.000Z",
        })
        expect(api.patchTask).toHaveBeenCalledWith(4, {
            status: "waiting",
            snooze_until: "2026-11-08T09:00:00.000Z",
        })
        expect(res).toEqual({
            kind: "snoozed",
            at: "2026-11-08T09:00:00.000Z",
            task: { id: 4 },
            revision: "r",
        })
    })

    it("sends custom text to the server as { snooze } (never a schedule)", async () => {
        const api = {
            patchTask: jest.fn(async () => ({
                task: { id: 4, snooze_until: "2026-11-13T15:00:00.000Z" },
                revision: "r2",
            })),
            addSchedule: jest.fn(),
        }
        const res = await snoozeTask(api, task, { text: " friday 3pm " })
        expect(api.patchTask).toHaveBeenCalledWith(4, null, undefined, {
            snooze: "friday 3pm",
        })
        expect(api.addSchedule).not.toHaveBeenCalled()
        expect(res).toEqual({
            kind: "snoozed",
            at: "2026-11-13T15:00:00.000Z",
            task: { id: 4, snooze_until: "2026-11-13T15:00:00.000Z" },
            revision: "r2",
        })
    })

    it("tolerates an empty server response", async () => {
        const api = { patchTask: jest.fn(async () => null) }
        const res = await snoozeTask(api, task, { text: "3d" })
        expect(res).toEqual({ kind: "snoozed", at: null })
    })

    it("surfaces the server's 400 message for unreadable text", async () => {
        const api = {
            patchTask: jest.fn(async () => {
                throw new ApiError({
                    status: 400,
                    code: "validation",
                    message: "could not parse snooze",
                })
            }),
        }
        await expect(
            snoozeTask(api, task, { text: "whenever" })
        ).rejects.toThrow(
            'Can\'t snooze until "whenever": could not parse snooze'
        )
    })

    it("rethrows other errors unchanged", async () => {
        const boom = new ApiError({ status: 500, message: "down" })
        const api = {
            patchTask: jest.fn(async () => {
                throw boom
            }),
        }
        await expect(snoozeTask(api, task, { text: "3d" })).rejects.toBe(boom)
        expect(boom.message).toBe("down")
    })

    it("rejects empty text", async () => {
        await expect(snoozeTask({}, task, { text: "  " })).rejects.toThrow(
            "When should"
        )
    })
})
