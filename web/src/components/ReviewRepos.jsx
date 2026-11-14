/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// "Repos" menu of the PR reviews page: every known repo with Track /
// Auto-review check boxes (docs/09-pr-reviews.md "Tracking").

import { useEffect, useRef, useState } from "react"
import { useToast } from "./Toasts.jsx"
import { api as defaultApi, errorMessage } from "../lib/api.js"
import { relativeTime } from "../lib/time.js"

/**
 * Flags to send for one check box change: auto-review on implies track,
 * track off clears auto-review.
 */
export function nextFlags(repo, field, checked) {
    if (field === "auto_review")
        return checked
            ? { track: true, auto_review: true }
            : { track: Boolean(repo.track), auto_review: false }
    return checked
        ? { track: true, auto_review: Boolean(repo.auto_review) }
        : { track: false, auto_review: false }
}

/**
 * @param {object} props
 * @param {() => void} [props.onChanged]  a repo's tracking changed
 * @param {object} [props.api]
 */
export default function ReviewRepos({ onChanged, api = defaultApi }) {
    const toast = useToast()
    const [open, setOpen] = useState(false)
    const [repos, setRepos] = useState(null)
    const [error, setError] = useState(null)
    // repos with a save in flight (toggles of other repos may overlap)
    const [busy, setBusy] = useState(() => new Set())
    const boxRef = useRef(null)
    // bumped when a toggle starts and when it ends; pending: saves in flight.
    // A load overlapping any save may hold old flags: it is dropped.
    const saves = useRef(0)
    const pending = useRef(0)

    async function load() {
        const at = saves.current
        try {
            const res = await api.reviewRepos()
            if (at !== saves.current || pending.current) return
            setRepos((res && res.repos) || [])
            setError(null)
        } catch (err) {
            setError(errorMessage(err))
        }
    }

    // load once (the button shows the tracked count); opening the menu
    // loads again
    useEffect(() => {
        load()
    }, [])

    useEffect(() => {
        if (!open) return
        const onDown = (e) => {
            if (boxRef.current && !boxRef.current.contains(e.target))
                setOpen(false)
        }
        const onKey = (e) => e.key === "Escape" && setOpen(false)
        document.addEventListener("mousedown", onDown)
        document.addEventListener("keydown", onKey)
        return () => {
            document.removeEventListener("mousedown", onDown)
            document.removeEventListener("keydown", onKey)
        }
    }, [open])

    async function toggle(repo, field, checked) {
        const flags = nextFlags(repo, field, checked)
        // undo only this repo: other toggles may have landed meanwhile
        const before = { track: repo.track, auto_review: repo.auto_review }
        saves.current++
        pending.current++
        setRepos((list) =>
            list.map((r) => (r.name === repo.name ? { ...r, ...flags } : r))
        )
        setBusy((b) => new Set(b).add(repo.name))
        try {
            const res = await api.setReviewRepo(repo.name, flags)
            if (res && res.repo)
                setRepos((list) =>
                    list.map((r) =>
                        r.name === repo.name ? { ...r, ...res.repo } : r
                    )
                )
            if (onChanged) onChanged()
        } catch (err) {
            setRepos((list) =>
                list.map((r) =>
                    r.name === repo.name ? { ...r, ...before } : r
                )
            )
            toast.error(err)
        } finally {
            saves.current++
            pending.current--
            setBusy((b) => {
                const next = new Set(b)
                next.delete(repo.name)
                return next
            })
        }
    }

    async function scan(repo) {
        try {
            await api.scanReviews(repo.name)
            toast.info(`Scanning ${repo.name}…`)
        } catch (err) {
            toast.error(err)
        }
    }

    const tracked = (repos || []).filter((r) => r.track).length

    return (
        <div className="rv-repos" ref={boxRef}>
            <button
                type="button"
                className="btn btn-sm"
                aria-expanded={open}
                aria-haspopup="true"
                onClick={() => {
                    if (!open) load()
                    setOpen((o) => !o)
                }}
            >
                Repos
                <span className="lane-count">{tracked}</span>
            </button>
            {open ? (
                <div
                    className="menu rv-repos-menu"
                    role="group"
                    aria-label="Tracked repos"
                >
                    {error ? (
                        <p className="menu-error error-text">{error}</p>
                    ) : null}
                    {!repos ? (
                        <p className="muted rv-repos-empty">Loading…</p>
                    ) : !repos.length ? (
                        <p className="muted rv-repos-empty">
                            No repos in the tree AGENTS.md table.
                        </p>
                    ) : (
                        <ul className="rv-repos-list">
                            {repos.map((r) => (
                                <li key={r.name} className="rv-repo">
                                    <div className="rv-repo-head">
                                        <span
                                            className="rv-repo-name"
                                            title={r.description || undefined}
                                        >
                                            {r.name}
                                        </span>
                                        {r.track ? (
                                            <button
                                                type="button"
                                                className="btn btn-ghost btn-sm"
                                                aria-label={`Scan ${r.name} now`}
                                                onClick={() => scan(r)}
                                            >
                                                ↻
                                            </button>
                                        ) : null}
                                    </div>
                                    <div className="rv-repo-flags">
                                        <label className="rv-check">
                                            <input
                                                type="checkbox"
                                                checked={Boolean(r.track)}
                                                disabled={busy.has(r.name)}
                                                aria-label={`Track ${r.name}`}
                                                onChange={(e) =>
                                                    toggle(
                                                        r,
                                                        "track",
                                                        e.target.checked
                                                    )
                                                }
                                            />
                                            Track
                                        </label>
                                        <label className="rv-check">
                                            <input
                                                type="checkbox"
                                                checked={Boolean(r.auto_review)}
                                                disabled={busy.has(r.name)}
                                                aria-label={`Auto-review ${r.name}`}
                                                onChange={(e) =>
                                                    toggle(
                                                        r,
                                                        "auto_review",
                                                        e.target.checked
                                                    )
                                                }
                                            />
                                            Auto-review
                                        </label>
                                    </div>
                                    {r.track ? (
                                        <div className="rv-repo-meta">
                                            {r.last_scan_at
                                                ? `scanned ${relativeTime(r.last_scan_at)}`
                                                : "not scanned yet"}
                                            {Number.isFinite(r.open)
                                                ? ` · ${r.open} open`
                                                : ""}
                                        </div>
                                    ) : null}
                                    {r.error ? (
                                        <div className="rv-repo-error error-text">
                                            {r.error}
                                        </div>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            ) : null}
        </div>
    )
}
