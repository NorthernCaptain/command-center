/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useEffect, useState } from "react"
import { api, errorMessage } from "../lib/api.js"
import { relativeTime } from "../lib/time.js"
import { SkeletonRows } from "./Skeleton.jsx"

/** Class for one line of a unified diff. */
export function diffLineClass(line) {
    if (line.startsWith("+++") || line.startsWith("---")) return "d-file"
    if (line.startsWith("diff ") || line.startsWith("index ")) return "d-meta"
    if (line.startsWith("@@")) return "d-hunk"
    if (line.startsWith("+")) return "d-add"
    if (line.startsWith("-")) return "d-del"
    return "d-ctx"
}

export function DiffView({ diff }) {
    if (!diff) return <p className="muted">No changes in this commit.</p>
    const lines = diff.replace(/\n$/, "").split("\n")
    return (
        <pre className="diff" aria-label="Diff">
            {lines.map((line, i) => (
                <span key={i} className={`d-line ${diffLineClass(line)}`}>
                    {line || " "}
                    {"\n"}
                </span>
            ))}
        </pre>
    )
}

/** Revision history: git commits of the task folder, click for the diff. */
export default function HistoryDrawer({ taskId, open, onClose }) {
    const [commits, setCommits] = useState(null)
    const [error, setError] = useState(null)
    const [selected, setSelected] = useState(null) // { commit, diff|null, error }

    useEffect(() => {
        if (!open) return
        let alive = true
        setCommits(null)
        setSelected(null)
        setError(null)
        api.getHistory(taskId)
            .then((res) => alive && setCommits((res && res.commits) || []))
            .catch((err) => alive && setError(errorMessage(err)))
        return () => {
            alive = false
        }
    }, [open, taskId])

    useEffect(() => {
        if (!open) return
        const onKey = (e) => e.key === "Escape" && onClose()
        document.addEventListener("keydown", onKey)
        return () => document.removeEventListener("keydown", onKey)
    }, [open, onClose])

    async function pick(commit) {
        setSelected({ commit, diff: null, error: null })
        try {
            const res = await api.getCommitDiff(taskId, commit.sha)
            setSelected({ commit, diff: (res && res.diff) || "", error: null })
        } catch (err) {
            setSelected({ commit, diff: null, error: errorMessage(err) })
        }
    }

    if (!open) return null
    return (
        <div className="drawer-wrap" role="presentation">
            <button
                type="button"
                className="scrim"
                aria-label="Close history"
                onClick={onClose}
            />
            <aside
                className="drawer"
                role="dialog"
                aria-modal="true"
                aria-label="Revision history"
            >
                <header className="drawer-head">
                    {selected ? (
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setSelected(null)}
                        >
                            ← All revisions
                        </button>
                    ) : (
                        <h2 className="drawer-title">History</h2>
                    )}
                    <button
                        type="button"
                        className="icon-btn"
                        aria-label="Close"
                        onClick={onClose}
                    >
                        ×
                    </button>
                </header>
                <div className="drawer-body">
                    {selected ? (
                        <div className="commit-detail">
                            <p className="commit-msg">
                                {selected.commit.message}
                            </p>
                            <p className="commit-meta">
                                <code>
                                    {String(selected.commit.sha).slice(0, 8)}
                                </code>{" "}
                                · {selected.commit.actor} ·{" "}
                                {relativeTime(selected.commit.at)}
                            </p>
                            {selected.error ? (
                                <p className="error-text">{selected.error}</p>
                            ) : selected.diff === null ? (
                                <SkeletonRows count={4} label="Loading diff" />
                            ) : (
                                <DiffView diff={selected.diff} />
                            )}
                        </div>
                    ) : error ? (
                        <p className="error-text">{error}</p>
                    ) : !commits ? (
                        <SkeletonRows count={5} label="Loading history" />
                    ) : commits.length ? (
                        <ol className="commits">
                            {commits.map((c) => (
                                <li key={c.sha}>
                                    <button
                                        type="button"
                                        className="commit"
                                        onClick={() => pick(c)}
                                    >
                                        <span
                                            className={`commit-actor actor-${String(c.actor).split(":")[0]}`}
                                        >
                                            {c.actor}
                                        </span>
                                        <span className="commit-text">
                                            {c.message}
                                        </span>
                                        <time dateTime={c.at}>
                                            {relativeTime(c.at)}
                                        </time>
                                    </button>
                                </li>
                            ))}
                        </ol>
                    ) : (
                        <p className="muted">
                            No commits yet. Changes are committed after a short
                            delay.
                        </p>
                    )}
                </div>
            </aside>
        </div>
    )
}
