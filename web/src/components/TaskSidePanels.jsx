/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Smaller task-page panels: schedules, activity and links.

import { hrefFor } from "../lib/links.js"
import { useState } from "react"
import { formatDue, relativeTime, snoozePresets } from "../lib/time.js"
import TextBox from "./TextBox.jsx"

const ACTION_LABEL = {
    surface: "Resurface",
    center_job: "Center job",
    prompt_agent: "Prompt agent",
    launch_agent: "Launch agent",
}

export function SchedulesPanel({ schedules, readOnly, onAdd, onCancel }) {
    const [when, setWhen] = useState("")
    const [note, setNote] = useState("")
    const [busy, setBusy] = useState(false)
    const list = [...(schedules || [])].sort((a, b) => {
        const pa = a.status === "pending" ? 0 : 1
        const pb = b.status === "pending" ? 0 : 1
        if (pa !== pb) return pa - pb
        return String(a.fire_at).localeCompare(String(b.fire_at))
    })

    async function add(w) {
        const text = (w || when).trim()
        if (!text) return
        setBusy(true)
        try {
            await onAdd({ when: text, note: note.trim() || undefined })
            setWhen("")
            setNote("")
        } catch {
            // caller toasts
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="schedules">
            {list.length ? (
                <ul className="sched-list">
                    {list.map((s) => (
                        <li key={s.id} className={`sched sched-${s.status}`}>
                            <div className="sched-main">
                                <span className="sched-when">
                                    {formatDue(s.fire_at)}
                                </span>
                                <span className="sched-rel">
                                    {relativeTime(s.fire_at)}
                                </span>
                            </div>
                            <div className="sched-sub">
                                <span className="tag">
                                    {ACTION_LABEL[s.action] || s.action}
                                </span>
                                {s.note ? (
                                    <span className="sched-note">{s.note}</span>
                                ) : null}
                                {s.status !== "pending" ? (
                                    <span className={`tag tag-${s.status}`}>
                                        {s.status}
                                    </span>
                                ) : null}
                            </div>
                            {!readOnly && s.status === "pending" ? (
                                <button
                                    type="button"
                                    className="btn btn-ghost btn-xs"
                                    onClick={() => onCancel(s)}
                                    aria-label="Cancel schedule"
                                >
                                    Cancel
                                </button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="muted">No follow-ups scheduled.</p>
            )}
            {!readOnly ? (
                <form
                    className="sched-add"
                    onSubmit={(e) => {
                        e.preventDefault()
                        add()
                    }}
                >
                    <div className="preset-row">
                        {snoozePresets().map((p) => (
                            <button
                                key={p.id}
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={busy}
                                onClick={() => add(p.when)}
                            >
                                + {p.label}
                            </button>
                        ))}
                    </div>
                    <input
                        className="input input-sm"
                        placeholder="When? e.g. friday 3pm, in 2 days"
                        aria-label="Schedule when"
                        value={when}
                        onChange={(e) => setWhen(e.target.value)}
                    />
                    <TextBox
                        className="input input-sm"
                        placeholder="Note (optional)"
                        aria-label="Schedule note"
                        value={note}
                        maxRows={4}
                        onChange={(e) => setNote(e.target.value)}
                        onSubmit={() => {
                            if (!busy && when.trim()) add()
                        }}
                    />
                    <button
                        type="submit"
                        className="btn btn-sm"
                        disabled={busy || !when.trim()}
                    >
                        Add follow-up
                    </button>
                </form>
            ) : null}
        </div>
    )
}

function eventText(e) {
    const d = e.data || {}
    if (e.type === "updated" && Array.isArray(d.changed))
        return `updated ${d.changed.join(", ")}`
    if (e.type === "created") return "created the task"
    if (e.type === "slack_asana_link")
        return `asked Brain to post the Asana link in the Slack thread (${d.brain_job || "job"})`
    if (e.type === "slack_asana_link_failed")
        return `could not post the Asana link to Slack: ${d.error || "unknown error"}`
    if (d.summary) return `${e.type.replace(/_/g, " ")}: ${d.summary}`
    return e.type.replace(/[._]/g, " ")
}

export function ActivityList({ events }) {
    const list = events || []
    if (!list.length) return <p className="muted">No activity yet.</p>
    return (
        <ol className="activity">
            {list.map((e, i) => (
                <li key={`${e.at}-${i}`} className={`act act-${e.type}`}>
                    <span className="act-actor">{e.actor}</span>
                    <span className="act-text">{eventText(e)}</span>
                    <time dateTime={e.at}>{relativeTime(e.at)}</time>
                </li>
            ))}
        </ol>
    )
}

const LINK_GLYPH = {
    slack: "#",
    asana: "◉",
    pr: "⇄",
    branch: "⑂",
    folder: "▤",
    doc: "▧",
    review: "✓",
    other: "↗",
}

export function LinksList({ links }) {
    const list = links || []
    if (!list.length) return <p className="muted">No links yet.</p>
    return (
        <ul className="links">
            {list.map((l, i) => (
                <li key={l.id || `${l.url}-${i}`}>
                    <a
                        href={hrefFor(l.url) || undefined}
                        title={l.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`link link-${l.type}`}
                    >
                        <span className="link-glyph" aria-hidden="true">
                            {LINK_GLYPH[l.type] || "↗"}
                        </span>
                        <span className="link-label">{l.label || l.url}</span>
                        <span className="link-type">{l.type}</span>
                    </a>
                </li>
            ))}
        </ul>
    )
}
