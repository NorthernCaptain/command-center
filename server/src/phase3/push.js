/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Web Push to paired phones. VAPID keys are created on first start in
// config.push.vapidFile (mode 0600, never overwritten: a new key pair would
// orphan every subscription). Subscriptions live in SQLite
// (push_subscriptions); endpoints that answer 404/410 are dropped.
// A subscription made from a paired phone records its device id; once that
// device is revoked (or gone) the subscription is deleted before any send,
// so a lost phone stops receiving task notifications. removeForDevice() is
// called from the device-revocation route as well.

import nodeFs from "node:fs"
import path from "node:path"
import webPushModule from "web-push"
import { z } from "zod"
import { systemClock } from "../util/clock.js"
import { nullLogger } from "../util/logger.js"
import { AppError, ValidationError } from "../util/errors.js"

const KEY_RE = /^[A-Za-z0-9_-]+=*$/
const SEND_TIMEOUT_MS = 10000
const TTL_SECONDS = 6 * 3600
const GONE = [404, 410]

export const SubscriptionSchema = z.object({
    endpoint: z
        .string()
        .max(2048)
        .url()
        .refine((u) => u.startsWith("https://"), "endpoint must be https"),
    keys: z.object({
        p256dh: z.string().min(1).max(512).regex(KEY_RE),
        auth: z.string().min(1).max(512).regex(KEY_RE),
    }),
})

const VapidSchema = z.object({
    publicKey: z.string().min(1).regex(KEY_RE),
    privateKey: z.string().min(1).regex(KEY_RE),
})

/**
 * @param {{ db: object, config: { vapidFile: string, subject: string },
 *           devicesRepo?: { get: Function }, fs?: object, webpush?: object,
 *           clock?: object, log?: object }} deps
 *   config is config.push; webpush is the `web-push` module (injectable).
 *   Without devicesRepo, device-bound subscriptions are never sent to
 *   (their device cannot be checked).
 */
