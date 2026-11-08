/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useState } from "react"
import { ACTIVE_JOB_STATUSES, JOB_LABELS } from "../lib/constants.js"

const RECENT_MS = 10 * 60 * 1000

function tail(text, n = 220) {
    if (!text) return ""
    return text.length > n ? `…${text.slice(-n)}` : text
}

/** One center-agent job with its streamed text. */
export function JobChip({ job, text, onCancel, onDismiss }) {
    const active = ACTIVE_JOB_STATUSES.includes(job.status)
    return (
        <div className={`job job-${job.status}`} data-job-id={job.id}>
            <div className="job-head">
                {active ? (
                    <span className="spinner" aria-hidden="true" />
                ) : (
                    <span className="job-dot" aria-hidden="true" />
                )}
                <span className="job-type">
                    {JOB_LABELS[job.type] || job.type}
                </span>
                <span className="job-status">{job.status}</span>
                {job.provider ? (
                    <span className="job-provider">{job.provider}</span>
                ) : null}
                {active && onCancel ? (
                    <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => onCancel(job)}
                    >
                        Cancel
                    </button>
                ) : null}
                {!active && onDismiss ? (
                    <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        aria-label="Dismiss"
                        onClick={() => onDismiss(job)}
                    >
                        ×
                    </button>
                ) : null}
            </div>
            {text && active ? <p className="job-stream">{tail(text)}</p> : null}
            {job.status === "failed" && job.error ? (
                <p className="job-error">{job.error}</p>
            ) : null}
            {job.status === "done" && job.summary ? (
                <p className="job-summary">{job.summary}</p>
            ) : null}
        </div>
    )
}

/** Running jobs plus recently failed ones (dismissable). */
export default function JobChips({
    jobs,
    deltas = {},
    onCancel,
    now = Date.now(),
}) {
    const [dismissed, setDismissed] = useState(() => new Set())
    const visible = (jobs || []).filter((j) => {
        if (dismissed.has(j.id)) return false
        if (ACTIVE_JOB_STATUSES.includes(j.status)) return true
        if (j.status === "failed") {
            const ended = j.ended_at ? Date.parse(j.ended_at) : now
            return now - ended < RECENT_MS
        }
        return false
    })
    if (!visible.length) return null
    return (
        <div className="jobs" aria-live="polite">
            {visible.map((j) => (
                <JobChip
                    key={j.id}
                    job={j}
                    text={deltas[j.id]}
                    onCancel={onCancel}
                    onDismiss={(job) =>
                        setDismissed((s) => new Set(s).add(job.id))
                    }
                />
            ))}
        </div>
    )
}
