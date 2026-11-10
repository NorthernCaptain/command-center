/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Data hooks on top of the REST client and the SSE stream.

import { useCallback, useEffect, useRef, useState } from "react"
import { api as defaultApi } from "./api.js"
import { getEventStream } from "./events.js"
import { ACTIVE_JOB_STATUSES } from "./constants.js"

/** Subscribe `handler` to SSE event types for the component's lifetime. */
export function useEvents(types, handler) {
    const ref = useRef(handler)
    ref.current = handler
    const key = Array.isArray(types) ? types.join("|") : types
    useEffect(() => {
        const stream = getEventStream()
        const offs = key
            .split("|")
            .map((t) => stream.on(t, (e) => ref.current(e)))
        return () => offs.forEach((off) => off())
    }, [key])
}

/** Live SSE connection status. */
export function useStreamStatus() {
    const stream = getEventStream()
    const [status, setStatus] = useState(stream.status)
    useEffect(() => {
        setStatus(stream.status)
        return stream.onStatus(setStatus)
    }, [stream])
    return status
}

/** Debounced callback (trailing). */
export function useDebounced(fn, ms) {
    const ref = useRef(fn)
    ref.current = fn
    const timer = useRef(null)
    useEffect(() => () => clearTimeout(timer.current), [])
    return useCallback(
        (...args) => {
            clearTimeout(timer.current)
            timer.current = setTimeout(() => ref.current(...args), ms)
        },
        [ms]
    )
}

const BOARD_EVENTS = [
    "agent.updated",
    "task.created",
    "task.hidden",
    "task.updated",
    "schedule.updated",
    "stream.reconnected",
]

const EMPTY_LANES = {
    now: [],
    active: [],
    prs: [],
    ready: [],
    inbox: [],
    waiting: [],
    done: [],
}

/** Task id of an event (top level, or inside data for task.hidden). */
export function eventTaskId(evt) {
    if (!evt) return null
    if (evt.task_id !== null && evt.task_id !== undefined) return evt.task_id
    const d = evt.data || {}
    if (d.task_id !== null && d.task_id !== undefined) return d.task_id
    return d.task && d.task.id !== undefined ? d.task.id : null
}

/** Worker agent state carried by an agent.updated event (or null). */
export function agentStateOf(evt) {
    const d = (evt && evt.data) || {}
    if (d.state) return d.state
    if (d.agent && d.agent.state) return d.agent.state
    return (evt && evt.state) || null
}

/** Board agent overlay map with one task's state set (or removed). */
export function setAgentState(agents, taskId, state) {
    const out = { ...(agents || {}) }
    if (state) out[taskId] = state
    else delete out[taskId]
    return out
}

/** Lanes without the given task id. */
export function removeFromLanes(lanes, taskId) {
    if (!lanes) return lanes
    const out = {}
    for (const [lane, tasks] of Object.entries(lanes))
        out[lane] = (tasks || []).filter((t) => String(t.id) !== String(taskId))
    return out
}

/** Home board with live refresh. */
export function useBoard({ api = defaultApi, debounceMs = 300 } = {}) {
    const [lanes, setLanes] = useState(null)
    // { [taskId]: "working" | "blocked" | "idle" | "done" | "gone" }
    const [agents, setAgents] = useState({})
    const [error, setError] = useState(null)
    const [loading, setLoading] = useState(true)
    const alive = useRef(true)
    const seq = useRef(0)

    const reload = useCallback(async () => {
        // Only the latest request may update state: a slow earlier response
        // must not overwrite a newer board.
        const mine = ++seq.current
        const latest = () => alive.current && mine === seq.current
        try {
            const res = await api.board()
            if (!latest()) return
            setLanes({ ...EMPTY_LANES, ...((res && res.lanes) || {}) })
            setAgents((res && res.agents) || {})
            setError(null)
        } catch (err) {
            if (latest()) setError(err)
        } finally {
            if (latest()) setLoading(false)
        }
    }, [api])

    useEffect(() => {
        alive.current = true
        reload()
        return () => {
            alive.current = false
        }
    }, [reload])

    const refresh = useDebounced(reload, debounceMs)
    useEvents(BOARD_EVENTS, (evt) => {
        if (evt.type === "agent.updated") {
            // Live overlay only: the agent state is not part of the lanes.
            const tid = eventTaskId(evt)
            if (tid !== null)
                setAgents((prev) => setAgentState(prev, tid, agentStateOf(evt)))
            return
        }
        if (evt.type === "task.hidden") {
            const tid = eventTaskId(evt)
            if (tid !== null) setLanes((prev) => removeFromLanes(prev, tid))
        }
        refresh()
    })

    return { lanes, agents, error, loading, reload }
}

