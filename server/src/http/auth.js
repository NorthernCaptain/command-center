/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Authentication and role resolution for both listeners.
// See docs/06-ui-artifacts-comments.md "Access: owner edits, tailnet reads"
// and docs/implementation/contracts.md "Auth & roles".
//
// - local listener: owner via `Authorization: Bearer <localToken>` or a
//   `cc_session` cookie (bootstrapped by `cc open`). Tailscale headers are
//   ignored. Otherwise no role (401).
// - tailnet listener: `Tailscale-User-Login` is required (else 401). Owner
//   when login === config.owner.tailscaleLogin (set by `tailscale serve`);
//   a `cc_device` cookie of an unrevoked device is attached when present.
//   Otherwise viewer. Trade-off: the listener is on 127.0.0.1, so a local
//   process that sends the owner login header gets owner access too.
//
// Pairing brute force is bounded per issued code, not per claimed login
// (a forged owner header must not be able to lock the owner out): only the
// most recently issued code is accepted, and it is invalidated after
// PAIR_MAX_FAILURES wrong attempts; issuing a new code starts fresh. A
// global cap (PAIR_GLOBAL_MAX_FAILURES per PAIR_WINDOW_MS) answers 429 and,
// while it holds, kills a code on its first wrong attempt, so a freshly
// issued code still pairs with the right digits.
//
// Live SSE streams register here by credential (session hash / device id)
// so logout and device revocation can end them; heartbeats re-check the
// credential with stillValid().

import crypto from "node:crypto"
import nodeFs from "node:fs"
import path from "node:path"
import { systemClock } from "../util/clock.js"
import { AppError, ForbiddenError, ValidationError } from "../util/errors.js"

export const SESSION_COOKIE = "cc_session"
export const DEVICE_COOKIE = "cc_device"
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000
export const DEVICE_TTL_MS = 365 * 24 * 3600 * 1000
export const BOOTSTRAP_TTL_MS = 2 * 60 * 1000
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000
export const PAIR_MAX_FAILURES = 5
export const PAIR_WINDOW_MS = 10 * 60 * 1000
export const PAIR_GLOBAL_MAX_FAILURES = 20

/** sha256 hex digest of a string. */
export function sha256(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex")
}

/** Constant-time string comparison (compares digests, so length-safe). */
export function safeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false
    const da = crypto.createHash("sha256").update(a).digest()
    const db = crypto.createHash("sha256").update(b).digest()
    return crypto.timingSafeEqual(da, db)
}

/** Parse a Cookie header into a plain object (first value wins). */
export function parseCookies(header) {
    const out = {}
    if (!header || typeof header !== "string") return out
    for (const part of header.split(";")) {
        const idx = part.indexOf("=")
        if (idx < 0) continue
        const name = part.slice(0, idx).trim()
        if (!name || name in out) continue
        let value = part.slice(idx + 1).trim()
        if (value.startsWith('"') && value.endsWith('"') && value.length > 1)
            value = value.slice(1, -1)
        try {
            out[name] = decodeURIComponent(value)
        } catch {
            out[name] = value
        }
    }
    return out
}

