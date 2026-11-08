/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// SSE client for GET /api/events with typed handlers and reconnect/backoff.
// Each message is `event: <type>` + `data: <JSON>`; the JSON is the bus event
// { type, task_id, data, at }. Handlers receive that normalized object.

export const EVENT_TYPES = [
    "task.created",
    "task.updated",
    "task.hidden",
    "artifact.updated",
    "comment.added",
    "comment.updated",
    "event.added",
    "job.updated",
    "job.delta",
    "schedule.updated",
    "settings.updated",
    // phase 2/3
    "agent.updated",
    "pr.updated",
    "feedback.updated",
    "digest.updated",
]

/** Normalize a parsed SSE payload to { type, task_id, data, at }. */
export function normalizeEvent(type, payload) {
    const p = payload && typeof payload === "object" ? payload : {}
    if ("data" in p && ("task_id" in p || "type" in p)) {
        return {
            type: p.type || type,
            task_id: p.task_id === undefined ? null : p.task_id,
            data: p.data || {},
            at: p.at || null,
        }
    }
    return {
        type,
        task_id: p.task_id === undefined ? null : p.task_id,
        data: p,
        at: null,
    }
}

/**
 * createEventStream({ url, EventSource, initialDelay, maxDelay, timers })
 *   .on(type | "*", fn) -> off
 *   .onStatus(fn) -> off          // "connecting" | "open" | "reconnecting" | "closed"
 *   .onError(fn) -> off           // every connection error, before the retry
 *   .start() / .close()
 *   .status
 * Emits a synthetic "stream.reconnected" event after a reconnect so callers
 * can refetch anything they may have missed.
 */
export function createEventStream({
    url = "/api/events",
    EventSource: ES,
    types = EVENT_TYPES,
    initialDelay = 1000,
    maxDelay = 30000,
    timers = {
        setTimeout: (...a) => setTimeout(...a),
        clearTimeout: (...a) => clearTimeout(...a),
    },
} = {}) {
    const handlers = new Map()
    const statusHandlers = new Set()
    const errorHandlers = new Set()
    let source = null
    let status = "closed"
    let delay = initialDelay
    let retryTimer = null
    let everOpened = false
    let stopped = true

    function setStatus(s) {
        if (s === status) return
        status = s
        for (const fn of statusHandlers) fn(s)
    }

    function dispatch(evt) {
        for (const key of [evt.type, "*"]) {
            const set = handlers.get(key)
            if (!set) continue
            for (const fn of [...set]) {
                try {
                    fn(evt)
                } catch (err) {
                    // A broken handler must not kill the stream.
                    if (typeof console !== "undefined") console.error(err)
                }
            }
        }
    }

    function onMessage(type, msg) {
        let payload = null
        try {
            payload = msg.data ? JSON.parse(msg.data) : {}
        } catch {
            return
        }
        dispatch(normalizeEvent(type, payload))
    }

    function connect() {
        const Impl = ES || globalThis.EventSource
        if (!Impl) {
            setStatus("closed")
            return
        }
        setStatus(everOpened ? "reconnecting" : "connecting")
        source = new Impl(url, { withCredentials: true })
        source.onopen = () => {
            const wasReconnect = everOpened
            everOpened = true
            delay = initialDelay
            setStatus("open")
            if (wasReconnect) {
                dispatch({
                    type: "stream.reconnected",
                    task_id: null,
                    data: {},
                    at: null,
                })
            }
        }
        source.onerror = () => {
            if (stopped) return
            // Take over reconnects ourselves so we control the backoff.
            if (source) source.close()
            source = null
            setStatus("reconnecting")
            scheduleReconnect()
            // EventSource hides the HTTP status; listeners can probe the
            // session (e.g. GET /api/me) to tell 401/403 from an outage.
            for (const fn of [...errorHandlers]) {
                try {
                    fn()
                } catch (err) {
                    if (typeof console !== "undefined") console.error(err)
                }
            }
        }
        for (const type of types) {
            source.addEventListener(type, (msg) => onMessage(type, msg))
        }
        source.onmessage = (msg) => {
            let payload = null
            try {
                payload = JSON.parse(msg.data)
            } catch {
                return
            }
            if (payload && payload.type)
                dispatch(normalizeEvent(payload.type, payload))
        }
    }

    function scheduleReconnect() {
        if (retryTimer) timers.clearTimeout(retryTimer)
        const wait = delay
        delay = Math.min(maxDelay, delay * 2)
        retryTimer = timers.setTimeout(() => {
            retryTimer = null
            if (!stopped) connect()
        }, wait)
    }

    return {
        on(type, fn) {
            if (!handlers.has(type)) handlers.set(type, new Set())
            handlers.get(type).add(fn)
            return () => {
                const set = handlers.get(type)
                if (set) set.delete(fn)
            }
        },
        onStatus(fn) {
            statusHandlers.add(fn)
            return () => statusHandlers.delete(fn)
        },
        onError(fn) {
            errorHandlers.add(fn)
            return () => errorHandlers.delete(fn)
        },
        start() {
            if (!stopped) return
            stopped = false
            connect()
        },
        close() {
            stopped = true
            if (retryTimer) timers.clearTimeout(retryTimer)
            retryTimer = null
            if (source) source.close()
            source = null
            setStatus("closed")
        },
        get status() {
            return status
        },
        /** Next reconnect delay (for tests/diagnostics). */
        get nextDelay() {
            return delay
        },
        dispatch,
    }
}

let shared = null

/** App-wide stream (lazily created, not started). */
export function getEventStream() {
    if (!shared) shared = createEventStream()
    return shared
}

/** Replace the shared stream (tests). Returns the previous one. */
export function setEventStream(stream) {
    const prev = shared
    shared = stream
    return prev
}
