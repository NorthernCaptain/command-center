/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import Board from "../components/Board.jsx"
import CaptureBox from "../components/CaptureBox.jsx"
import DigestCard from "../components/DigestCard.jsx"
import JobPanel from "../components/JobPanel.jsx"
export { mergeJob } from "../components/JobPanel.jsx"
import TaskRow from "../components/TaskRow.jsx"
import { TOPBAR_SLOT_ID } from "../components/TopBar.jsx"
import { EmptyState, SkeletonRows } from "../components/Skeleton.jsx"
import { useApp } from "../components/AppContext.jsx"
import { useToast } from "../components/Toasts.jsx"
import { api, errorMessage } from "../lib/api.js"
import { taskKey } from "../lib/constants.js"
import { eventTaskId, useBoard, useEvents } from "../lib/hooks.js"
import { doneMessage } from "../lib/done.js"
import { snoozeTask } from "../lib/snooze.js"
import { formatDue } from "../lib/time.js"
import { workerError } from "../lib/worker.js"

function isTypingTarget(el) {
    if (!el) return false
    const tag = el.tagName
    return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable
    )
}

/**
 * Search box + FTS results. "/" focuses it. Results follow visibility: a
 * task that becomes hidden leaves them at once, a reconnect re-runs the
 * search (events may have been missed) and a role change (owner <-> viewer)
 * drops the old results before searching again. Each new search aborts the
 * previous request, so a late response can't bring removed rows back.
 */
function useSearch(isOwner) {
    const [q, setQ] = useState("")
    const [results, setResults] = useState(null)
    const [searching, setSearching] = useState(false)
    const [version, setVersion] = useState(0)
    useEvents(["task.hidden", "stream.reconnected"], (evt) => {
        if (evt.type === "task.hidden") {
            const id = String(eventTaskId(evt))
            setResults((r) => {
                if (!r) return r
                const tasks = r.tasks.filter((t) => String(t.id) !== id)
                if (tasks.length === r.tasks.length) return r
                return { ...r, tasks, total: Math.max(0, r.total - 1) }
            })
        }
        setVersion((v) => v + 1)
    })
    useEffect(() => {
        setResults(null) // never show the other role's results
    }, [isOwner])
    useEffect(() => {
        const query = q.trim()
        if (!query) {
            setResults(null)
            return
        }
        const ctrl =
            typeof AbortController !== "undefined"
                ? new AbortController()
                : null
        const t = setTimeout(async () => {
            setSearching(true)
            try {
                const res = await api.listTasks(
                    { q: query, limit: 50 },
                    ctrl ? { signal: ctrl.signal } : undefined
                )
                setResults({
                    tasks: (res && res.tasks) || [],
                    total: (res && res.total) || 0,
                    error: null,
                })
            } catch (err) {
                if (err && err.name === "AbortError") return
                setResults({ tasks: [], total: 0, error: errorMessage(err) })
            } finally {
                setSearching(false)
            }
        }, 220)
        return () => {
            clearTimeout(t)
            if (ctrl) ctrl.abort()
        }
    }, [q, version, isOwner])
    return { q, setQ, results, searching }
}

/** The top bar's slot element, found before the first paint (or null). */
export function useTopbarSlot() {
    const [slot, setSlot] = useState(null)
    useLayoutEffect(() => {
        setSlot(document.getElementById(TOPBAR_SLOT_ID))
    }, [])
    return slot
}