/** Serialize a Set-Cookie header value. */
export function serializeCookie(name, value, opts = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`]
    parts.push(`Path=${opts.path || "/"}`)
    if (opts.maxAgeMs !== undefined)
        parts.push(`Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`)
    if (opts.httpOnly !== false) parts.push("HttpOnly")
    if (opts.secure) parts.push("Secure")
    parts.push(`SameSite=${opts.sameSite || "Strict"}`)
    return parts.join("; ")
}

/**
 * Read `<configDir>/token`, creating it (0600, 32 random bytes hex) when
 * missing. `fs` is injectable (needs readFileSync, writeFileSync, mkdirSync).
 */
export function ensureLocalToken({
    configDir,
    fs = nodeFs,
    randomBytes = crypto.randomBytes,
}) {
    const file = path.join(configDir, "token")
    try {
        const token = String(fs.readFileSync(file, "utf8")).trim()
        if (token) return token
    } catch (err) {
        if (err.code !== "ENOENT") throw err
    }
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
    const token = randomBytes(32).toString("hex")
    try {
        fs.writeFileSync(file, token + "\n", { mode: 0o600, flag: "wx" })
    } catch (err) {
        if (err.code !== "EEXIST") throw err
        // Another process created it first (or it exists but is empty).
        const existing = String(fs.readFileSync(file, "utf8")).trim()
        if (!existing) throw new Error(`token file ${file} is empty`)
        return existing
    }
    return token
}

/** Public device view (never includes the token hash). */
export function publicDevice(d) {
    if (!d) return null
    return {
        id: d.id,
        name: d.name,
        created_at: d.created_at ?? null,
        last_seen_at: d.last_seen_at ?? null,
        revoked_at: d.revoked_at ?? null,
    }
}

/**
 * @param {object} deps
 * @param {object} deps.config           loaded config (owner, configDir)
 * @param {object} deps.devicesRepo      contracts "devicesRepo" (+ pairCodes)
 * @param {string} [deps.localToken]     bearer token; read via ensureLocalToken when omitted
 * @param {object} [deps.fs]             injected fs for ensureLocalToken
 * @param {object} [deps.clock]
 * @param {Function} [deps.randomBytes]
 * @param {Function} [deps.randomInt]
 * @param {object} [deps.log]
 */
export function createAuth({
    config,
    devicesRepo,
    localToken,
    fs = nodeFs,
    clock = systemClock,
    randomBytes = crypto.randomBytes,
    randomInt = crypto.randomInt,
    log,
}) {
    const token =
        localToken ||
        ensureLocalToken({ configDir: config.configDir, fs, randomBytes })
    const ownerLogin = config.owner && config.owner.tailscaleLogin
    const sessions = new Map() // sha256(token) -> expiresAt ms
    const bootstrapTokens = new Map() // sha256(token) -> expiresAt ms
    let activeCode = null // { hash, expiresAt ms, failures } latest pair code
    let pairFailures = [] // failure timestamps ms (all callers)
    const streams = new Map() // credential key -> Set<end fn>
    const now = () => clock.now().getTime()
    const newToken = () => randomBytes(32).toString("hex")

    function prune(map) {
        const t = now()
        for (const [k, exp] of map) if (exp <= t) map.delete(k)
    }

    function bearerFrom(req) {
        const h = req.headers.authorization
        if (!h || typeof h !== "string") return null
        const m = /^Bearer\s+(\S+)\s*$/i.exec(h)
        return m ? m[1] : null
    }

    function checkSession(raw) {
        if (!raw) return false
        const key = sha256(raw)
        const exp = sessions.get(key)
        if (!exp) return false
        if (exp <= now()) {
            sessions.delete(key)
            return false
        }
        return true
    }

    async function findDevice(raw) {
        if (!raw) return null
        const device = await devicesRepo.findByTokenHash(sha256(raw))
        if (!device || device.revoked_at) return null
        try {
            await devicesRepo.touch(device.id)
        } catch (err) {
            log?.warn?.({ err: err.message }, "device touch failed")
        }
        return device
    }

    const deviceKey = (id) => `device:${id}`
    const sessionKey = (hash) => `session:${hash}`

    /**
     * Resolve the caller's identity for a listener mode.
     * @returns {Promise<{role: "owner"|"viewer"|null, login: string|null,
     *           via: "bearer"|"session"|"device"|"header"|null, device?: object,
     *           credential?: string, tokenHash?: string}>}
     *   credential: stream-registry key of a revocable credential;
     *   tokenHash: sha256 of that credential (server-side only, never sent).
     */
    async function resolve(req, mode) {
        const cookies = parseCookies(req.headers.cookie)
        if (mode === "local") {
            // Tailscale headers are ignored here on purpose.
            const bearer = bearerFrom(req)
            if (bearer && safeEqual(bearer, token))
                return { role: "owner", login: null, via: "bearer" }
            const session = cookies[SESSION_COOKIE]
            if (checkSession(session)) {
                const hash = sha256(session)
                return {
                    role: "owner",
                    login: null,
                    via: "session",
                    credential: sessionKey(hash),
                    tokenHash: hash,
                }
            }
            return { role: null, login: null, via: null }
        }
        if (mode === "tailnet") {
            const raw = req.headers["tailscale-user-login"]
            const login = typeof raw === "string" ? raw.trim() : ""
            if (!login) return { role: null, login: null, via: null }
            if (ownerLogin && safeEqual(login, ownerLogin)) {
                // A paired device is still recognised (its push
                // subscriptions follow it and revoking it ends its
                // streams), but the owner login alone is enough.
                const raw = cookies[DEVICE_COOKIE]
                const device = await findDevice(raw)
                if (device)
                    return {
                        role: "owner",
                        login,
                        via: "device",
                        device,
                        credential: deviceKey(device.id),
                        tokenHash: sha256(raw),
                    }
                return { role: "owner", login, via: "header" }
            }
            return { role: "viewer", login, via: "header" }
        }
        return { role: null, login: null, via: null }
    }

    /** New local owner session; returns the raw cookie value. */
    function createSession() {
        prune(sessions)
        const raw = newToken()
        sessions.set(sha256(raw), now() + SESSION_TTL_MS)
        return raw
    }

    function revokeSession(raw) {
        if (!raw) return
        const hash = sha256(raw)
        sessions.delete(hash)
        endStreams(sessionKey(hash))
    }

    /**
     * Register a live stream for the caller's credential. Returns an
     * unregister function. Callers without a revocable credential (bearer,
     * header-only viewers) are not tracked.
     */
    function trackStream(who, end) {
        const key = who && who.credential
        if (!key) return () => {}
        let set = streams.get(key)
        if (!set) streams.set(key, (set = new Set()))
        set.add(end)
        return () => {
            set.delete(end)
            if (!set.size && streams.get(key) === set) streams.delete(key)
        }
    }

    function endStreams(key) {
        const set = streams.get(key)
        if (!set) return 0
        streams.delete(key)
        for (const end of set) {
            try {
                end()
            } catch (err) {
                log?.warn?.({ err: err.message }, "ending stream failed")
            }
        }
        return set.size
    }

    /** End live streams of a revoked device (call after devicesRepo.revoke). */
    function endDeviceStreams(id) {
        return endStreams(deviceKey(id))
    }

    /** Is the credential behind a resolve() result still good? */
    async function stillValid(who) {
        if (!who || !who.role) return false
        if (who.via === "session") {
            const exp = sessions.get(who.tokenHash)
            return Boolean(exp && exp > now())
        }
        if (who.via === "device") {
            const device = await devicesRepo.findByTokenHash(who.tokenHash)
            return Boolean(
                device &&
                !device.revoked_at &&
                String(device.id) === String(who.device.id)
            )
        }
        return true
    }

    /** One-time bootstrap token (2 min) for `cc open`. */
    function createBootstrapToken() {
        prune(bootstrapTokens)
        const raw = newToken()
        bootstrapTokens.set(sha256(raw), now() + BOOTSTRAP_TTL_MS)
        return { token: raw, expires_at: new Date(now() + BOOTSTRAP_TTL_MS) }
    }

    /** Consume a bootstrap token. Single use. */
    function consumeBootstrapToken(raw) {
        if (!raw || typeof raw !== "string") return false
        const key = sha256(raw)
        const exp = bootstrapTokens.get(key)
        bootstrapTokens.delete(key)
        return Boolean(exp && exp > now())
    }

    /**
     * Owner: a 6-digit pairing code (10 min, single use, stored hashed).
     * Supersedes any earlier code and resets its failure count.
     */
    async function createPairCode() {
        const code = String(randomInt(0, 1000000)).padStart(6, "0")
        const expiresMs = now() + PAIR_CODE_TTL_MS
        const expiresAt = new Date(expiresMs).toISOString()
        const hash = sha256(code)
        await devicesRepo.pairCodes.add(hash, expiresAt)
        const previous = activeCode
        activeCode = { hash, expiresAt: expiresMs, failures: 0 }
        if (previous) await burnCode(previous)
        return { code, expires_at: expiresAt }
    }

    /** Mark a superseded / exhausted code used in the repo (best effort). */
    async function burnCode(entry) {
        try {
            await devicesRepo.pairCodes.consume(entry.hash)
        } catch (err) {
            log?.warn?.({ err: err.message }, "pair code invalidation failed")
        }
    }

    function recentGlobalFailures() {
        const t = now()
        pairFailures = pairFailures.filter((at) => at > t - PAIR_WINDOW_MS)
        return pairFailures.length
    }

    const rateLimited = () =>
        new AppError("rate_limited", "too many pairing attempts", {
            status: 429,
        })

    /**
     * Tailnet pairing: login must be the owner and the code must be the
     * active (latest, unexpired, not exhausted) one.
     * @returns {Promise<{ device, token }>} raw token goes into cc_device.
     */
    async function pair({ code, name, login }) {
        if (!login || !ownerLogin || !safeEqual(login, ownerLogin))
            throw new ForbiddenError("pairing requires the owner login")
        const locked = recentGlobalFailures() >= PAIR_GLOBAL_MAX_FAILURES
        let active = activeCode
        if (active && active.expiresAt <= now()) active = activeCode = null
        // Under the global cap only a code nobody has missed yet is checked.
        if (locked && (!active || active.failures > 0)) throw rateLimited()
        const matches =
            Boolean(active) &&
            typeof code === "string" &&
            /^\d{6}$/.test(code) &&
            safeEqual(sha256(code), active.hash)
        const ok = matches && (await devicesRepo.pairCodes.consume(active.hash))
        if (!ok) {
            pairFailures.push(now())
            if (active && activeCode === active) {
                active.failures++
                if (active.failures >= PAIR_MAX_FAILURES || locked) {
                    activeCode = null
                    await burnCode(active)
                    log?.warn?.({}, "pairing code invalidated after failures")
                }
            }
            if (locked || recentGlobalFailures() >= PAIR_GLOBAL_MAX_FAILURES)
                throw rateLimited()
            throw new ValidationError("invalid or expired pairing code")
        }
        if (activeCode === active) activeCode = null
        const raw = newToken()
        const device = await devicesRepo.add({
            name: name || "device",
            tokenHash: sha256(raw),
        })
        log?.info?.({ device_id: device && device.id }, "device paired")
        return { device: publicDevice(device), token: raw }
    }

    return {
        resolve,
        createSession,
        revokeSession,
        trackStream,
        endDeviceStreams,
        stillValid,
        createBootstrapToken,
        consumeBootstrapToken,
        createPairCode,
        pair,
        localToken: () => token,
    }
}
