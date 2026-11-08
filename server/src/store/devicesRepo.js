/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// devices + pair_codes tables: paired tailnet devices (owner cookies) and
// single-use pairing codes. Only hashes are stored.

import crypto from "node:crypto"
import { ValidationError } from "../util/errors.js"
import { systemClock } from "../util/clock.js"
import { toUtcIso } from "./db.js"

/** Public device view (never includes the token hash). */
function toDevice(row) {
    if (!row) return null
    return {
        id: row.id,
        name: row.name,
        created_at: row.created_at,
        last_seen_at: row.last_seen_at,
        revoked_at: row.revoked_at,
    }
}

export function createDevicesRepo(db, { clock = systemClock } = {}) {
    const now = () => clock.now().toISOString()
    const st = {
        insert: db.prepare(
            `INSERT INTO devices (id, name, token_hash, created_at)
             VALUES (?, ?, ?, ?)`
        ),
        get: db.prepare("SELECT * FROM devices WHERE id = ?"),
        byHash: db.prepare(
            "SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL"
        ),
        touch: db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?"),
        list: db.prepare("SELECT * FROM devices ORDER BY created_at DESC, id"),
        revoke: db.prepare(
            `UPDATE devices SET revoked_at = ?
             WHERE id = ? AND revoked_at IS NULL`
        ),
        codeAdd: db.prepare(
            `INSERT INTO pair_codes (code_hash, expires_at) VALUES (?, ?)
             ON CONFLICT(code_hash) DO UPDATE
             SET expires_at = excluded.expires_at, used_at = NULL`
        ),
        codePurge: db.prepare(
            "DELETE FROM pair_codes WHERE expires_at <= ? OR used_at IS NOT NULL"
        ),
        codeConsume: db.prepare(
            `UPDATE pair_codes SET used_at = ?
             WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`
        ),
    }

    const pairCodes = {
        /** Store a hashed pairing code; expired/used codes are purged. */
        add(codeHash, expiresAt) {
            const exp = toUtcIso(expiresAt)
            if (!codeHash || !exp)
                throw new ValidationError("code hash and expiry are required")
            st.codePurge.run(now())
            st.codeAdd.run(String(codeHash), exp)
            return { code_hash: String(codeHash), expires_at: exp }
        },
        /** Single use and unexpired. Returns true when the code was valid. */
        consume(codeHash) {
            const t = now()
            return st.codeConsume.run(t, String(codeHash), t).changes === 1
        },
    }

    return {
        add({ name, tokenHash }) {
            if (!name || !tokenHash)
                throw new ValidationError("device name and tokenHash required")
            const id = `d_${crypto.randomBytes(8).toString("hex")}`
            st.insert.run(id, String(name).slice(0, 100), tokenHash, now())
            return toDevice(st.get.get(id))
        },
        /** Unrevoked device for a token hash, or null. */
        findByTokenHash(tokenHash) {
            return toDevice(st.byHash.get(String(tokenHash)))
        },
        get(id) {
            return toDevice(st.get.get(String(id)))
        },
        touch(id) {
            return st.touch.run(now(), String(id)).changes === 1
        },
        list() {
            return st.list.all().map(toDevice)
        },
        /** Returns true when an active device was revoked. */
        revoke(id) {
            return st.revoke.run(now(), String(id)).changes === 1
        },
        pairCodes,
    }
}
