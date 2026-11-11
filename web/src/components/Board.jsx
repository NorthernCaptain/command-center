/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useState } from "react"
import { isLiveAgent } from "./AgentChip.jsx"
import { useApp } from "./AppContext.jsx"
import TaskRow from "./TaskRow.jsx"
import { EmptyState } from "./Skeleton.jsx"
import { LANE_LABELS, statusLane } from "../lib/constants.js"

// Pill order. "all" is Inbox, Active and PRs in one list (in that order,
// a small header per lane). "herdr" is every task with a live herdr agent,
// from any lane (owner only, with workers on). "ready" (shaped, not
// started: set by hand, or a reopened task) only gets a pill while it has
// tasks.
const OTHER_LANES = [
    "all",
    "herdr",
    "inbox",
    "ready",
    "active",
    "prs",
    "waiting",
    "done",
]
const HIDDEN_WHEN_EMPTY = new Set(["ready"])
export const ALL_LANES = ["inbox", "active", "prs"]
// the "herdr" list groups its tasks by lane, in this order
export const HERDR_LANES = [
    "now",
    "active",
    "prs",
    "ready",
    "inbox",
    "waiting",
    "done",
]
// pills that repeat rows of other lanes: never the default pick
const VIEWS = new Set(["all", "herdr"])
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

/**
 * Lane -> its tasks with a live herdr agent (lanes without any left out).
 * `extra`: tasks with an agent that are not on the board (done before the
 * board's window), each under its status's lane.
 */
export function herdrGroups(lanes, agents = {}, extra = []) {
    const all = {}
    for (const l of HERDR_LANES) all[l] = [...(lanes[l] || [])]
    const seen = new Set(
        Object.values(all)
            .flat()
            .map((t) => String(t.id))
    )
    for (const t of extra)
        if (!seen.has(String(t.id))) all[statusLane(t.status)].push(t)
    const out = {}
    for (const l of HERDR_LANES) {
        const tasks = all[l].filter((t) => isLiveAgent(agents[t.id]))
        if (tasks.length) out[l] = tasks
    }
    return out
}

const laneTasks = (lanes, lane, agents = {}, extra = []) =>
    lane === "all"
        ? ALL_LANES.flatMap((l) => lanes[l] || [])
        : lane === "herdr"
          ? Object.values(herdrGroups(lanes, agents, extra)).flat()
          : lanes[lane] || []

const LANE_EMPTY = {
    all: "Nothing open.",
    herdr: "No herdr agents running.",
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

/** The "All" and "herdr" lists: rows under a small header per lane. */
function Groups({ lanes, order, rowProps }) {
    return order
        .filter((l) => (lanes[l] || []).length)
        .map((l) => (
            <div key={l} className="lane-group">
                <h3 className="lane-sep">
                    <span
                        className={`lane-dot lane-dot-${l}`}
                        aria-hidden="true"
                    />
                    {LANE_LABELS[l]}
                    <span className="lane-sep-count">{lanes[l].length}</span>
                </h3>
                <Rows tasks={lanes[l]} lane={l} rowProps={rowProps} />
            </div>
        ))
}

function Lane({ lane, lanes, rowProps, current }) {
    const tasks = laneTasks(lanes, lane, rowProps.agents, rowProps.agentTasks)
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
                <Groups lanes={lanes} order={ALL_LANES} rowProps={rowProps} />
            ) : lane === "herdr" ? (
                <Groups
                    lanes={herdrGroups(
                        lanes,
                        rowProps.agents,
                        rowProps.agentTasks
                    )}
                    order={HERDR_LANES}
                    rowProps={rowProps}
                />
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
    agentTasks = [],
    isOwner,
    onDone,
    onSnooze,
    onStart,
    onFocus,
}) {
    const { features } = useApp()
    const herdr = Boolean(isOwner && features.workers)
    const shown = OTHER_LANES.filter(
        (l) =>
            (l !== "herdr" || herdr) &&
            (!HIDDEN_WHEN_EMPTY.has(l) || (lanes[l] || []).length)
    )
    // the default pill: the first lane with tasks ("all" and "herdr" only
    // when picked)
    const firstNonEmpty =
        shown.find((l) => !VIEWS.has(l) && (lanes[l] || []).length) || "inbox"
    const [tab, setTab] = useState(savedTab)
    const current = tab && shown.includes(tab) ? tab : firstNonEmpty
    // rows to show: lane tasks, plus (herdr pill) agents on off-board tasks
    const total =
        Object.values(lanes).reduce((n, l) => n + (l ? l.length : 0), 0) +
        (herdr ? laneTasks(lanes, "herdr", agents, agentTasks).length : 0)
    const rowProps = {
        agents,
        agentTasks,
        isOwner,
        onDone,
        onSnooze,
        onStart,
        onFocus,
    }

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
                            {laneTasks(lanes, l, agents, agentTasks).length}
                        </span>
                    </button>
                ))}
            </div>
            <div className="lanes-grid">
                {/* "all" and "herdr" repeat rows of other lanes:
                    rendered only while shown */}
                {shown
                    .filter((l) => !VIEWS.has(l) || current === l)
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