export function createPush({
    db,
    config,
    devicesRepo = null,
    fs = nodeFs,
    webpush = webPushModule,
    clock = systemClock,
    log = nullLogger,
}) {
    let keys = null
    const st = {
        upsert: db.prepare(
            `INSERT INTO push_subscriptions (endpoint, device_id, keys_json, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id,
                 keys_json = excluded.keys_json, failures = 0`
        ),
        remove: db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?"),
        removeDevice: db.prepare(
            "DELETE FROM push_subscriptions WHERE device_id = ?"
        ),
        all: db.prepare(
            "SELECT * FROM push_subscriptions ORDER BY created_at, endpoint"
        ),
        ok: db.prepare(
            "UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE endpoint = ?"
        ),
        fail: db.prepare(
            "UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?"
        ),
    }

    function readKeys(file) {
        const parsed = VapidSchema.safeParse(
            JSON.parse(fs.readFileSync(file, "utf8"))
        )
        if (!parsed.success) throw new Error(`invalid VAPID key file ${file}`)
        // Tighten a file someone loosened by hand.
        const mode = fs.statSync(file).mode & 0o777
        if (mode !== 0o600) fs.chmodSync(file, 0o600)
        return parsed.data
    }

    /** Load the VAPID keys, creating them (0600) on first start. */
    function init() {
        if (keys) return { publicKey: keys.publicKey }
        const file = config.vapidFile
        try {
            keys = readKeys(file)
        } catch (err) {
            if (err.code !== "ENOENT") throw err
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
            const fresh = webpush.generateVAPIDKeys()
            const data = {
                publicKey: fresh.publicKey,
                privateKey: fresh.privateKey,
            }
            try {
                // wx: never clobber keys another process just wrote.
                fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", {
                    mode: 0o600,
                    flag: "wx",
                })
                keys = data
                log.info({ file }, "created VAPID keys")
            } catch (err2) {
                if (err2.code !== "EEXIST") throw err2
                keys = readKeys(file)
            }
        }
        return { publicKey: keys.publicKey }
    }

    function publicKey() {
        return init().publicKey
    }

    /** Add or refresh a browser subscription ({ endpoint, keys }). */
    function subscribe(raw, { deviceId = null } = {}) {
        const parsed = SubscriptionSchema.safeParse(raw)
        if (!parsed.success)
            throw new ValidationError("invalid push subscription", {
                issues: parsed.error.issues,
            })
        const sub = parsed.data
        st.upsert.run(
            sub.endpoint,
            deviceId,
            JSON.stringify(sub.keys),
            clock.now().toISOString()
        )
        return { endpoint: sub.endpoint }
    }

    /** Remove a subscription; true when one existed. */
    function unsubscribe(endpoint) {
        if (typeof endpoint !== "string" || !endpoint)
            throw new ValidationError("endpoint is required")
        return st.remove.run(endpoint).changes > 0
    }

    /** Drop every subscription of a device (revoked phone). */
    function removeForDevice(deviceId) {
        if (deviceId === null || deviceId === undefined || deviceId === "")
            return 0
        return st.removeDevice.run(String(deviceId)).changes
    }

    /**
     * Check a device once per send: "ok", "revoked" (its subscriptions are
     * deleted; `removed` = how many) or "unverifiable" (no devicesRepo).
     */
    function deviceState(deviceId) {
        if (!devicesRepo) return { state: "unverifiable" }
        const device = devicesRepo.get(deviceId)
        if (device && !device.revoked_at) return { state: "ok" }
        const removed = removeForDevice(deviceId)
        log.info(
            { device_id: deviceId, removed },
            "push subscriptions of a revoked device removed"
        )
        return { state: "revoked", removed }
    }

    function list() {
        return st.all.all().map((r) => ({
            endpoint: r.endpoint,
            device_id: r.device_id,
            created_at: r.created_at,
            last_ok_at: r.last_ok_at,
            failures: r.failures,
        }))
    }

    async function sendOne(row, payload, vapidDetails) {
        let subKeys
        try {
            subKeys = JSON.parse(row.keys_json)
        } catch {
            st.remove.run(row.endpoint)
            return "removed"
        }
        try {
            await webpush.sendNotification(
                { endpoint: row.endpoint, keys: subKeys },
                payload,
                { vapidDetails, TTL: TTL_SECONDS, timeout: SEND_TIMEOUT_MS }
            )
            st.ok.run(clock.now().toISOString(), row.endpoint)
            return "sent"
        } catch (err) {
            if (GONE.includes(err && err.statusCode)) {
                st.remove.run(row.endpoint)
                log.info(
                    { status: err.statusCode },
                    "push subscription gone, removed"
                )
                return "removed"
            }
            st.fail.run(row.endpoint)
            log.warn(
                { err: err && err.message, status: err && err.statusCode },
                "push send failed"
            )
            return "failed"
        }
    }

    /**
     * Send { title, body, url } to every subscription.
     * @returns {Promise<{ sent: number, removed: number, failed: number,
     *           skipped: number }>}
     */
    async function sendAll({ title, body = "", url = "/" } = {}) {
        const result = { sent: 0, removed: 0, failed: 0, skipped: 0 }
        const rows = []
        const devices = new Map()
        for (const row of st.all.all()) {
            if (!row.device_id) {
                rows.push(row)
                continue
            }
            let check = devices.get(row.device_id)
            if (!check) {
                check = deviceState(row.device_id)
                devices.set(row.device_id, check)
                if (check.state === "revoked") result.removed += check.removed
            }
            if (check.state === "ok") rows.push(row)
            else if (check.state === "unverifiable") result.skipped++
        }
        if (!rows.length) return result
        init()
        if (!config.subject)
            throw new AppError("not_configured", "push.subject is not set", {
                status: 503,
            })
        const payload = JSON.stringify({
            title: String(title ?? "Command Center"),
            body: String(body ?? ""),
            url: String(url || "/"),
        })
        const vapidDetails = {
            subject: config.subject,
            publicKey: keys.publicKey,
            privateKey: keys.privateKey,
        }
        const outcomes = await Promise.all(
            rows.map((r) => sendOne(r, payload, vapidDetails))
        )
        for (const o of outcomes) result[o]++
        return result
    }

    return {
        init,
        publicKey,
        subscribe,
        unsubscribe,
        removeForDevice,
        list,
        sendAll,
    }
}
