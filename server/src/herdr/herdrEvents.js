/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Long-lived herdr event subscription. One connection runs `events.subscribe`
// and only streams events afterwards. herdr needs one
// `pane.agent_status_changed` subscription per pane, so changing the tracked
// pane set reconnects with the new list. While the socket is down, the agent
// list is polled instead.
//
// Event lines (herdr schema `EventEnvelope` / `SubscriptionEventEnvelope`):
//   {"event":"pane.agent_status_changed","data":{pane_id,workspace_id,agent_status,...}}
//   {"event":"pane_exited","data":{"type":"pane_exited",pane_id,workspace_id}}
// Kinds come dotted (subscription names) or underscored (EventKind); both are
// accepted, as are flat and {"method":"event","params":{...}} variants.

import { EventEmitter } from "node:events"
import net from "node:net"
import { systemClock } from "../util/clock.js"
import { nullLogger } from "../util/logger.js"
import {
    createLineParser,
    expandHome,
    DEFAULT_SOCKET_PATH,
} from "./herdrClient.js"

export const BASE_SUBSCRIPTIONS = [
    "workspace.closed",
    "pane.exited",
    "pane.closed",
]

const KNOWN_KINDS = new Set([
    "pane_agent_status_changed",
    "pane_exited",
    "pane_closed",
    "workspace_closed",
])

/** events.subscribe params for a set of tracked panes. */
export function buildSubscriptions(paneIds) {
    return [
        ...BASE_SUBSCRIPTIONS.map((type) => ({ type })),
        ...[...paneIds].map((pane_id) => ({
            type: "pane.agent_status_changed",
            pane_id,
        })),
    ]
}

const str = (v) => (typeof v === "string" && v ? v : null)

/**
 * Parse one event line defensively.
 * -> { kind, paneId, workspaceId, status } | null (not an event we use)
 */
export function parseEvent(msg) {
    if (!msg || typeof msg !== "object") return null
    let m = msg
    if (m.params && typeof m.params === "object" && !m.event && !m.data)
        m = m.params
    const data = m.data && typeof m.data === "object" ? { ...m, ...m.data } : m
    const candidates = [m.event, m.type, data.type, data.event, msg.method]
    let kind = null
    for (const c of candidates) {
        if (typeof c !== "string") continue
        const k = c.replace(/\./g, "_")
        if (KNOWN_KINDS.has(k)) {
            kind = k
            break
        }
    }
    if (!kind) return null
    return {
        kind,
        paneId: str(data.pane_id),
        workspaceId:
            str(data.workspace_id) ?? str(data.workspace?.workspace_id),
        status: str(data.agent_status),
    }
}

/**
 * createHerdrEvents({ socketPath, connect, clock, log, client, pollMs,
 *                     backoffMs, ackTimeoutMs })
 * -> EventEmitter & { start(), stop(), track(paneIds), isConnected(), tracked() }
 * Emits "status" { paneId, workspaceId, status }, "exited" { paneId },
 * "closed" { workspaceId }, "resync" {}.
 */
