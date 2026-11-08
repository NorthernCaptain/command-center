/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import pino from "pino"

export function createLogger({ level = process.env.LOG_LEVEL || "info" } = {}) {
    return pino({ level, base: { app: "command-center" } })
}

/** Silent logger for tests. */
export const nullLogger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
        return nullLogger
    },
}
