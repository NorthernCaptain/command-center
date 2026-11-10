/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react"
import { JobChip } from "./JobChips.jsx"
import { api } from "../lib/api.js"
import { useEvents } from "../lib/hooks.js"

const JOB_STAGE = { queued: 0, running: 1, parked: 1 }
const jobStage = (status) => JOB_STAGE[status] ?? 2 // terminal = 2
// within this many px of the bottom counts as "at the bottom"
const STICK_PX = 24

/**
 * Merge a job view into the panel state. A fetched response can be older
 * than an SSE event that already arrived: never move a job back to an
 * earlier stage (queued -> running/parked -> done|failed|cancelled).
 */
export function mergeJob(state, next) {
    if (!next || next.id !== state.id) return state
    if (jobStage(next.status) < jobStage(state.status)) return state
    return { ...state, ...next }
}

/**
 * Live view of one center-agent job started from an input (the home
 * command bar, the task page chat): what Leo asked, the streamed text while
 * it runs, then the reply / error. Stays until closed. `onMore` adds a
 * link (`moreLabel`) to the rest, e.g. the task's whole chat.
 */
export default function JobPanel({
    job,
    prompt,
    onClose,
    onCancel,
    onMore,
    moreLabel = "More",
    label = "Center agent reply",
    className = "",
}) {
    const [state, setState] = useState(job)
    const [text, setText] = useState("")
    // A panel with a height cap (the task dock) scrolls: follow the reply as
    // it streams in, unless Leo scrolled up to read.
    const boxRef = useRef(null)
    const stick = useRef(true)
    useLayoutEffect(() => {
        const el = boxRef.current
        if (el && stick.current) el.scrollTop = el.scrollHeight
    }, [text, state.status, state.summary, state.error])
    function onScroll() {
        const el = boxRef.current
        stick.current =
            el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
    }
    // SSE only carries future changes: fetch the stored job on mount and
    // after a reconnect, so a job that finished meanwhile still shows up.
    const refresh = useCallback(() => {
        api.getJob(job.id)
            .then((res) => setState((s) => mergeJob(s, res && res.job)))
            .catch(() => {})
    }, [job.id])
    useEffect(() => {
        refresh()
    }, [refresh])
    useEvents(["job.updated", "job.delta", "stream.reconnected"], (evt) => {
        if (evt.type === "stream.reconnected") return refresh()
        const d = evt.data || {}
        if (evt.type === "job.updated" && d.job && d.job.id === job.id)
            setState((s) => mergeJob(s, d.job))
        if (evt.type === "job.delta" && d.job_id === job.id)
            setText((t) => t + (d.text || ""))
    })
    return (
        <section
            ref={boxRef}
            onScroll={onScroll}
            className={`command-panel${className ? ` ${className}` : ""}`}
            aria-label={label}
            aria-live="polite"
        >
            <p className="command-prompt">
                <span aria-hidden="true">›</span> {prompt}
            </p>
            <JobChip
                job={state}
                text={text}
                onCancel={onCancel}
                onDismiss={onClose}
            />
            {onMore ? (
                <button
                    type="button"
                    className="btn btn-ghost btn-xs command-more"
                    onClick={onMore}
                >
                    {moreLabel}
                </button>
            ) : null}
            {["done", "failed", "cancelled"].includes(state.status) ? null : (
                <button
                    type="button"
                    className="btn btn-ghost btn-xs command-close"
                    onClick={onClose}
                >
                    Hide
                </button>
            )}
        </section>
    )
}
