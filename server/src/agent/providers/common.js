/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Shared provider helpers: limit detection, error construction, Claude
// message-stream interpretation (SDK and `claude -p --output-format
// stream-json` emit the same message shapes) and a child-process runner.

import { StringDecoder } from "node:string_decoder"
import { AppError, LimitError } from "../../util/errors.js"
import { systemClock } from "../../util/clock.js"

const LIMIT_RE =
    /(rate[ _-]?limit|usage[ _-]?limit|limit (reached|exceeded)|hit your .{0,30}limit|quota|insufficient[_ ]quota|out of (credits|extra usage)|credit balance|billing|too many requests|\b429\b)/i

/** Heuristic for usage/credit/rate-limit failures in free text. */
export function looksLikeLimit(text) {
    return LIMIT_RE.test(String(text || ""))
}

export function providerFailed(message, details) {
    return new AppError("provider_failed", message, { status: 502, details })
}

export function abortedError(provider) {
    return new AppError("cancelled", `${provider}: aborted`, { status: 499 })
}

export function timeoutError(provider, ms) {
    return providerFailed(`${provider}: timed out after ${ms} ms`)
}

/** Call onDelta without letting a listener failure break the provider. */
export function safeDelta(onDelta, text) {
    if (!onDelta || !text) return
    try {
        onDelta(text)
    } catch {
        // best effort
    }
}

/** Text of a streaming delta event (text or structured-output JSON). */
export function deltaText(event) {
    if (!event || event.type !== "content_block_delta" || !event.delta)
        return null
    if (event.delta.type === "text_delta") return event.delta.text || null
    if (event.delta.type === "input_json_delta")
        return event.delta.partial_json || null
    return null
}

const LIMIT_ERRORS = new Set(["rate_limit", "billing_error"])

/**
 * Watches Claude SDK/CLI messages. feed(m) for each message, then finish()
 * returns { output, usage } or throws LimitError / AppError.
 */
export function createClaudeCollector({ provider, onDelta }) {
    let result = null
    let limitHint = null
    let assistantError = null
    return {
        feed(m) {
            if (!m || typeof m !== "object") return
            if (m.type === "stream_event") {
                safeDelta(onDelta, deltaText(m.event))
            } else if (m.type === "assistant" && m.error) {
                assistantError = m.error
                if (LIMIT_ERRORS.has(m.error)) limitHint = m.error
            } else if (
                m.type === "rate_limit_event" &&
                m.rate_limit_info &&
                m.rate_limit_info.status === "rejected"
            ) {
                const info = m.rate_limit_info
                limitHint = `rate limit rejected (${info.rateLimitType || "unknown"}${
                    info.resetsAt
                        ? `, resets ${new Date(info.resetsAt * 1000).toISOString()}`
                        : ""
                })`
            } else if (m.type === "result") {
                result = m
            }
        },
        finish() {
            if (!result) {
                if (limitHint) throw new LimitError(`${provider}: ${limitHint}`)
                throw providerFailed(`${provider}: no result message`)
            }
            if (result.subtype === "success" && !result.is_error) {
                let output = result.structured_output
                if (output === undefined && typeof result.result === "string") {
                    try {
                        output = JSON.parse(result.result)
                    } catch {
                        output = undefined
                    }
                }
                if (!output || typeof output !== "object") {
                    throw providerFailed(`${provider}: no structured output`)
                }
                return { output, usage: claudeUsage(result) }
            }
            const text = [
                result.subtype,
                result.result,
                ...(Array.isArray(result.errors) ? result.errors : []),
                result.terminal_reason,
                assistantError,
            ]
                .filter(Boolean)
                .join("; ")
            if (
                limitHint ||
                LIMIT_ERRORS.has(assistantError) ||
                result.api_error_status === 429 ||
                looksLikeLimit(text)
            ) {
                throw new LimitError(`${provider}: ${limitHint || text}`)
            }
            throw providerFailed(`${provider}: ${text}`)
        },
    }
}

function claudeUsage(result) {
    const u = result.usage || {}
    return {
        input_tokens: u.input_tokens ?? null,
        output_tokens: u.output_tokens ?? null,
        cache_read_input_tokens: u.cache_read_input_tokens ?? null,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
        cost_usd: result.total_cost_usd ?? null,
        duration_ms: result.duration_ms ?? null,
        num_turns: result.num_turns ?? null,
    }
}

// Live child process groups (pid -> kill(sig)), so a shutdown can signal
// every CLI child even though detached children no longer share our group
// (Ctrl-C / launchd stop would otherwise orphan them).
const liveGroups = new Map()

/** Number of child process groups runProcess currently has running. */
export function liveProcessCount() {
    return liveGroups.size
}

/**
 * Last-resort kill: signal every live child process group (default
 * SIGKILL). Normal shutdown aborts jobs instead (runner.stop()); this is
 * for whatever is still alive after that, and runs on process 'exit'.
 * @returns {number} groups signalled
 */
export function killAll(signal = "SIGKILL") {
    let n = 0
    for (const kill of [...liveGroups.values()]) {
        kill(signal)
        n++
    }
    return n
}

let exitHookInstalled = false
function installExitHook() {
    if (exitHookInstalled) return
    exitHookInstalled = true
    // 'exit' handlers must be synchronous; process.kill is.
    process.once("exit", () => killAll("SIGKILL"))
}

