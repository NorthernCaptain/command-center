/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useEffect, useState } from "react"
import AgentChip, { isLiveAgent } from "./AgentChip.jsx"
import { ConfirmButton } from "./ConfirmDialog.jsx"
import RepoPicker from "./RepoPicker.jsx"
import SlackNotice, { noticeNeedsAttention } from "./SlackNotice.jsx"
import SnoozeMenu from "./SnoozeMenu.jsx"
import StartAgent from "./StartAgent.jsx"
import {
    AREAS,
    KIND_LABELS,
    STATUS_LABELS,
    allowedStatuses,
    isOpenStatus,
    taskKey,
} from "../lib/constants.js"
import { formatDue, relativeTime } from "../lib/time.js"
import { canCreatePr } from "../lib/worker.js"
import { taskPrs } from "../lib/links.js"

export { taskPrs }

const START_STATUSES = ["inbox", "ready", "active"]
// the Now reason the server sets when the Slack thread notice did not land
const NOTICE_REASON = "Slack thread not told about the Asana task"
// the agent may be closed only in these states (the server checks too)
const IDLE_AGENT_STATES = ["idle", "done"]
const PR_STATUSES = ["ready_for_pr", "pr_open", "pr_feedback"]
const isOpenTask = (task) => isOpenStatus(task.status)
const hasOpenPr = (task) =>
    (task.deliverables || []).some(
        (d) => d.disposition === "pr" && d.pr && !d.merged_at
    )

/**
 * Worker actions offered in the header for this task + agent state, gated
 * on the server features (/api/me): workers -> agent actions, github ->
 * Check PRs now.
 */
export function workerActions(task, agent, features = {}) {
    const workers = Boolean(features.workers)
    const live = isLiveAgent(agent)
    const error = String((task.flags && task.flags.error) || "")
    const hasFolders = Boolean(
        task.slug || (task.deliverables && task.deliverables.length)
    )
    return {
        start:
            workers &&
            START_STATUSES.includes(task.status) &&
            !(task.status === "active" && live),
        createPr: workers && canCreatePr(task),
        addressFeedback: workers && task.status === "pr_feedback",
        accept: task.status === "review",
        focus: workers && live,
        relaunchCodex:
            workers &&
            !["done", "cancelled"].includes(task.status) &&
            error.startsWith("Claude unavailable"),
        // also any open task whose claimed PR is still open (the watcher
        // follows it there too, e.g. back in active for review fixes)
        checkPrs:
            Boolean(features.github) &&
            (PR_STATUSES.includes(task.status) ||
                (isOpenTask(task) && hasOpenPr(task))),
        clean: workers && task.status === "done" && hasFolders,
        // shown with a live agent; enabled only while it is idle
        closeAgent: workers && live,
    }
}

/** Button that disables itself while its async handler runs. */
function AsyncButton({
    onClick,
    className = "btn btn-ghost btn-sm",
    children,
    ...rest
}) {
    const [busy, setBusy] = useState(false)
    return (
        <button
            type="button"
            className={className}
            disabled={busy}
            onClick={async () => {
                setBusy(true)
                try {
                    await onClick()
                } finally {
                    setBusy(false)
                }
            }}
            {...rest}
        >
            {children}
        </button>
    )
}

const SOURCE_LABEL = {
    slack: "Slack",
    asana: "Asana",
    github: "GitHub",
    herdr: "herdr",
}

/**
 * agent: agentState from GET /api/tasks/:id (or null). Worker handlers:
 * onStart(kind, repo), onAction(name) and onPollPrs(), all async. `api`
 * (optional) overrides the client the repo picker and Start use.
 */