/** Insert or update a comment node in the folded thread list. */
export function upsertComment(threads, comment) {
    const list = threads || []
    if (!comment || !comment.id) return list
    if (comment.parent_id) {
        return list.map((t) => {
            if (t.id !== comment.parent_id) return t
            const replies = t.replies || []
            const idx = replies.findIndex((r) => r.id === comment.id)
            const next =
                idx === -1
                    ? [...replies, comment]
                    : replies.map((r) =>
                          r.id === comment.id ? { ...r, ...comment } : r
                      )
            return { ...t, replies: next }
        })
    }
    const idx = list.findIndex((t) => t.id === comment.id)
    if (idx === -1) {
        return [...list, { status: "open", replies: [], ...comment }]
    }
    return list.map((t) =>
        t.id === comment.id
            ? { ...t, ...comment, replies: comment.replies || t.replies || [] }
            : t
    )
}

export function upsertById(list, item) {
    const arr = list || []
    if (!item || item.id === undefined) return arr
    const idx = arr.findIndex((x) => x.id === item.id)
    if (idx === -1) return [...arr, item]
    return arr.map((x) => (x.id === item.id ? { ...x, ...item } : x))
}

/**
 * upsertById for center jobs that never moves a finished job back to an
 * active status. A job that fails at once can report "failed" over SSE
 * before the POST that queued it returns its "queued" copy; that copy must
 * not bring the spinner back.
 */
export function upsertJob(list, job) {
    const arr = list || []
    if (!job || job.id === undefined) return arr
    const cur = arr.find((x) => x.id === job.id)
    if (
        cur &&
        !ACTIVE_JOB_STATUSES.includes(cur.status) &&
        ACTIVE_JOB_STATUSES.includes(job.status)
    )
        return arr
    return upsertById(arr, job)
}

/** Reload errors that mean the task is gone or not visible to us. */
const LOST_ACCESS = [401, 403, 404]

const TASK_EVENTS = [
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
    "agent.updated",
    "pr.updated",
    "feedback.updated",
    "stream.reconnected",
]

function normalizeTaskData(res) {
    return {
        comments: [],
        feedback: [],
        events: [],
        schedules: [],
        jobs: [],
        outbox: [],
        prs: [],
        pr_candidates: [],
        reviews: [],
        agent: null,
        revision: null,
        ...res,
        artifact: {
            content: "",
            revision: null,
            ...((res && res.artifact) || {}),
        },
    }
}

/**
 * Apply one live event to task page data (pure, so it can be replayed).
 * Upserts are by id and events arrive in order, so replaying events that a
 * snapshot already contains is harmless; event records (no id) are skipped
 * when an identical one is already listed.
 */
export function applyTaskEvent(prev, evt) {
    if (!prev) return prev
    const d = (evt && evt.data) || {}
    switch (evt.type) {
        case "task.updated":
            return d.task ? { ...prev, task: d.task } : prev
        case "comment.added":
        case "comment.updated":
            return d.comment
                ? { ...prev, comments: upsertComment(prev.comments, d.comment) }
                : prev
        case "event.added": {
            if (!d.event) return prev
            const events = prev.events || []
            const key = JSON.stringify(d.event)
            if (events.some((e) => JSON.stringify(e) === key)) return prev
            return { ...prev, events: [d.event, ...events] } // newest first
        }
        case "job.updated":
            return d.job ? { ...prev, jobs: upsertJob(prev.jobs, d.job) } : prev
        case "schedule.updated":
            return d.schedule
                ? { ...prev, schedules: upsertById(prev.schedules, d.schedule) }
                : prev
        case "agent.updated": {
            const state = agentStateOf(evt)
            if (!prev.agent || !state) return prev
            return { ...prev, agent: { ...prev.agent, state } }
        }
        default:
            return prev
    }
}