export default function Home() {
    const { isOwner, features } = useApp()
    const toast = useToast()
    const { lanes, agents, agentTasks, loading, error, reload } = useBoard()
    const { q, setQ, results, searching } = useSearch(isOwner)
    const [command, setCommand] = useState(null)
    const searchRef = useRef(null)
    const slot = useTopbarSlot()

    useEffect(() => {
        const onKey = (e) => {
            if (e.key === "/" && !isTypingTarget(document.activeElement)) {
                e.preventDefault()
                if (searchRef.current) searchRef.current.focus()
            }
        }
        document.addEventListener("keydown", onKey)
        return () => document.removeEventListener("keydown", onKey)
    }, [])

    async function onStart(task) {
        try {
            await api.startTask(task.id)
            toast.info(`${taskKey(task.id)}: starting the agent…`)
            reload()
        } catch (err) {
            toast.error(workerError(err))
        }
    }

    async function onFocus(task) {
        try {
            await api.taskAction(task.id, "focus")
            toast.success(`herdr: switched to ${taskKey(task.id)}`)
        } catch (err) {
            toast.error(workerError(err))
        }
    }

    async function onDone(task) {
        try {
            const res = await api.patchTask(task.id, { status: "done" })
            toast.success(doneMessage(task.id, res))
            reload()
        } catch (err) {
            toast.error(err)
        }
    }

    async function onSnooze(task, choice) {
        try {
            const res = await snoozeTask(api, task, choice)
            toast.success(
                res.at
                    ? `${taskKey(task.id)} snoozed until ${formatDue(res.at)}`
                    : `${taskKey(task.id)} snoozed`
            )
            reload()
        } catch (err) {
            toast.error(err)
            throw err
        }
    }

    // Search lives in the top bar (portal into its slot); without a top
    // bar (tests, embedded) it stays at the top of the page.
    const search = (
        <div className="search">
            <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle
                    cx="10.5"
                    cy="10.5"
                    r="6.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                />
                <path
                    d="m15.5 15.5 5 5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                />
            </svg>
            <input
                ref={searchRef}
                type="search"
                className="search-input"
                placeholder="Search tasks, artifacts, comments"
                aria-label="Search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQ("")}
            />
            <kbd className="search-kbd" aria-hidden="true">
                /
            </kbd>
        </div>
    )

    return (
        <div className="page home">
            {slot ? createPortal(search, slot) : null}
            <div className="home-top">
                {slot ? null : search}
                {isOwner ? (
                    <CaptureBox
                        onCreated={() => reload()}
                        onCommand={(job, prompt) =>
                            job && setCommand({ job, prompt })
                        }
                    />
                ) : null}
            </div>

            {isOwner && features.digest && !q.trim() ? <DigestCard /> : null}

            {command ? (
                <JobPanel
                    key={command.job.id}
                    job={command.job}
                    prompt={command.prompt}
                    onClose={() => setCommand(null)}
                />
            ) : null}

            {q.trim() ? (
                <section
                    className="lane lane-search is-current"
                    aria-label="Search results"
                >
                    <header className="lane-head">
                        <h2 className="lane-title">
                            Results
                            <span className="lane-count">
                                {results ? results.total : "…"}
                            </span>
                        </h2>
                        {searching ? (
                            <span className="spinner" aria-hidden="true" />
                        ) : null}
                    </header>
                    {!results ? (
                        <SkeletonRows count={3} label="Searching" />
                    ) : results.error ? (
                        <p className="lane-quiet error-text">{results.error}</p>
                    ) : results.tasks.length ? (
                        <ul className="rows">
                            {results.tasks.map((t) => (
                                <TaskRow
                                    key={t.id}
                                    task={t}
                                    isOwner={isOwner}
                                    agent={agents[t.id]}
                                    onDone={onDone}
                                    onSnooze={onSnooze}
                                    onStart={onStart}
                                    onFocus={onFocus}
                                />
                            ))}
                        </ul>
                    ) : (
                        <EmptyState
                            title={`Nothing matches “${q.trim()}”`}
                            glyph="∅"
                        />
                    )}
                </section>
            ) : loading && !lanes ? (
                <SkeletonRows count={6} label="Loading board" />
            ) : error && !lanes ? (
                <EmptyState title="Can't load the board" glyph="!">
                    <p>{errorMessage(error)}</p>
                    <button type="button" className="btn" onClick={reload}>
                        Retry
                    </button>
                </EmptyState>
            ) : (
                <Board
                    lanes={lanes}
                    agents={agents}
                    agentTasks={agentTasks}
                    isOwner={isOwner}
                    onDone={onDone}
                    onSnooze={onSnooze}
                    onStart={onStart}
                    onFocus={onFocus}
                />
            )}
        </div>
    )
}
