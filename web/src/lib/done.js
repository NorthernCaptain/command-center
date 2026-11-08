/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { taskKey } from "./constants.js"

/**
 * Toast text after "Done". An Asana-linked task answers 202 with
 * close_out "started" | "pending": it closes out in the background (Result
 * section, Asana comment + completion) and turns done when that finishes.
 */
export function doneMessage(id, res) {
    if (res && res.close_out === "pending")
        return `${taskKey(id)}: close-out already running`
    if (res && res.close_out)
        return `${taskKey(id)}: closing out (Result, Asana), done shortly`
    return `${taskKey(id)} done`
}