/**
 * Task page data with live updates. Returns { data, setData, deltas, error,
 * loading, hidden, reload }. `deltas` maps job id -> streamed text;
 * `hidden` is true once a viewer got "task.hidden" (no longer shared) and
 * stays true until a reload succeeds (then `data` is set again).
 *
 * A snapshot can be older than live events that arrive while its request is
 * in flight (a job finishing, a comment resolved). Those events are buffered
 * and replayed, in order, over the snapshot when it lands.
 */
export function useTask(id, { api = defaultApi, debounceMs = 300 } = {}) {
    const [data, setData] = useState(null)
    const [error, setError] = useState(null)
    const [loading, setLoading] = useState(true)
    const [deltas, setDeltas] = useState({})
    const [hidden, setHidden] = useState(false)
    const current = useRef(id)
    current.current = id
    const seq = useRef(0)
    const buffer = useRef(null) // events seen while a reload is in flight

    const reload = useCallback(async () => {
        // Ignore responses that are not from the latest request, so a slow
        // earlier reload can't bring back a stale revision (spurious 409s).
        const mine = ++seq.current
        const latest = () => current.current === id && mine === seq.current
        buffer.current = []
        try {
            const res = await api.getTask(id)
            if (!latest()) return
            const missed = buffer.current || []
            setData(missed.reduce(applyTaskEvent, normalizeTaskData(res)))
            setHidden(false)
            setError(null)
        } catch (err) {
            if (!latest()) return
            setError(err)
            // Gone or no longer ours to see (e.g. made private while a viewer
            // was offline and missed task.hidden): drop what is on screen so
            // the page shows the error instead of stale content.
            if (err && LOST_ACCESS.includes(err.status)) {
                setData(null)
                setDeltas({})
            }
        } finally {
            if (latest()) {
                buffer.current = null
                setLoading(false)
            }
        }
    }, [api, id])

    useEffect(() => {
        setLoading(true)
        setData(null)
        setDeltas({})
        setHidden(false)
        reload()
    }, [reload])

    const refresh = useDebounced(reload, debounceMs)

    useEvents(TASK_EVENTS, (evt) => {
        if (evt.type === "stream.reconnected") return refresh()
        if (String(eventTaskId(evt)) !== String(id)) return
        const d = evt.data || {}
        switch (evt.type) {
            case "task.hidden":
                // Bump the sequence so an in-flight reload can't resurrect it.
                seq.current++
                buffer.current = null
                setHidden(true)
                setData(null)
                setLoading(false)
                return
            case "task.created":
                // Shared again: reload; reload() clears "hidden" once the
                // data is back, so the page never renders without data.
                refresh()
                return
            case "artifact.updated":
            case "pr.updated":
            case "feedback.updated":
                refresh()
                return
            case "job.delta":
                if (d.job_id) {
                    setDeltas((prev) => ({
                        ...prev,
                        [d.job_id]: (prev[d.job_id] || "") + (d.text || ""),
                    }))
                }
                return
        }
        if (buffer.current) buffer.current.push(evt)
        setData((prev) => applyTaskEvent(prev, evt))
        // task.updated: the revision is not in it; agent.updated: the
        // outbox and session details are not in it.
        // the Slack thread notice (slack_notice) is computed from these
        const ev = evt.type === "event.added" && d.event && d.event.type
        if (
            evt.type === "task.updated" ||
            evt.type === "agent.updated" ||
            String(ev || "").startsWith("slack_asana_link")
        )
            refresh()
    })

    return { data, setData, deltas, error, loading, hidden, reload }
}
