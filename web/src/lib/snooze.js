/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Snooze = status "waiting" + snooze_until; the server schedules the
// "surface" wake-up. Presets carry an exact time and are sent as a patch.
// Free text is sent as PATCH { snooze: "<text>" } so the server's date parser
// (the same one capture uses) reads it; unreadable text is a 400 whose
// message is shown to the user.

import { ApiError } from "./api.js"

/**
 * choice: { at: ISO } | { text: string }.
 * -> { kind: "snoozed", at, task, revision }
 */
export async function snoozeTask(api, task, choice) {
    if (choice.at) {
        const res = await api.patchTask(task.id, {
            status: "waiting",
            snooze_until: choice.at,
        })
        return { kind: "snoozed", at: choice.at, ...(res || {}) }
    }
    const text = String(choice.text || "").trim()
    if (!text) throw new Error("When should it come back?")
    try {
        const res =
            (await api.patchTask(task.id, null, undefined, {
                snooze: text,
            })) || {}
        const at = (res.task && res.task.snooze_until) || null
        return { kind: "snoozed", at, ...res }
    } catch (err) {
        if (err instanceof ApiError && err.status === 400) {
            err.message = `Can't snooze until "${text}": ${err.message}`
        }
        throw err
    }
}
