/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Host-header validation against DNS rebinding. Runs before auth, static
// files and /healthz on both listeners.
//
// A page at http://evil.example:7789 whose name is rebound to 127.0.0.1 is
// same-origin with that name, so the browser lets it set any non-forbidden
// header (e.g. Tailscale-User-Login) and read the responses. The only thing
// it cannot choose is the Host header, which stays "evil.example:7789".
//
// - tailnet: Host must equal new URL(config.publicBaseUrl).host
//   (`tailscale serve` preserves the original Host). X-Forwarded-Host, when
//   present, must name the same host too; it never substitutes for Host
//   (a same-origin page can set it). Without a valid publicBaseUrl every
//   tailnet request is refused with 503; when a resolver is injected
//   (system.js: `tailscale status`), it is retried lazily, at most once a
//   minute, until it yields a URL.
// - local: Host must be 127.0.0.1:<port>, localhost:<port> or [::1]:<port>,
//   where port is the configured local port or the port the request
//   actually arrived on (they are the same unless the port is ephemeral).

import { AppError } from "../util/errors.js"
import { systemClock } from "../util/clock.js"

const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"]

/**
 * Normalize a Host-style value ("name[:port]") to URL.host form
 * (lowercase, default port dropped). Returns null for anything that is not
 * a bare host[:port].
 */
export function normalizeHost(value, protocol = "http:") {
    if (typeof value !== "string") return null
    const v = value.trim()
    if (!v || /[\s/\\@?#]/.test(v)) return null
    try {
        const u = new URL(`${protocol}//${v}`)
        return u.host || null
    } catch {
        return null
    }
}

/** { protocol, host } of a usable publicBaseUrl, or null. */
export function parsePublicBase(publicBaseUrl) {
    if (!publicBaseUrl || typeof publicBaseUrl !== "string") return null
    try {
        const u = new URL(publicBaseUrl)
        if (u.protocol !== "https:" && u.protocol !== "http:") return null
        if (!u.host) return null
        return { protocol: u.protocol, host: u.host.toLowerCase() }
    } catch {
        return null
    }
}

/** Accepted loopback Host values for the given ports. */
export function localHosts(ports) {
    const out = new Set()
    for (const p of ports) {
        const port = Number(p)
        if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
        for (const name of LOOPBACK_NAMES) {
            const h = normalizeHost(`${name}:${port}`)
            if (h) out.add(h)
        }
    }
    return out
}

/** Minimum delay between two publicBaseUrl resolution attempts. */
export const RESOLVE_RETRY_MS = 60000

/**
 * Express middleware factory. On success sets `req.ccHost` to the
 * validated (normalized) public host of the request.
 * @param {object} deps
 * @param {"local"|"tailnet"} deps.mode
 * @param {object} deps.config   publicBaseUrl, listeners.local.port
 * @param {object} [deps.log]
 * @param {() => Promise<string|null>} [deps.resolvePublicBaseUrl]
 *        tailnet only: called while publicBaseUrl is unknown (Tailscale
 *        may come up after the service), at most once per RESOLVE_RETRY_MS;
 *        the first usable URL is cached (and written to config).
 * @param {{ now(): Date }} [deps.clock]
 */
export function createHostGuard({
    mode,
    config,
    log,
    resolvePublicBaseUrl = null,
    clock = systemClock,
}) {
    const misdirected = () =>
        new AppError("misdirected", "unexpected Host header", { status: 421 })

    if (mode === "tailnet") {
        let base = parsePublicBase(config.publicBaseUrl)
        let warned = false
        let lastAttempt = null
        let inFlight = null

        const notConfigured = () => {
            if (!warned) {
                warned = true
                log?.error?.(
                    { publicBaseUrl: config.publicBaseUrl ?? null },
                    "publicBaseUrl not configured: refusing tailnet requests"
                )
            }
            return new AppError(
                "not_configured",
                "publicBaseUrl not configured",
                { status: 503 }
            )
        }

        /** Resolve once per RESOLVE_RETRY_MS; concurrent callers share it.
         *  Never rejects: null while still unknown. */
        const resolveBase = () => {
            if (inFlight) return inFlight
            const now = clock.now().getTime()
            if (lastAttempt !== null && now - lastAttempt < RESOLVE_RETRY_MS)
                return Promise.resolve(null)
            lastAttempt = now
            // Cleared asynchronously, even if the resolver throws synchronously.
            inFlight = (async () => {
                try {
                    const url = await resolvePublicBaseUrl()
                    const parsed = parsePublicBase(url)
                    if (parsed && !base) {
                        base = parsed
                        config.publicBaseUrl = url
                        log?.info?.(
                            { publicBaseUrl: url },
                            "tailnet URL resolved"
                        )
                    }
                } catch (err) {
                    log?.warn?.(
                        { err: err?.message },
                        "publicBaseUrl resolution failed"
                    )
                }
                return base
            })().finally(() => {
                inFlight = null
            })
            return inFlight
        }

        /** Throws 421 unless Host (and any X-Forwarded-Host) is `b.host`. */
        const check = (b, req) => {
            const host = normalizeHost(req.headers.host, b.protocol)
            if (host !== b.host) throw misdirected()
            const fwd = req.headers["x-forwarded-host"]
            if (fwd !== undefined) {
                const list = String(fwd).split(",")
                for (const entry of list)
                    if (normalizeHost(entry, b.protocol) !== b.host)
                        throw misdirected()
            }
            req.ccHost = b.host
        }

        return function tailnetHostGuard(req, res, next) {
            if (base) {
                check(base, req)
                return next()
            }
            if (typeof resolvePublicBaseUrl !== "function")
                throw notConfigured()
            return resolveBase().then((b) => {
                let err
                try {
                    if (!b) throw notConfigured()
                    check(b, req)
                } catch (e) {
                    err = e
                }
                next(err)
            })
        }
    }

    const configured = config.listeners?.local?.port
    return function localHostGuard(req, res, next) {
        const allowed = localHosts([configured, req.socket?.localPort])
        const host = normalizeHost(req.headers.host)
        if (!host || !allowed.has(host)) throw misdirected()
        req.ccHost = host
        next()
    }
}
