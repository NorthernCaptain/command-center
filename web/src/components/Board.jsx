/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useState } from "react"
import TaskRow from "./TaskRow.jsx"
import { EmptyState } from "./Skeleton.jsx"
import { LANE_LABELS } from "../lib/constants.js"

// Pill order. "all" is Inbox, Active and PRs in one list (in that order,
// a small header per lane). "ready" (shaped, not started: set by hand, or a
// reopened task) only gets a pill while it has tasks.
const OTHER_LANES = [
    "all",
    "inbox",
    "ready",
    "active",
    "prs",
    "waiting",
    "done",
]
const HIDDEN_WHEN_EMPTY = new Set(["ready"])
export const ALL_LANES = ["inbox", "active", "prs"]
// the chosen pill, remembered per device
const TAB_KEY = "cc.board.tab"

function savedTab() {
    try {
        return window.localStorage.getItem(TAB_KEY)
    } catch {
        return null
    }
}

function saveTab(tab) {
    try {
        window.localStorage.setItem(TAB_KEY, tab)
    } catch {
        // storage blocked: the default pill next time
    }
}

const laneTasks = (lanes, lane) =>
    lane === "all"
        ? ALL_LANES.flatMap((l) => lanes[l] || [])
        : lanes[lane] || []

const LANE_EMPTY = {
    all: "Nothing open.",
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

function Rows({ tasks, lane, rowProps }) {
    return (
        <ul className="rows">
            {tasks.map((t) => (
                <TaskRow
                    key={t.id}
                    task={t}
                    lane={lane}
                    agent={rowProps.agents[t.id]}
                    isOwner={rowProps.isOwner}
                    onDone={rowProps.onDone}
                    onSnooze={rowProps.onSnooze}
                    onStart={rowProps.onStart}
                    onFocus={rowProps.onFocus}
                />
            ))}
        </ul>
    )
}

/** The "All" list: Inbox, Active and PRs, each under a small header. */
function AllGroups({ lanes, rowProps }) {
    return ALL_LANES.filter((l) => (lanes[l] || []).length).map((l) => (
        <div key={l} className="lane-group">
            <h3 className="lane-sep">
                <span className={`lane-dot lane-dot-${l}`} aria-hidden="true" />
                {LANE_LABELS[l]}
                <span className="lane-sep-count">{lanes[l].length}</span>
            </h3>
            <Rows tasks={lanes[l]} lane={l} rowProps={rowProps} />
        </div>
    ))
}

function Lane({ lane, lanes, rowProps, current }) {
    const tasks = laneTasks(lanes, lane)
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
            {!tasks.length ? (
                <p className="lane-quiet">
                    {lane === "now"
                        ? "All clear. Nothing needs you right now."
                        : LANE_EMPTY[lane]}
                </p>
            ) : lane === "all" ? (
                <AllGroups lanes={lanes} rowProps={rowProps} />
            ) : (
                <Rows tasks={tasks} lane={lane} rowProps={rowProps} />
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
    // the default pill: the first lane with tasks ("all" only when picked)
    const firstNonEmpty =
        shown.find((l) => l !== "all" && (lanes[l] || []).length) || "inbox"
    const [tab, setTab] = useState(savedTab)
    const current = tab && shown.includes(tab) ? tab : firstNonEmpty
    const total = Object.values(lanes).reduce(
        (n, l) => n + (l ? l.length : 0),
        0
    )
    const rowProps = { agents, isOwner, onDone, onSnooze, onStart, onFocus }

    function pick(l) {
        setTab(l)
        saveTab(l)
    }

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
            <Lane lane="now" lanes={lanes} rowProps={rowProps} current />
            <div className="lane-tabs" role="tablist" aria-label="Lanes">
                {shown.map((l) => (
                    <button
                        key={l}
                        type="button"
                        role="tab"
                        aria-selected={current === l}
                        aria-controls={`lane-${l}`}
                        className={`lane-tab${current === l ? " is-current" : ""}`}
                        onClick={() => pick(l)}
                    >
                        {LANE_LABELS[l]}
                        <span className="lane-count">
                            {laneTasks(lanes, l).length}
                        </span>
                    </button>
                ))}
            </div>
            <div className="lanes-grid">
                {/* "all" repeats rows of other lanes: rendered only while
                    it is the one shown */}
                {shown
                    .filter((l) => l !== "all" || current === "all")
                    .map((l) => (
                        <Lane
                            key={l}
                            lane={l}
                            lanes={lanes}
                            rowProps={rowProps}
                            current={current === l}
                        />
                    ))}
            </div>
        </div>
    )
}
