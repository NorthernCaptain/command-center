/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Registry of phase 1 job modules.

import asanaCreate from "./asana_create.js"
import assist from "./assist.js"
import closeOut from "./close_out.js"
import command from "./command.js"
import enrich from "./enrich.js"
import parseQuick from "./parse_quick.js"

export const DEFAULT_JOBS = [
    parseQuick,
    enrich,
    assist,
    command,
    asanaCreate,
    closeOut,
]

const REQUIRED = [
    "type",
    "lane",
    "weight",
    "outputSchema",
    "buildPrompt",
    "apply",
]

/** Map of type -> module. Validates the module contract. */
export function createJobRegistry(modules = DEFAULT_JOBS) {
    const map = new Map()
    for (const m of modules) {
        const missing = REQUIRED.filter((k) => m[k] === undefined)
        if (missing.length)
            throw new Error(
                `job module ${m.type || "?"} missing ${missing.join(", ")}`
            )
        if (!["interactive", "background"].includes(m.lane))
            throw new Error(`job module ${m.type} has invalid lane ${m.lane}`)
        if (map.has(m.type)) throw new Error(`duplicate job type ${m.type}`)
        map.set(m.type, m)
    }
    return map
}
