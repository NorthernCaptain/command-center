/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Desktop notifications: herdr first (shows inside the terminal UI), then
// macOS `osascript display notification` as a fallback. Never throws.
// When a Web Push sender is wired (phase3/push.js) and the runtime setting
// `push.enabled` is true, every notification is also fanned out to the
// paired phones; push failures never affect the local notification.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { nullLogger } from "../util/logger.js"

const SOUNDS = ["request", "done", "none"]
const EXEC_TIMEOUT_MS = 5000

/** Default exec: execFile without a shell, rejects on non-zero exit. */
const execFileAsync = promisify(execFile)
export function defaultExec(file, args) {
    return execFileAsync(file, args, { timeout: EXEC_TIMEOUT_MS })
}

/** Escape a value for an AppleScript double-quoted string literal. */
export function appleScriptString(value) {
    const s = String(value ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r\n?|\n/g, " ")
    return `"${s}"`
}

/**
 * @param {{ exec?: (file: string, args: string[]) => Promise<unknown>,
 *           log?: object, push?: { sendAll: Function } | null,
 *           settingsRepo?: { get: Function } | null }} deps
 *   push may also be bound later with setPush() (created after the notifier).
 */
export function createNotifier({
    exec = defaultExec,
    log = nullLogger,
    push = null,
    settingsRepo = null,
} = {}) {
    let pushSender = push
    let settings = settingsRepo
    // every push fan-out still running (not just the latest)
    const inflight = new Set()
    let pending = Promise.resolve()

    async function pushEnabled() {
        if (!pushSender || !settings) return false
        return (await settings.get("push.enabled", false)) === true
    }

    /** Fan out to Web Push in the background; never throws. */
    function fanOut(title, body, url) {
        const run = async () => {
            try {
                if (!(await pushEnabled())) return
                await pushSender.sendAll({ title, body, url })
            } catch (err) {
                log.warn({ err: err?.message }, "push notification failed")
            }
        }
        const p = run()
        inflight.add(p)
        p.finally(() => inflight.delete(p))
        pending = p
        return p
    }

    async function tryHerdr(title, body, sound) {
        // --opt=value and "--" keep values starting with "-" from being
        // read as flags.
        const args = ["notification", "show"]
        if (body) args.push(`--body=${body}`)
        args.push(`--sound=${sound}`, "--", title)
        await exec("herdr", args)
    }

    async function tryOsascript(title, body, sound) {
        let script =
            `display notification ${appleScriptString(body || title)}` +
            ` with title ${appleScriptString(title)}`
        if (sound !== "none") script += ` sound name "Glass"`
        await exec("osascript", ["-e", script])
    }

    async function notify({
        title,
        body = "",
        sound = "request",
        url = null,
    } = {}) {
        const t = String(title ?? "").trim() || "Command Center"
        const b = String(body ?? "")
        const s = SOUNDS.includes(sound) ? sound : "none"
        fanOut(t, b, url || "/")
        try {
            await tryHerdr(t, b, s)
            return true
        } catch (err) {
            log.debug({ err: err?.message }, "herdr notification failed")
        }
        try {
            await tryOsascript(t, b, s)
            return true
        } catch (err) {
            log.warn({ err: err?.message }, "osascript notification failed")
            return false
        }
    }

    /** Late binding of the Web Push sender ({ sendAll }) and, optionally,
     *  the settings repo that holds push.enabled. */
    function setPush(p, settingsRepoOverride) {
        pushSender = p || null
        if (settingsRepoOverride) settings = settingsRepoOverride
    }

    /** Resolves when the latest push fan-out finished (tests). */
    function flushPush() {
        return pending
    }

    /** Resolves when EVERY push fan-out started so far has finished
     *  (shutdown: call after notification producers stopped, before the
     *  database is closed). */
    async function drainPush() {
        while (inflight.size) await Promise.allSettled([...inflight])
    }

    return { notify, setPush, flushPush, drainPush }
}
