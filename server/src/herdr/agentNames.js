/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { truncateName } from "../workers/identity.js"
import { AppError } from "../util/errors.js"

/**
 * First free herdr agent name: base, else base-2 … base-9. `lookup(name)`
 * answers null when herdr knows no such agent (anything else: taken, or
 * unknown when herdr is unreachable). `reserved` holds names other
 * launches picked but have not started yet: a name is reserved right
 * after its lookup, so parallel launches never pick the same one; the
 * caller drops it once its agent started (or failed).
 * @param {string} base
 * @param {(name: string) => Promise<object|null|undefined>} lookup
 * @param {{ reserved?: Set<string> }} [opts]
 */
export async function freeAgentName(base, lookup, { reserved = null } = {}) {
    const stem = truncateName(base, 29)
    const names = [base]
    for (let n = 2; n < 10; n++) names.push(`${stem}-${n}`)
    for (const name of names) {
        if (reserved && reserved.has(name)) continue
        if ((await lookup(name)) !== null) continue
        // another launch may have taken it while herdr answered
        if (reserved && reserved.has(name)) continue
        if (reserved) reserved.add(name)
        return name
    }
    throw new AppError(
        "agent_name_taken",
        `no free herdr agent name for ${base}`,
        {
            status: 409,
        }
    )
}
