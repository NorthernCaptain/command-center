/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import AgentChip, { isLiveAgent } from "./AgentChip.jsx"
import { useApp } from "./AppContext.jsx"
import Link from "./Link.jsx"
import SnoozeMenu from "./SnoozeMenu.jsx"
import { STATUS_LABELS, isOpenStatus, taskKey } from "../lib/constants.js"
import { formatDue, relativeTime } from "../lib/time.js"
import { taskPrs } from "../lib/links.js"
import { blockingDeliverables } from "../lib/worker.js"

const START_STATUSES = ["inbox", "ready", "active"]
const SOURCE_PILL = { slack: "Slack" }

const KIND_GLYPH = { reminder: "⏰", todo: "◻", agent_task: "◆" }

function timeLabel(task, lane) {
    if (lane === "waiting") {
        const wake = task.snooze_until || task.due_at
        return wake ? `wakes ${formatDue(wake)}` : "waiting"
    }
    if (lane === "done")
        return task.done_at ? `done ${relativeTime(task.done_at)}` : "done"
    if (task.due_at && isOpenStatus(task.status))
        return `due ${formatDue(task.due_at)}`
    return relativeTime(task.updated_at)
}

/** Statuses that wait on Leo in the PR flow, with a row badge. */
export const PR_BADGES = {
    ready_for_pr: { glyph: "⇄", label: "create PR" },
    pr_feedback: { glyph: "✎", label: "review feedback" },
}

/**
 * What the row offers. done: no deliverable blocks Done (it would fail
 * otherwise); start: a repo is set, no agent runs and Start is possible.
 */
export function rowActions(task, agent, features = {}) {
    const open = isOpenStatus(task.status)
    const live = isLiveAgent(agent)
    return {
        done: open && blockingDeliverables(task, []).length === 0,
        start:
            Boolean(features.workers) &&
            START_STATUSES.includes(task.status) &&
            ((task.repos && task.repos.length) || 0) > 0 &&
            !live,
    }
}

/**
 * One board/search row. Quick actions only for the owner on open tasks.
 * `agent` is the worker agent state from the board overlay (or undefined).
 * One line of same-height pills: area, status, PR flow, agent, open PRs,
 * Asana, the Slack source and the live agent (click: herdr switches to the
 * task's workspace).
 */
export default function TaskRow({
    task,
    lane,
    isOwner,
    agent,
    onDone,
    onSnooze,
    onStart,
    onFocus,
}) {
    const { features } = useApp()
    const prBadge = features.github ? PR_BADGES[task.status] : null
    const enriching = task.flags && task.flags.enriching
    const nowReason =
        task.flags && task.flags.now ? task.flags.now_reason : null
    const open = isOpenStatus(task.status)
    const can = rowActions(task, agent, features)
    const live = Boolean(features.workers) && isLiveAgent(agent)
    const openPrs = features.github
        ? taskPrs(task).filter((p) => !p.merged)
        : []
    const asanaUrl = task.asana && task.asana.url
    const src = task.source || {}
    const sourcePill = src.url && SOURCE_PILL[src.type]
    return (
        <li className={`row status-${task.status}`} data-task-id={task.id}>
            <div className="row-main">
                <span className="row-key">
                    <span className="row-glyph" aria-hidden="true">
                        {KIND_GLYPH[task.kind] || "◻"}
                    </span>
                    {taskKey(task.id)}
                </span>
                {/* the title link is stretched over the whole row; the
                    clickable pills sit above it */}
                <Link to={`/t/${task.id}`} className="row-title row-link">
                    {task.title}
                </Link>
                <span className="row-meta">
                    {task.area ? (
                        <span className={`chip area area-${task.area}`}>
                            {task.area}
                        </span>
                    ) : null}
                    <span className={`pill pill-${task.status}`}>
                        {STATUS_LABELS[task.status] || task.status}
                    </span>
                    {prBadge ? (
                        <span className={`badge badge-pr badge-${task.status}`}>
                            <span aria-hidden="true">{prBadge.glyph}</span>
                            {prBadge.label}
                        </span>
                    ) : null}
                    {features.workers && !(live && isOwner) ? (
                        <AgentChip state={agent} />
                    ) : null}
                    {enriching ? (
                        <span className="badge badge-live">enriching…</span>
                    ) : null}
                    {openPrs.map((p) => (
                        <a
                            key={p.url}
                            className="chip pill-link pill-pr"
                            href={p.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={p.url}
                        >
                            {p.label} ↗
                        </a>
                    ))}
                    {asanaUrl ? (
                        <a
                            className="chip pill-link pill-asana"
                            href={asanaUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Asana ↗
                        </a>
                    ) : null}
                    {sourcePill ? (
                        <a
                            className="chip pill-link pill-slack"
                            href={src.url}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            {sourcePill} ↗
                        </a>
                    ) : null}
                    {live && isOwner ? (
                        <button
                            type="button"
                            className={`chip pill-link pill-herdr agent-${agent}`}
                            title="Switch herdr to this task's agent"
                            onClick={() => onFocus && onFocus(task)}
                        >
                            herdr · <AgentChip state={agent} />
                        </button>
                    ) : null}
                    <time className="row-time" dateTime={task.updated_at}>
                        {timeLabel(task, lane)}
                    </time>
                </span>
                {nowReason ? (
                    <span className="row-reason">{nowReason}</span>
                ) : null}
            </div>
            {isOwner && open ? (
                <div className="row-actions">
                    {can.start ? (
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm btn-start"
                            aria-label={`Start an agent for ${taskKey(task.id)}`}
                            onClick={() => onStart && onStart(task)}
                        >
                            ▶ <span className="hide-phone">Start</span>
                        </button>
                    ) : null}
                    {can.done ? (
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm btn-done"
                            aria-label={`Mark ${taskKey(task.id)} done`}
                            onClick={() => onDone && onDone(task)}
                        >
                            ✓ <span className="hide-phone">Done</span>
                        </button>
                    ) : null}
                    <SnoozeMenu
                        onPick={(choice) => onSnooze && onSnooze(task, choice)}
                    />
                </div>
            ) : null}
        </li>
    )
}
