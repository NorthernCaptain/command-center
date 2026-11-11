/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Bind the two express apps on loopback. Both listeners are 127.0.0.1 only:
// the tailnet one is reached through `tailscale serve`, never directly.

import http from "node:http"
import { nullLogger } from "../util/logger.js"

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"])

function listen(app, { host, port }, name, log) {
    if (!LOOPBACK.has(host))
        throw new Error(`${name} listener must bind loopback, got ${host}`)
    // large attachment uploads over the tailnet can take longer than the
    // default 5-minute request timeout
    const server = http.createServer({ requestTimeout: 30 * 60 * 1000 }, app)
    return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => {
            server.off("error", reject)
            const addr = server.address()
            log.info(
                { host: addr.address, port: addr.port },
                `${name} listening`
            )
            resolve(server)
        })
    })
}

function closeServer(server) {
    return new Promise((resolve) => {
        server.close(() => resolve())
        // SSE streams keep connections open; drop them so close() returns.
        server.closeAllConnections?.()
    })
}

/**
 * @param {object} deps
 * @param {object} deps.appLocal      express app (mode "local")
 * @param {object|null} [deps.appTailnet] express app (mode "tailnet"); null disables
 * @param {object} deps.config        config.listeners.{local,tailnet}
 * @param {object} [deps.log]
 * @returns {Promise<{ local: {host,port}, tailnet: {host,port}|null, close(): Promise<void> }>}
 */
export async function startListeners({ appLocal, appTailnet, config, log }) {
    const logger = log || nullLogger
    const servers = []
    try {
        const local = await listen(
            appLocal,
            config.listeners.local,
            "local",
            logger
        )
        servers.push(local)
        let tailnet = null
        if (appTailnet) {
            tailnet = await listen(
                appTailnet,
                config.listeners.tailnet,
                "tailnet",
                logger
            )
            servers.push(tailnet)
        }
        const addr = (s) =>
            s ? { host: s.address().address, port: s.address().port } : null
        return {
            local: addr(local),
            tailnet: addr(tailnet),
            servers: { local, tailnet },
            async close() {
                await Promise.all(servers.map(closeServer))
            },
        }
    } catch (err) {
        await Promise.all(servers.map(closeServer))
        throw err
    }
}
