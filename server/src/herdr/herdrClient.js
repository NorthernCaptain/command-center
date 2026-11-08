/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// herdr socket API client. One short-lived connection per request: a
// connection that ran `events.subscribe` only streams events, so requests and
// the event stream (herdrEvents.js) never share a socket.
//
// Wire format (herdr 0.9.5, protocol 22): newline-delimited JSON.
//   -> {"id","method","params"}
//   <- {"id","result":{...}} | {"id","error":{"code","message"}}

import net from "node:net"
import os from "node:os"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { AppError } from "../util/errors.js"
import { systemClock } from "../util/clock.js"
import { nullLogger } from "../util/logger.js"

export const HERDR_PROTOCOL = 22
export const DEFAULT_SOCKET_PATH = "~/.config/herdr/herdr.sock"
export const METADATA_SOURCE = "command-center"
// Extra time the socket waits beyond a server-side wait (prompt/start), so
// herdr's own timeout error arrives before ours.
const WAIT_GRACE_MS = 5000
// agent.start on a pane that is not at its shell prompt (yet)
const PANE_BUSY = "agent_pane_busy"
// herdr's agent.start timeout_ms must be above this
const MIN_START_MS = 3000

/**
 * herdr failure. `code` is herdr's error code (agent_not_found,
 * agent_not_ready, agent_blocked, agent_prompt_stalled, timeout, ...) or one
 * of ours: "timeout" (no answer in time), "socket" (connect/IO failure),
 * "protocol" (unexpected reply).
 */
export class HerdrError extends AppError {
    constructor(code, message, { method, details, cause } = {}) {
        super(code, message, {
            status: code === "timeout" ? 504 : 502,
            details,
        })
        this.name = "HerdrError"
        this.method = method
        if (cause) this.cause = cause
    }
}

/** Expand a leading "~/" to the home directory. */
export function expandHome(p, home = os.homedir()) {
    if (p === "~") return home
    if (typeof p === "string" && p.startsWith("~/"))
        return path.join(home, p.slice(2))
    return p
}

/**
 * Normalize herdr's AgentInfo.
 * -> { name, kind, status, sessionId, paneId, workspaceId, cwd }
 */
export function toAgentInfo(a) {
    if (!a || typeof a !== "object") return null
    return {
        name: a.name ?? null,
        kind: a.agent ?? null,
        status: a.agent_status ?? "unknown",
        sessionId: a.agent_session?.value ?? null,
        paneId: a.pane_id ?? null,
        workspaceId: a.workspace_id ?? null,
        cwd: a.cwd ?? null,
    }
}

/**
 * Is a raw herdr AgentInfo ready for a prompt? herdr marks it with
 * interactive_ready (launch_pending while the agent is still coming up);
 * a server without those fields counts idle/done as ready.
 */
export function agentReady(a, name) {
    if (!a || typeof a !== "object") return false
    if (name && a.name && a.name !== name) return false
    if (a.launch_pending === true) return false
    if (typeof a.interactive_ready === "boolean") return a.interactive_ready
    return a.agent_status === "idle" || a.agent_status === "done"
}

/** Id of a herdr object that may be a string or { <key> | id }. */
function idOf(obj, key) {
    if (typeof obj === "string") return obj
    if (!obj || typeof obj !== "object") return null
    return obj[key] ?? obj.id ?? null
}

/** Split a byte stream into JSON lines. onLine(msg) gets parsed objects. */
export function createLineParser(onLine, onBadLine) {
    const decoder = new StringDecoder("utf8")
    let buf = ""
    function drain(final) {
        let i
        while ((i = buf.indexOf("\n")) >= 0 || (final && buf.length)) {
            const raw = i >= 0 ? buf.slice(0, i) : buf
            buf = i >= 0 ? buf.slice(i + 1) : ""
            const line = raw.trim()
            if (!line) continue
            let msg
            try {
                msg = JSON.parse(line)
            } catch {
                if (onBadLine(line) === false) return
                continue
            }
            if (onLine(msg) === false) return
        }
    }
    return {
        push(chunk) {
            buf += typeof chunk === "string" ? chunk : decoder.write(chunk)
            drain(false)
        },
        end() {
            buf += decoder.end()
            drain(true)
        },
    }
}

/**
 * createHerdrClient({ socketPath, connect, log, timeoutMs, clock,
 *                     startTimeoutMs, promptTimeoutMs, readyPollMs })
 * `connect(path)` returns a net.Socket-like duplex (tests inject fakes).
 */
