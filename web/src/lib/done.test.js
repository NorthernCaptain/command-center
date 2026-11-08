/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { doneMessage } from "./done.js"

describe("doneMessage", () => {
    test("plain done", () => {
        expect(doneMessage(4, { task: {} })).toBe("T-4 done")
        expect(doneMessage(4, undefined)).toBe("T-4 done")
    })
    test("close-out started / pending", () => {
        expect(doneMessage(4, { close_out: "started" })).toBe(
            "T-4: closing out (Result, Asana), done shortly"
        )
        expect(doneMessage(4, { close_out: "pending" })).toBe(
            "T-4: close-out already running"
        )
    })
})
