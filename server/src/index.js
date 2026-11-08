#!/usr/bin/env node
/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Service entry point (launchd runs this). See system.js for the wiring.

import { loadConfig } from "./config/config.js"
import { createLogger } from "./util/logger.js"
import { createSystem, detectPublicBaseUrl } from "./system.js"

const log = createLogger()
const config = loadConfig()
// Best effort at startup (Asana links use it); if Tailscale is not up yet,
// the tailnet host guard keeps retrying lazily (see system.js).
if (!config.publicBaseUrl) {
    config.publicBaseUrl = await detectPublicBaseUrl({
        port: config.tailscale.httpsPort,
        log,
    })
    log.info({ publicBaseUrl: config.publicBaseUrl }, "tailnet URL detected")
}
const system = createSystem({ config, overrides: { log } })

let stopping = false
async function shutdown(signal) {
    if (stopping) return
    stopping = true
    log.info({ signal }, "shutting down")
    try {
        await system.stop()
    } catch (err) {
        log.error({ err: err.message }, "shutdown error")
    }
    process.exit(0)
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

system.start().catch((err) => {
    log.error({ err: err.message, stack: err.stack }, "startup failed")
    process.exit(1)
})