/**
 * Run a child process with timeout/abort. stdin: string to write (the stream
 * is ended right after), or null for /dev/null ("ignore"). onLine is called
 * for each complete stdout line.
 *
 * The child is spawned detached (its own process group) so timeout/abort can
 * signal the whole group (`process.kill(-pid)`), including grandchildren
 * that would otherwise keep the pipes open. Escalation: SIGTERM, then SIGKILL
 * after killGraceMs; if the process still has not been reaped by then the
 * promise settles anyway, so a lane slot / temp dir is never held forever.
 * Settling happens on 'close', or on 'exit' + drainMs when a straggler keeps
 * stdout/stderr open (the straggling group is then killed).
 * While running, the group is in a module-level registry (see killAll).
 * @returns {Promise<{ code, signal, stdout, stderr, timedOut, aborted,
 *                     forced }>}
 */
export function runProcess({
    spawn,
    bin,
    args,
    stdin = null,
    cwd,
    env,
    signal,
    timeoutMs,
    clock = systemClock,
    onLine,
    maxBytes = 8 * 1024 * 1024,
    killGraceMs = 5000,
    drainMs = 500,
    killProcess = (pid, sig) => process.kill(pid, sig),
}) {
    return new Promise((resolve, reject) => {
        let child
        try {
            child = spawn(bin, args, {
                cwd,
                env,
                detached: true,
                stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
            })
        } catch (err) {
            reject(providerFailed(`failed to start ${bin}: ${err.message}`))
            return
        }
        let stdout = ""
        let stderr = ""
        let pending = ""
        let timedOut = false
        let aborted = false
        let settled = false
        let exited = null // { code, sig } once 'exit' fired
        let graceTimer = null
        let drainTimer = null

        /** Signal the process group (fallback: the direct child). */
        const kill = (sig) => {
            if (child.pid) {
                try {
                    killProcess(-child.pid, sig)
                    return
                } catch {
                    // no such group (already gone) or not a group leader
                }
            }
            try {
                child.kill(sig)
            } catch {
                // already gone
            }
        }
        if (child.pid) {
            liveGroups.set(child.pid, kill)
            installExitHook()
        }
        const stopping = () => {
            kill("SIGTERM")
            if (graceTimer != null || !(killGraceMs > 0)) return
            graceTimer = clock.setTimeout(() => {
                graceTimer = null
                kill("SIGKILL")
                finish(
                    exited ? exited.code : null,
                    exited ? exited.sig : "SIGKILL",
                    true
                )
            }, killGraceMs)
        }
        const timer =
            timeoutMs > 0
                ? clock.setTimeout(() => {
                      timedOut = true
                      stopping()
                  }, timeoutMs)
                : null
        const onAbort = () => {
            aborted = true
            stopping()
        }
        const cleanup = () => {
            if (timer != null) clock.clearTimeout(timer)
            if (graceTimer != null) clock.clearTimeout(graceTimer)
            if (drainTimer != null) clock.clearTimeout(drainTimer)
            graceTimer = null
            drainTimer = null
            if (signal) signal.removeEventListener("abort", onAbort)
        }
        const done = (fn) => {
            if (settled) return
            settled = true
            cleanup()
            if (liveGroups.get(child.pid) === kill) liveGroups.delete(child.pid)
            fn()
        }
        const finish = (code, sig, forced = false) =>
            done(() => {
                if (forced) {
                    // Stop reading from pipes a straggler may still hold.
                    child.stdout?.destroy?.()
                    child.stderr?.destroy?.()
                }
                if (onLine && pending.trim()) onLine(pending)
                resolve({
                    code,
                    signal: sig,
                    stdout,
                    stderr,
                    timedOut,
                    aborted,
                    forced,
                })
            })
        if (signal) {
            if (signal.aborted) onAbort()
            else signal.addEventListener("abort", onAbort, { once: true })
        }
        // One decoder per stream: a multi-byte UTF-8 character split across
        // two chunks is joined instead of turning into U+FFFD.
        const outDecoder = new StringDecoder("utf8")
        const errDecoder = new StringDecoder("utf8")
        child.stdout.on("data", (buf) => {
            const s = typeof buf === "string" ? buf : outDecoder.write(buf)
            if (stdout.length < maxBytes) stdout += s
            if (!onLine) return
            pending += s
            let idx
            while ((idx = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, idx)
                pending = pending.slice(idx + 1)
                if (line.trim()) onLine(line)
            }
        })
        child.stderr.on("data", (buf) => {
            const s = typeof buf === "string" ? buf : errDecoder.write(buf)
            if (stderr.length < maxBytes) stderr += s
        })
        child.on("error", (err) =>
            done(() =>
                reject(providerFailed(`failed to run ${bin}: ${err.message}`))
            )
        )
        child.on("exit", (code, sig) => {
            exited = { code, sig }
            if (settled || drainTimer != null) return
            // Normally 'close' follows right away. If a grandchild keeps the
            // pipes open, give it drainMs, then kill the group and settle.
            drainTimer = clock.setTimeout(() => {
                drainTimer = null
                kill("SIGKILL")
                finish(code, sig, true)
            }, drainMs)
        })
        child.on("close", (code, sig) =>
            finish(exited ? exited.code : code, exited ? exited.sig : sig)
        )
        if (stdin != null && child.stdin) {
            child.stdin.on("error", () => {})
            child.stdin.end(stdin)
        }
    })
}

/** Last n characters of process output for error messages. */
export function tail(text, n = 600) {
    const s = String(text || "").trim()
    return s.length > n ? `…${s.slice(-n)}` : s
}