export default function TaskHeader({
    task,
    isOwner,
    agent = null,
    features = {},
    onStart,
    onAction,
    onPollPrs,
    onPatch,
    onAsana,
    onEnrich,
    onCloseOut,
    onSnooze,
    onHistory,
    slackNotice = null,
    onSlackPost,
    onSlackCheck,
    onSlackDismiss,
    api,
}) {
    const asanaUrl = task.asana && task.asana.url
    const sourceUrl = task.source && task.source.url
    const open = isOpenStatus(task.status)
    const enriching = task.flags && task.flags.enriching
    const can = workerActions(task, agent, features)
    const prs = taskPrs(task)
    const agentIdle = Boolean(agent && IDLE_AGENT_STATES.includes(agent.state))
    // Close agent: clean the folders first (offered when Clean folders is)
    const [cleanOnClose, setCleanOnClose] = useState(true)
    const closeWithClean = can.clean && cleanOnClose

    return (
        <header className="task-head">
            <div className="task-kicker">
                <span className="task-key">{taskKey(task.id)}</span>
                <span className="task-kind">
                    {KIND_LABELS[task.kind] || task.kind}
                </span>
                {enriching ? (
                    <span className="badge badge-live">enriching…</span>
                ) : null}
                <span className="task-updated">
                    updated {relativeTime(task.updated_at)}
                </span>
            </div>
            <h1 className="task-title">{task.title}</h1>
            {isOwner ? (
                <SlackNotice
                    notice={slackNotice}
                    onPost={onSlackPost}
                    onCheck={onSlackCheck}
                    onDismiss={onSlackDismiss}
                />
            ) : null}
            {task.flags &&
            task.flags.now &&
            task.flags.now_reason &&
            // the notice above says it, with the details
            !(
                task.flags.now_reason === NOTICE_REASON &&
                isOwner &&
                noticeNeedsAttention(slackNotice)
            ) ? (
                <p className="task-now">
                    <span className="lane-lamp" aria-hidden="true" />{" "}
                    {task.flags.now_reason}
                </p>
            ) : null}
            {task.flags && task.flags.error ? (
                <p className="task-error">{task.flags.error}</p>
            ) : null}

            <div className="task-facts">
                {isOwner ? (
                    <label className="fact">
                        <span className="fact-k">status</span>
                        <select
                            className={`select-pill pill-${task.status}`}
                            aria-label="Status"
                            value={task.status}
                            onChange={(e) =>
                                onPatch({ status: e.target.value })
                            }
                        >
                            {allowedStatuses(task.status).map((s) => (
                                <option key={s} value={s}>
                                    {STATUS_LABELS[s]}
                                </option>
                            ))}
                        </select>
                    </label>
                ) : (
                    <span className="fact">
                        <span className="fact-k">status</span>
                        <span className={`pill pill-${task.status}`}>
                            {STATUS_LABELS[task.status]}
                        </span>
                    </span>
                )}
                {isOwner ? (
                    <label className="fact">
                        <span className="fact-k">area</span>
                        <select
                            className="select-pill"
                            aria-label="Area"
                            value={task.area}
                            onChange={(e) => onPatch({ area: e.target.value })}
                        >
                            {AREAS.map((a) => (
                                <option key={a} value={a}>
                                    {a}
                                </option>
                            ))}
                        </select>
                    </label>
                ) : (
                    <span className="fact">
                        <span className="fact-k">area</span>
                        <span className={`chip area area-${task.area}`}>
                            {task.area}
                        </span>
                    </span>
                )}
                <span className="fact fact-repos">
                    <span className="fact-k">repos</span>
                    <RepoPicker
                        repos={task.repos}
                        isOwner={isOwner}
                        onChange={(repos) => onPatch({ repos })}
                        {...(api ? { api } : {})}
                    />
                </span>
                {task.due_at && open ? (
                    <span className="fact">
                        <span className="fact-k">due</span>
                        {formatDue(task.due_at)}
                    </span>
                ) : null}
                {task.status === "waiting" && task.snooze_until ? (
                    <span className="fact">
                        <span className="fact-k">wakes</span>
                        {formatDue(task.snooze_until)}
                    </span>
                ) : null}
                {features.workers && agent && agent.state ? (
                    <span className="fact">
                        <span className="fact-k">agent</span>
                        <AgentChip state={agent.state} name={agent.name} />
                        {agent.name ? <code>{agent.name}</code> : null}
                    </span>
                ) : null}
                {task.branch || prs.length ? (
                    <span className="fact fact-branch">
                        <span className="fact-k">branch</span>
                        {task.branch ? <code>{task.branch}</code> : null}
                        {prs.map((p) => (
                            <a
                                key={p.url}
                                className={`pr-chip${p.merged ? " is-merged" : ""}`}
                                href={p.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={p.merged ? `${p.url} (merged)` : p.url}
                            >
                                {p.label}
                                {p.merged ? " ✓" : " ↗"}
                            </a>
                        ))}
                    </span>
                ) : null}
                {asanaUrl ? (
                    <a
                        className="fact fact-link"
                        href={asanaUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Asana ↗
                    </a>
                ) : null}
                {isOwner && sourceUrl ? (
                    <a
                        className="fact fact-link"
                        href={sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {SOURCE_LABEL[task.source.type] || "Source"} ↗
                    </a>
                ) : null}
            </div>

            {isOwner ? (
                <div
                    className="task-actions"
                    role="toolbar"
                    aria-label="Task actions"
                >
                    {can.start && onStart ? (
                        <StartAgent
                            task={task}
                            onStart={onStart}
                            {...(api ? { api } : {})}
                        />
                    ) : null}
                    {can.createPr ? (
                        <AsyncButton
                            className="btn btn-accent btn-sm"
                            onClick={() => onAction("create-pr")}
                        >
                            Create PR
                        </AsyncButton>
                    ) : null}
                    {can.addressFeedback ? (
                        <AsyncButton
                            className="btn btn-accent btn-sm"
                            onClick={() => onAction("address-feedback")}
                        >
                            Address feedback
                        </AsyncButton>
                    ) : null}
                    {can.accept ? (
                        <AsyncButton
                            className="btn btn-accent btn-sm"
                            aria-label="Accept and mark done"
                            onClick={() => onPatch({ status: "done" })}
                        >
                            ✓ Accept
                        </AsyncButton>
                    ) : null}
                    {can.relaunchCodex ? (
                        <AsyncButton
                            className="btn btn-sm"
                            onClick={() => onAction("relaunch-codex")}
                        >
                            Relaunch on Codex
                        </AsyncButton>
                    ) : null}
                    {can.focus ? (
                        <AsyncButton onClick={() => onAction("focus")}>
                            Open in herdr
                        </AsyncButton>
                    ) : null}
                    {can.checkPrs ? (
                        <AsyncButton onClick={onPollPrs}>
                            Check PRs now
                        </AsyncButton>
                    ) : null}
                    {can.clean ? (
                        <ConfirmButton
                            label="Clean folders"
                            title="Clean the task's folders?"
                            confirmLabel="Clean folders"
                            danger
                            onConfirm={() => onAction("clean")}
                        >
                            <p>
                                The agent deletes this task&apos;s folders in{" "}
                                the agents&apos; tree folder
                                {task.slug ? (
                                    <>
                                        {" "}
                                        (every <code>…--{task.slug}</code>{" "}
                                        folder)
                                    </>
                                ) : null}
                                , after checking that nothing is uncommitted or
                                unpushed; if something is, it stops and tells
                                you.
                            </p>
                            <p>Branches and PRs on GitHub stay.</p>
                        </ConfirmButton>
                    ) : null}
                    {can.closeAgent ? (
                        <ConfirmButton
                            label="Close agent"
                            title="Close the agent?"
                            confirmLabel={
                                closeWithClean
                                    ? "Clean and close"
                                    : "Close workspace"
                            }
                            danger
                            disabled={!agentIdle}
                            buttonTitle={
                                agentIdle
                                    ? "Close the agent's herdr workspace"
                                    : `The agent is ${agent.state}; it can be closed when idle`
                            }
                            onConfirm={() =>
                                closeWithClean
                                    ? onAction("close-agent", { clean: true })
                                    : onAction("close-agent")
                            }
                        >
                            <p>
                                This closes the herdr workspace of{" "}
                                <code>
                                    {(agent && agent.name) || "the agent"}
                                </code>{" "}
                                and ends its session. Its conversation is not
                                resumed; Start launches a new agent.
                            </p>
                            {can.clean ? (
                                <label className="field field-check">
                                    <input
                                        type="checkbox"
                                        checked={cleanOnClose}
                                        onChange={(e) =>
                                            setCleanOnClose(e.target.checked)
                                        }
                                    />
                                    <span>Clean folders</span>
                                </label>
                            ) : null}
                            {closeWithClean ? (
                                <p>
                                    The agent first deletes this task&apos;s
                                    folders (after checking nothing is
                                    uncommitted or unpushed). The workspace
                                    closes when it is done; if it leaves
                                    folders, it stays open and the task goes to
                                    Now. Branches and PRs on GitHub stay.
                                </p>
                            ) : (
                                <p>
                                    The task, its folders and branches stay as
                                    they are.
                                </p>
                            )}
                        </ConfirmButton>
                    ) : null}
                    {open && !can.accept ? (
                        <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => onPatch({ status: "done" })}
                        >
                            ✓ Done
                        </button>
                    ) : null}
                    {open ? <SnoozeMenu onPick={onSnooze} /> : null}
                    {!asanaUrl ? (
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={onAsana}
                        >
                            Create in Asana
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={onEnrich}
                        disabled={enriching}
                    >
                        Re-enrich
                    </button>
                    {open ? (
                        <ConfirmButton
                            label="Close out"
                            title={`Close out ${taskKey(task.id)}?`}
                            confirmLabel="Close out"
                            onConfirm={onCloseOut}
                        >
                            <p>
                                The center agent writes the Result section
                                {asanaUrl
                                    ? ", comments on and completes the Asana task,"
                                    : ""}{" "}
                                and the task moves to Done.
                            </p>
                            <p>
                                It needs every deliverable merged or marked No
                                change.
                            </p>
                        </ConfirmButton>
                    ) : null}
                    <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={onHistory}
                    >
                        History
                    </button>
                </div>
            ) : null}
        </header>
    )
}