export function createHerdrEvents({
    socketPath = DEFAULT_SOCKET_PATH,
    connect = net.createConnection,
    clock = systemClock,
    log = nullLogger,
    client = null,
    pollMs = 10000,
    backoffMs = [1000, 2000, 5000, 15000, 30000],
    ackTimeoutMs = 10000,
} = {}) {
    const sockPath = expandHome(socketPath)
    const emitter = new EventEmitter()
    let tracked = new Set()
    const lastStatus = new Map() // paneId -> status (dedupe)
    const vanished = new Set() // panes already reported as exited
    let running = false
    let connected = false
    let socket = null
    let gen = 0 // connection generation; stale sockets are ignored
    let attempt = 0
    let reconnectTimer = null
    let pollTimer = null
    let ackTimer = null
    let subSeq = 0

    function emit(name, payload) {
        try {
            emitter.emit(name, payload)
        } catch (err) {
            log.error({ err, event: name }, "herdr event listener failed")
        }
    }

    function applyStatus(paneId, workspaceId, status) {
        if (!paneId || !status) return
        vanished.delete(paneId)
        if (lastStatus.get(paneId) === status) return
        lastStatus.set(paneId, status)
        emit("status", { paneId, workspaceId: workspaceId ?? null, status })
    }

    // pane.exited and pane.closed may both arrive: report a pane once.
    // Untracked panes are passed through without being remembered.
    function paneGone(paneId) {
        if (!paneId || vanished.has(paneId)) return
        lastStatus.delete(paneId)
        if (tracked.has(paneId)) vanished.add(paneId)
        emit("exited", { paneId })
    }

    function handleEvent(msg) {
        const ev = parseEvent(msg)
        if (!ev) return
        if (ev.kind === "pane_agent_status_changed") {
            if (tracked.has(ev.paneId))
                applyStatus(ev.paneId, ev.workspaceId, ev.status)
        } else if (ev.kind === "workspace_closed") {
            if (ev.workspaceId) emit("closed", { workspaceId: ev.workspaceId })
        } else paneGone(ev.paneId)
    }

    function clearTimer(t) {
        if (t !== null) clock.clearTimeout(t)
        return null
    }

    function dropSocket() {
        gen++
        connected = false
        ackTimer = clearTimer(ackTimer)
        const s = socket
        socket = null
        try {
            s?.destroy()
        } catch {
            // already gone
        }
    }

    function onDown(myGen, reason) {
        if (myGen !== gen) return
        dropSocket()
        if (!running) return
        log.warn({ reason, attempt }, "herdr event stream down")
        startPoll()
        scheduleReconnect()
    }

    function scheduleReconnect() {
        if (reconnectTimer !== null || !running) return
        const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)]
        attempt++
        reconnectTimer = clock.setTimeout(() => {
            reconnectTimer = null
            open()
        }, delay)
    }

    function onSubscribed() {
        ackTimer = clearTimer(ackTimer)
        connected = true
        attempt = 0
        pollTimer = clearTimer(pollTimer)
        log.info({ panes: tracked.size }, "herdr event stream subscribed")
        emit("resync", {})
    }

    function open() {
        if (!running) return
        dropSocket()
        const myGen = gen
        const subId = `cc-sub-${process.pid}-${++subSeq}`
        const parser = createLineParser(
            (msg) => {
                if (myGen !== gen) return false
                if (msg && msg.id === subId && (msg.result || msg.error)) {
                    if (msg.error) {
                        onDown(myGen, `subscribe failed: ${msg.error.code}`)
                        return false
                    }
                    onSubscribed()
                } else handleEvent(msg)
                return true
            },
            (line) => {
                log.warn({ line: line.slice(0, 200) }, "herdr: bad event line")
                return true
            }
        )
        try {
            socket = connect(sockPath)
            socket.on("data", (chunk) => parser.push(chunk))
            socket.on("error", (err) => onDown(myGen, err.message))
            socket.on("close", () => onDown(myGen, "closed"))
            ackTimer = clock.setTimeout(
                () => onDown(myGen, "subscribe not acknowledged"),
                ackTimeoutMs
            )
            socket.write(
                JSON.stringify({
                    id: subId,
                    method: "events.subscribe",
                    params: { subscriptions: buildSubscriptions(tracked) },
                }) + "\n"
            )
        } catch (err) {
            onDown(myGen, err.message)
        }
    }

    function startPoll() {
        if (!client || pollTimer !== null || !running || connected) return
        pollTimer = clock.setTimeout(pollTick, pollMs)
    }

    async function pollTick() {
        pollTimer = null
        if (!running || connected) return
        try {
            const agents = await client.agentList()
            if (running && !connected) {
                const byPane = new Map(agents.map((a) => [a.paneId, a]))
                for (const paneId of tracked) {
                    const a = byPane.get(paneId)
                    if (a) applyStatus(paneId, a.workspaceId, a.status)
                    else paneGone(paneId)
                }
                emit("resync", {})
            }
        } catch (err) {
            log.debug({ err: err.message }, "herdr poll failed")
        }
        startPoll()
    }

    function sameSet(a, b) {
        if (a.size !== b.size) return false
        for (const x of a) if (!b.has(x)) return false
        return true
    }

    return Object.assign(emitter, {
        start() {
            if (running) return
            running = true
            attempt = 0
            open()
        },
        stop() {
            running = false
            reconnectTimer = clearTimer(reconnectTimer)
            pollTimer = clearTimer(pollTimer)
            dropSocket()
        },
        /** Replace the tracked pane set. Returns true when it changed. */
        track(paneIds) {
            const next = new Set((paneIds || []).filter(Boolean))
            if (sameSet(next, tracked)) return false
            for (const p of tracked)
                if (!next.has(p)) {
                    lastStatus.delete(p)
                    vanished.delete(p)
                }
            tracked = next
            // Resubscribe now unless a backoff reconnect is already pending
            // (that one will pick up the new set).
            if (running && reconnectTimer === null) open()
            return true
        },
        isConnected: () => connected,
        tracked: () => [...tracked],
    })
}
