/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useState } from "react"
import TaskRow from "./TaskRow.jsx"
import { EmptyState } from "./Skeleton.jsx"
import { LANE_LABELS } from "../lib/constants.js"

// Pill order. "ready" (shaped, not started: set by hand, or a reopened
// task) only gets a pill while it has tasks.
const OTHER_LANES = ["inbox", "ready", "active", "prs", "waiting", "done"]
const HIDDEN_WHEN_EMPTY = new Set(["ready"])

const LANE_EMPTY = {
    active: "Nothing in flight.",
    prs: "No open PRs.",
    ready: "Nothing queued up.",
    inbox: "Inbox zero.",
    waiting: "Nothing parked.",
    done: "Nothing finished this week yet.",
}

function laneNote(lane, tasks) {
    if (lane === "inbox") {
        const n = tasks.filter((t) => t.flags && t.flags.enriching).length
        return n ? `${n} enriching…` : null
    }
    if (lane === "done") return "this week"
    return null
}

function Lane({
    lane,
    tasks,
    agents,
    isOwner,
    onDone,
    onSnooze,
    onStart,
    onFocus,
    current,
}) {
    const note = laneNote(lane, tasks)
    return (
        <section
            className={`lane lane-${lane}${current ? " is-current" : ""}`}
            aria-labelledby={`lane-${lane}-h`}
            id={`lane-${lane}`}
            role={lane === "now" ? undefined : "tabpanel"}
        >
            <header className="lane-head">
                <h2 id={`lane-${lane}-h`} className="lane-title">
                    <span className="lane-lamp" aria-hidden="true" />
                    {LANE_LABELS[lane]}
                    <span className="lane-count">{tasks.length}</span>
                </h2>
                {note ? <span className="lane-note">{note}</span> : null}
            </header>
            {tasks.length ? (
                <ul className="rows">
                    {tasks.map((t) => (
                        <TaskRow
                            key={t.id}
                            task={t}
                            lane={lane}
                            isOwner={isOwner}
                            agent={agents[t.id]}
                            onDone={onDone}
                            onSnooze={onSnooze}
                            onStart={onStart}
                            onFocus={onFocus}
                        />
                    ))}
                </ul>
            ) : lane === "now" ? (
                <p className="lane-quiet">
                    All clear. Nothing needs you right now.
                </p>
            ) : (
                <p className="lane-quiet">{LANE_EMPTY[lane]}</p>
            )}
        </section>
    )
}

/**
 * Board lanes: the Now band, then a strip of lane pills that shows one
 * lane at a time, full width (phone and desktop alike). `agents`
 * maps task id -> worker agent state (overlay chips on the rows).
 */
export default function Board({
    lanes,
    agents = {},
    isOwner,
    onDone,
    onSnooze,
    onStart,
    onFocus,
}) {
    const shown = OTHER_LANES.filter(
        (l) => !HIDDEN_WHEN_EMPTY.has(l) || (lanes[l] || []).length
    )
    const firstNonEmpty = shown.find((l) => (lanes[l] || []).length) || "inbox"
    const [tab, setTab] = useState(null)
    const current = tab && shown.includes(tab) ? tab : firstNonEmpty
    const total = Object.values(lanes).reduce(
        (n, l) => n + (l ? l.length : 0),
        0
    )

    if (!total) {
        return (
            <EmptyState title="No tasks yet" glyph="◇">
                {isOwner
                    ? "Paste a Slack link or type a task above. Enter creates it."
                    : "Nothing has been shared yet."}
            </EmptyState>
        )
    }

    return (
        <div className="board">
            <Lane
                lane="now"
                tasks={lanes.now || []}
                agents={agents}
                isOwner={isOwner}
                onDone={onDone}
                onSnooze={onSnooze}
                onStart={onStart}
                onFocus={onFocus}
                current
            />
            <div className="lane-tabs" role="tablist" aria-label="Lanes">
                {shown.map((l) => (
                    <button
                        key={l}
                        type="button"
                        role="tab"
                        aria-selected={current === l}
                        aria-controls={`lane-${l}`}
                        className={`lane-tab${current === l ? " is-current" : ""}`}
                        onClick={() => setTab(l)}
                    >
                        {LANE_LABELS[l]}
                        <span className="lane-count">
                            {(lanes[l] || []).length}
                        </span>
                    </button>
                ))}
            </div>
            <div className="lanes-grid">
                {shown.map((l) => (
                    <Lane
                        key={l}
                        lane={l}
                        tasks={lanes[l] || []}
                        agents={agents}
                        isOwner={isOwner}
                        onDone={onDone}
                        onSnooze={onSnooze}
                        onStart={onStart}
                        onFocus={onFocus}
                        current={current === l}
                    />
                ))}
            </div>
        </div>
    )
}
