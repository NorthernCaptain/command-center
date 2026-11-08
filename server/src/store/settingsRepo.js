/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// settings table: runtime-switchable settings stored as JSON values.

import { ValidationError } from "../util/errors.js"
import { parseJson } from "./db.js"

// eslint-disable-next-line no-unused-vars
export function createSettingsRepo(db, { clock } = {}) {
    const st = {
        get: db.prepare("SELECT value_json FROM settings WHERE key = ?"),
        set: db.prepare(
            `INSERT INTO settings (key, value_json) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
        ),
        all: db.prepare("SELECT key, value_json FROM settings ORDER BY key"),
    }

    return {
        get(key, fallback = null) {
            const row = st.get.get(String(key))
            return row ? parseJson(row.value_json, fallback) : fallback
        },
        set(key, value) {
            if (!key || typeof key !== "string")
                throw new ValidationError("setting key must be a string")
            if (value === undefined)
                throw new ValidationError("setting value is required")
            st.set.run(key, JSON.stringify(value))
            return value
        },
        all() {
            const out = {}
            for (const row of st.all.all())
                out[row.key] = parseJson(row.value_json, null)
            return out
        },
    }
}