export function createHerdrClient({
    socketPath = DEFAULT_SOCKET_PATH,
    connect = net.createConnection,
    log = nullLogger,
    timeoutMs = 15000,
    clock = systemClock,
    startTimeoutMs = 60000,
    promptTimeoutMs = 120000,
    readyPollMs = 500,
} = {}) {
    const sockPath = expandHome(socketPath)
    let seq = 0

    /** request(method, params, { timeoutMs }?) -> Promise<result> */
    function request(method, params = {}, opts = {}) {
        const limit = opts.timeoutMs ?? timeoutMs
        const id = `cc-${process.pid}-${++seq}`
        const started = Date.now()
        return new Promise((resolve, reject) => {
            let done = false
            let socket = null
            let timer = null
            const finish = (err, result) => {
                if (done) return
                done = true
                clock.clearTimeout(timer)
                try {
                    socket?.destroy()
                } catch {
                    // already gone
                }
                log.debug(
                    { method, ms: Date.now() - started, error: err?.code },
                    "herdr request"
                )
                if (err) reject(err)
                else resolve(result)
            }
            const fail = (code, message, extra = {}) =>
                finish(new HerdrError(code, message, { method, ...extra }))

            timer = clock.setTimeout(
                () =>
                    fail(
                        "timeout",
                        `herdr ${method} timed out after ${limit}ms`
                    ),
                limit
            )
            const parser = createLineParser(
                (msg) => {
                    if (!msg || msg.id !== id) return true
                    if (msg.error) {
                        const code = msg.error.code || "herdr_error"
                        fail(code, msg.error.message || code, {
                            details: msg.error,
                        })
                    } else finish(null, msg.result ?? {})
                    return false
                },
                (line) => {
                    fail(
                        "protocol",
                        `invalid JSON from herdr: ${line.slice(0, 200)}`
                    )
                    return false
                }
            )
            try {
                socket = connect(sockPath)
                socket.on("data", (chunk) => parser.push(chunk))
                socket.on("error", (e) =>
                    fail("socket", `herdr socket error: ${e.message}`, {
                        cause: e,
                    })
                )
                socket.on("close", () => {
                    parser.end()
                    fail(
                        "socket",
                        `herdr closed the connection before answering ${method}`
                    )
                })
                socket.write(JSON.stringify({ id, method, params }) + "\n")
            } catch (e) {
                fail("socket", `herdr connect failed: ${e.message}`, {
                    cause: e,
                })
            }
        })
    }

    return {
        request,
        socketPath: sockPath,

        /** -> { version, protocol }; throws HerdrError("protocol") on mismatch. */
        async ping() {
            const r = await request("ping", {})
            if (r.protocol !== HERDR_PROTOCOL)
                throw new HerdrError(
                    "protocol",
                    `herdr protocol ${r.protocol} (version ${r.version}) is not supported; expected ${HERDR_PROTOCOL}`,
                    { method: "ping", details: r }
                )
            return { version: r.version, protocol: r.protocol }
        },

        /** -> { workspaceId, tabId, paneId } */
        async workspaceCreate({ cwd, label, env, focus = false } = {}) {
            const r = await request("workspace.create", {
                cwd,
                env,
                focus,
                label,
            })
            const workspaceId = idOf(r.workspace, "workspace_id")
            const tabId = idOf(r.tab, "tab_id")
            const paneId = idOf(r.root_pane, "pane_id")
            if (!workspaceId || !paneId)
                throw new HerdrError(
                    "protocol",
                    "workspace.create returned no workspace/pane id",
                    { method: "workspace.create", details: r }
                )
            return { workspaceId, tabId, paneId }
        },

        workspaceClose(workspaceId) {
            return request("workspace.close", { workspace_id: workspaceId })
        },

        /** tokens: { key: string|null }, shown in the herdr sidebar. */
        reportMetadata(workspaceId, tokens, { ttlMs } = {}) {
            const clean = {}
            for (const [k, v] of Object.entries(tokens || {}))
                clean[k] = v === null || v === undefined ? null : String(v)
            const params = {
                workspace_id: workspaceId,
                source: METADATA_SOURCE,
                tokens: clean,
            }
            if (ttlMs !== undefined) params.ttl_ms = ttlMs
            return request("workspace.report_metadata", params)
        },

        /**
         * Start an agent and wait until it is ready for a prompt.
         * -> raw result ({ type:"agent_started", agent, argv }) with the
         * ready agent. herdr's socket API acknowledges agent.start once the
         * command is queued (the CLI waits on its own), so this polls the
         * pane until herdr reports the named agent interactive_ready.
         * Throws HerdrError("agent_not_ready") when it shows a blocking
         * dialog at startup or is not ready within the start timeout. A pane
         * whose shell is still starting (agent_pane_busy) is asked again
         * until the same timeout.
         */
        async agentStart({ name, kind, paneId, args = [], timeoutMs: t } = {}) {
            const waitMs = t ?? startTimeoutMs
            const deadline = clock.now().getTime() + waitMs
            // Every sleep and agent.get is bounded by the time left, so the
            // whole start stays within timeoutMs (+ a poll's rounding).
            const left = () => deadline - clock.now().getTime()
            const pause = () =>
                new Promise((res) =>
                    clock.setTimeout(res, Math.min(readyPollMs, left()))
                )
            // A fresh workspace's shell may still be starting: herdr then
            // refuses with agent_pane_busy ("not an available shell"), and
            // nothing was launched, so asking again is safe.
            // Each attempt gets only the time left (herdr wants timeout_ms
            // above MIN_START_MS); a retry is sent only while that fits, so
            // nothing is launched after the caller's budget ran out.
            const paneBusy = () =>
                new HerdrError(
                    PANE_BUSY,
                    `pane ${paneId} was not at a shell prompt after ${waitMs}ms`,
                    { method: "agent.start" }
                )
            let r
            for (let attempt = 0; ; attempt++) {
                const budget = attempt === 0 ? waitMs : left()
                if (attempt > 0 && budget <= MIN_START_MS) throw paneBusy()
                try {
                    r = await request(
                        "agent.start",
                        {
                            name,
                            kind,
                            pane_id: paneId,
                            args,
                            timeout_ms: budget,
                        },
                        { timeoutMs: budget + WAIT_GRACE_MS }
                    )
                    break
                } catch (err) {
                    if (!(err instanceof HerdrError) || err.code !== PANE_BUSY)
                        throw err
                    if (left() <= MIN_START_MS) throw paneBusy()
                    await pause()
                }
            }
            const notReady = () =>
                new HerdrError(
                    "agent_not_ready",
                    `${name} was not ready for input after ${waitMs}ms`,
                    { method: "agent.start" }
                )
            let agent = r && r.agent
            while (!agentReady(agent, name)) {
                if (agent && agent.agent_status === "blocked")
                    throw new HerdrError(
                        "agent_not_ready",
                        `${name} is waiting on a dialog at startup; check the pane`,
                        { method: "agent.start" }
                    )
                if (left() <= 0) throw notReady()
                await pause()
                if (left() <= 0) throw notReady()
                try {
                    agent = (
                        await request(
                            "agent.get",
                            { target: paneId },
                            { timeoutMs: left() }
                        )
                    ).agent
                } catch (err) {
                    if (!(err instanceof HerdrError)) throw err
                    // our own deadline-bounded wait ran out
                    if (err.code === "timeout" && left() <= 0) throw notReady()
                    if (err.code !== "agent_not_found") throw err
                    agent = null // not detected in the pane yet
                }
            }
            // A ready agent is returned even when it got ready on the last
            // poll: failing then would strand a live agent without a kickoff.
            return { ...r, agent }
        },

        /**
         * Send a prompt. Never retried: on any error (timeout,
         * agent_prompt_stalled, socket) delivery is uncertain and the caller
         * must read the agent state first.
         */
        agentPrompt(target, text, { wait = true, timeoutMs: t } = {}) {
            const params = { target, text }
            if (!wait) return request("agent.prompt", params)
            const waitMs = t ?? promptTimeoutMs
            params.wait = { timeout_ms: waitMs }
            return request("agent.prompt", params, {
                timeoutMs: waitMs + WAIT_GRACE_MS,
            })
        },

        /** -> AgentInfo | null (null when herdr says agent_not_found) */
        async agentGet(target) {
            try {
                const r = await request("agent.get", { target })
                return toAgentInfo(r.agent)
            } catch (err) {
                if (err instanceof HerdrError && err.code === "agent_not_found")
                    return null
                throw err
            }
        },

        /** -> AgentInfo[] */
        async agentList() {
            const r = await request("agent.list", {})
            const agents = Array.isArray(r.agents) ? r.agents : []
            return agents.map(toAgentInfo).filter(Boolean)
        },

        agentFocus(target) {
            return request("agent.focus", { target })
        },

        /** Last `lines` lines of the agent's pane as plain text. */
        async agentRead(target, { lines = 80, source = "recent" } = {}) {
            const r = await request("agent.read", {
                target,
                source,
                lines,
                format: "text",
                strip_ansi: true,
            })
            return r.read?.text ?? r.text ?? ""
        },
    }
}
