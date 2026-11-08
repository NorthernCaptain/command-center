/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// macOS Keychain reader (`security find-generic-password ... -w`).
// The secret value is never logged and never placed in error messages.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { AppError } from "../util/errors.js"

// `security` exit status when the item does not exist.
const NOT_FOUND_EXIT = 44
const NOT_FOUND_RE = /could not be found/i

/** Default exec: promisified execFile -> { stdout, stderr }. */
export const defaultExec = promisify(execFile)

/**
 * @param {{ exec?: (cmd: string, args: string[]) => Promise<{stdout: string}|string>,
 *           log?: object }} deps
 */
export function createKeychain({ exec = defaultExec, log } = {}) {
    return {
        /**
         * Read a generic password. Returns the trimmed value, or null when
         * the item is missing or empty.
         * @param {string} service
         * @param {string} [account]
         * @returns {Promise<string|null>}
         */
        async get(service, account) {
            if (!service)
                throw new AppError("keychain_error", "service required")
            const args = ["find-generic-password", "-s", service]
            if (account) args.push("-a", account)
            args.push("-w")
            let out
            try {
                out = await exec("security", args)
            } catch (err) {
                const stderr = String(err?.stderr || "")
                if (err?.code === NOT_FOUND_EXIT || NOT_FOUND_RE.test(stderr)) {
                    log?.debug?.({ service }, "keychain item not found")
                    return null
                }
                throw new AppError(
                    "keychain_error",
                    `keychain lookup failed for service "${service}" ` +
                        `(exit ${err?.code ?? "unknown"})`,
                    { status: 500 }
                )
            }
            const raw = typeof out === "string" ? out : out?.stdout
            const value = String(raw ?? "").trim()
            return value || null
        },
    }
}
