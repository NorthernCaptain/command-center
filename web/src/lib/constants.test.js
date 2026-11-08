/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    allowedStatuses,
    canTransition,
    isOpenStatus,
    taskKey,
} from "./constants.js"

describe("constants", () => {
    it("mirrors lifecycle transitions", () => {
        expect(canTransition("inbox", "ready")).toBe(true)
        expect(canTransition("inbox", "pr_open")).toBe(false)
        expect(canTransition("done", "done")).toBe(true)
        expect(canTransition("nope", "ready")).toBe(false)
        expect(allowedStatuses("done")).toEqual(["ready", "active", "done"])
        expect(allowedStatuses("waiting")).toContain("active")
        expect(isOpenStatus("cancelled")).toBe(false)
        expect(isOpenStatus("active")).toBe(true)
        expect(taskKey(7)).toBe("T-7")
    })
})
