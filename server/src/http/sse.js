/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// GET /api/events: server-sent events fan-out of the bus, filtered per role.
// Owner: every event as-is. Viewer: only task.created / task.updated for
// shared tasks (viewerTask() applied) and artifact.updated for shared tasks
// (without actor). See docs/implementation/contracts.md "Bus events".
//
// SSE-only event (not on the bus), viewers only:
//   task.hidden  data: { task_id }
//     The task is no longer visible to viewers (made private, or its Asana
//     link was removed). Sent when a task.updated changes "visibility" or
//     "asana" and the task is now not shared, or when a task this stream
//     has shown as shared turns up not shared. Carries nothing but the id;
//     the web UI drops the task from its lists/page.
// Conversely a visibility/asana change that makes a task shared is sent as
// task.updated with the full viewerTask, so it appears in the viewer's
// lists even though only non-viewer fields changed.
//
// Streams are tied to the credential they were opened with: logout and
// device revocation end them (auth.trackStream), and every heartbeat
// re-validates the credential (auth.stillValid) and ends the stream if it
// is gone. The client reconnects and gets whatever role it has now.

import { isShared, viewerTask } from "../contracts/lifecycle.js"

export const HEARTBEAT_MS = 25000

/** task.json keys whose change can flip isShared(). */
export const SHARE_KEYS = ["visibility", "asana"]

/**
 * Map a bus event to what a viewer may see, or null to drop it.
 * @param {object} event  bus event { type, task_id, data, at }
 * @param {object} store  contracts store (getTask)
 * @param {object} [state] per-stream { visible: Set<task id> } of tasks
 *                         this stream has shown as shared
 */
export async function filterForViewer(event, store, state) {
    const data = event.data || {}
    const visible = state && state.visible
    if (event.type === "task.created" || event.type === "task.updated") {
        const task = data.task
        if (!task) return null
        const id = task.id ?? event.task_id
        const changed = Array.isArray(data.changed) ? data.changed : null
        const shareChanged =
            Boolean(changed) && changed.some((k) => SHARE_KEYS.includes(k))
        if (!isShared(task)) {
            const wasVisible = Boolean(visible && visible.has(id))
            visible?.delete(id)
            if (event.type === "task.updated" && (shareChanged || wasVisible))
                return {
                    type: "task.hidden",
                    task_id: id,
                    data: { task_id: id },
                    at: event.at,
                }
            return null
        }
        const view = viewerTask(task)
        const out = { task: view }
        if (changed) {
            out.changed = changed.filter((k) => k in view)
            if (changed.length && !out.changed.length && !shareChanged)
                return null
        }
        visible?.add(id)
        return {
            type: event.type,
            task_id: event.task_id,
            data: out,
            at: event.at,
        }
    }
    if (event.type === "artifact.updated") {
        if (!event.task_id) return null
        let task
        try {
            const found = await store.getTask(event.task_id)
            task = found && found.task
        } catch {
            return null
        }
        if (!task || !isShared(task)) return null
        const out = { revision: data.revision }
        if (Array.isArray(data.sections)) out.sections = data.sections
        return {
            type: event.type,
            task_id: event.task_id,
            data: out,
            at: event.at,
        }
    }
    return null
}

/**
 * @param {object} deps
 * @param {object} deps.bus
 * @param {object} deps.store
 * @param {object} [deps.auth]   createAuth(): trackStream, stillValid
 * @param {number} [deps.heartbeatMs]
 * @param {Function} [deps.setInterval]
 * @param {Function} [deps.clearInterval]
 * @param {object} [deps.log]
 * @returns {Function} express handler; expects req.auth = { role }
 */
export function createSseHandler({
    bus,
    store,
    auth,
    heartbeatMs = HEARTBEAT_MS,
    setInterval: setIntervalFn = setInterval,
    clearInterval: clearIntervalFn = clearInterval,
    log,
}) {
    return function sseHandler(req, res) {
        const role = req.auth && req.auth.role
        res.status(200)
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
        res.setHeader("Cache-Control", "no-cache, no-transform")
        res.setHeader("Connection", "keep-alive")
        res.setHeader("X-Accel-Buffering", "no")
        res.flushHeaders?.()
        res.write("retry: 3000\n: connected\n\n")

        let closed = false
        const state = { visible: new Set() }
        // Serialize writes so async viewer filtering keeps event order.
        let chain = Promise.resolve()
        const send = (event) => {
            if (closed) return
            res.write(
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
            )
        }
        const unsubscribe = bus.subscribe((event) => {
            if (role === "owner") {
                chain = chain.then(() => send(event))
                return
            }
            chain = chain
                .then(() => filterForViewer(event, store, state))
                .then((out) => out && send(out))
                .catch((err) =>
                    log?.warn?.({ err: err.message }, "sse filter failed")
                )
        })

        let untrack = () => {}
        const cleanup = () => {
            if (closed) return
            closed = true
            unsubscribe()
            untrack()
            clearIntervalFn(timer)
        }
        /** Close the stream from the server side (credential gone). */
        const end = () => {
            if (closed) return
            cleanup()
            res.end()
        }

        const timer = setIntervalFn(() => {
            if (closed) return
            if (!auth || !auth.stillValid) {
                res.write(": ping\n\n")
                return
            }
            Promise.resolve(auth.stillValid(req.auth))
                .then((ok) => {
                    if (!ok) end()
                    else if (!closed) res.write(": ping\n\n")
                })
                .catch((err) => {
                    // Fail closed: the client reconnects and re-authenticates.
                    log?.warn?.({ err: err.message }, "sse revalidate failed")
                    end()
                })
        }, heartbeatMs)
        timer?.unref?.()
        if (auth && auth.trackStream) untrack = auth.trackStream(req.auth, end)

        req.on("close", cleanup)
        res.on("close", cleanup)
        res.on("error", cleanup)
    }
}
