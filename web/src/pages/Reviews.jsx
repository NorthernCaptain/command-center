/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// PR reviews dashboard (docs/09-pr-reviews.md): stats, tabs, search and
// the PRs of tracked repos with their review agent runs.

import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import { useApp } from "../components/AppContext.jsx"
import Link from "../components/Link.jsx"
import ReviewRepos from "../components/ReviewRepos.jsx"
import { EmptyState, SkeletonRows } from "../components/Skeleton.jsx"
import { useToast } from "../components/Toasts.jsx"
import Bars from "../components/charts/Bars.jsx"
import Donut from "../components/charts/Donut.jsx"
import { api as defaultApi, errorMessage } from "../lib/api.js"
import { useDebounced, useEvents } from "../lib/hooks.js"
import { relativeTime } from "../lib/time.js"
import { reviewAgentLabel } from "../lib/constants.js"

/** Tabs in display order; "new" is the default. */
export const REVIEW_TABS = [
    { key: "rejected", label: "Rejected" },
    { key: "approved", label: "Approved" },
    { key: "new", label: "New" },
    { key: "queued", label: "Queued" },
    { key: "all", label: "All" },
]
const TAB_KEYS = REVIEW_TABS.map((t) => t.key)
export const DEFAULT_TAB = "new"

/** All tab sections (the server sorts the rows by them). */
export const GROUP_LABELS = {
    queued: "In the queue",
    new: "Waiting for you",
    rejected: "Changes requested",
    approved: "Approved",
    merged: "Merged",
    closed: "Closed",
    other: "Other",
}

const ACTIVE_RUN = ["running", "reported"]
/** Sections whose rows offer Approve (waiting for us, changes requested). */
const APPROVE_GROUPS = ["new", "rejected"]
const RUN_OPEN = ["queued", ...ACTIVE_RUN]

/** ?tab=… from a location search string, else the default tab. */
export function tabFromSearch(search) {
    const tab = new URLSearchParams(search || "").get("tab")
    return TAB_KEYS.includes(tab) ? tab : DEFAULT_TAB
}

/**
 * The status pill of a PR: { key, label, title? }. An open agent run
 * wins, then the PR's own state (merged / closed / draft), then whether
 * it needs a review, then our decision.
 */
export function prStatus(pr) {
    const run = pr.run
    if (run && run.status === "queued")
        return { key: "queued", label: "queued", title: "Waiting for a slot" }
    if (run && ACTIVE_RUN.includes(run.status))
        return { key: "reviewing", label: "in review" }
    if (pr.state === "MERGED") return { key: "merged", label: "merged" }
    if (pr.state === "CLOSED") return { key: "closed", label: "closed" }
    if (pr.is_draft) return { key: "draft", label: "draft" }
    if (pr.needs_review === "re_review")
        return {
            key: "re_review",
            label: "re-review",
            title: "Updated since our change request",
        }
    if (pr.needs_review === "new") return { key: "new", label: "new" }
    if (pr.decision === "approved")
        return { key: "approved", label: "approved" }
    if (pr.decision === "changes_requested")
        return { key: "changes_requested", label: "changes requested" }
    return { key: "none", label: "—" }
}

/** What the row offers for its run / PR. */
export function prActions(pr) {
    const run = pr.run
    const open = pr.state === "OPEN"
    const runOpen = Boolean(run && RUN_OPEN.includes(run.status))
    // a finished run may have left its agent open (a failed run keeps it
    // for a look; a close herdr refused is retried)
    const agentLeft = Boolean(run && !runOpen && run.agent_open)
    return {
        review: open && !runOpen,
        reviewLabel: pr.decision ? "Re-review" : "Review",
        approve: open && !runOpen && APPROVE_GROUPS.includes(pr.group),
        cancel: runOpen || agentLeft,
        cancelLabel: run && run.status === "queued" ? "Cancel" : "Close agent",
        focus: Boolean(run && (ACTIVE_RUN.includes(run.status) || agentLeft)),
    }
}

/** 5.2 -> "5.2 h", 30 -> "30 h", 50 -> "2.1 d"; null -> "—". */
export function formatHours(h) {
    if (h === null || h === undefined || !Number.isFinite(h)) return "—"
    if (h >= 48) return `${(h / 24).toFixed(1)} d`
    return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`
}

const fmtNum = (v, digits = 1) =>
    v === null || v === undefined || !Number.isFinite(v)
        ? "—"
        : Number.isInteger(v)
          ? String(v)
          : v.toFixed(digits)

const CI_LABEL = {
    SUCCESS: "CI ✓",
    FAILURE: "CI ✕",
    ERROR: "CI ✕",
    PENDING: "CI …",
    EXPECTED: "CI …",
}

const ATTEMPT_SEGMENTS = [
    { key: "1", label: "1st", color: "var(--live)" },
    { key: "2", label: "2nd", color: "var(--blue)" },
    { key: "3", label: "3rd", color: "var(--violet)" },
    { key: "4+", label: "4th+", color: "var(--accent)" },
]
const WEEK_SERIES = [
    { key: "approved", label: "Approved", color: "var(--live)" },
    { key: "changes_requested", label: "Changes", color: "var(--red)" },
]

/** "2026-11-09" -> "11/9" (week start). */
const weekLabel = (w) => {
    const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(w || ""))
    return m ? `${Number(m[1])}/${Number(m[2])}` : String(w || "")
}

/** Dashboard data for a tab + query, refetched on reviews.updated. */
export function useReviews(
    tab,
    q,
    { api = defaultApi, debounceMs = 400 } = {}
) {
    const [data, setData] = useState(null)
    // the tab + search the data was loaded for
    const [dataFor, setDataFor] = useState(null)
    const [error, setError] = useState(null)
    const [loading, setLoading] = useState(true)
    const [version, setVersion] = useState(0)
    const reload = useCallback(() => setVersion((v) => v + 1), [])
    const later = useDebounced(reload, debounceMs)
    useEvents(["reviews.updated", "stream.reconnected"], () => later())
    useEffect(() => {
        const ctrl =
            typeof AbortController !== "undefined"
                ? new AbortController()
                : null
        let live = true
        setLoading(true)
        api.reviews(
            { tab, q: q.trim() },
            ctrl ? { signal: ctrl.signal } : undefined
        ).then(
            (res) => {
                if (!live) return
                setData(res || {})
                setDataFor(`${tab}|${q.trim()}`)
                setError(null)
                setLoading(false)
            },
            (err) => {
                if (!live || (err && err.name === "AbortError")) return
                setError(err)
                setLoading(false)
            }
        )
        return () => {
            live = false
            if (ctrl) ctrl.abort()
        }
    }, [api, tab, q, version])
    // data of another tab / search is not shown as this one's
    const current = dataFor === `${tab}|${q.trim()}`
    return { data, error, loading, reload, current }
}

function StatTile({ label, value, hint }) {
    return (
        <div className="rv-tile">
            <span className="rv-tile-value">{value}</span>
            <span className="rv-tile-label">{label}</span>
            {hint ? <span className="rv-tile-hint">{hint}</span> : null}
        </div>
    )
}

export function ReviewStats({ stats }) {
    if (!stats) return null
    const days = stats.window_days || 30
    const attempts = stats.attempts || {}
    const weekly = stats.weekly || []
    const authors = stats.authors || []
    return (
        <section className="rv-stats" aria-label="Review stats">
            <div className="rv-tiles">
                <StatTile
                    label="Approved"
                    value={fmtNum(stats.approved)}
                    hint={`${days} days`}
                />
                <StatTile
                    label="Changes requested"
                    value={fmtNum(stats.changes_requested)}
                    hint={`${days} days`}
                />
                <StatTile
                    label="To first review"
                    value={formatHours(stats.median_first_review_hours)}
                    hint="median"
                />
                <StatTile
                    label="Attempts to approve"
                    value={fmtNum(stats.avg_attempts_to_approve)}
                    hint="average"
                />
                <StatTile
                    label="Waiting"
                    value={fmtNum(stats.waiting)}
                    hint={`${fmtNum(stats.reviewing)} in review · ${fmtNum(
                        stats.queued
                    )} queued`}
                />
            </div>
            <div className="rv-charts">
                <div className="card rv-chart-card">
                    <h3 className="rv-chart-title">Approved on attempt</h3>
                    <Donut
                        label="Approvals by attempt"
                        segments={ATTEMPT_SEGMENTS.map((s) => ({
                            label: s.label,
                            color: s.color,
                            value: attempts[s.key] || 0,
                        }))}
                    />
                </div>
                <div className="card rv-chart-card">
                    <h3 className="rv-chart-title">Reviews per week</h3>
                    {weekly.length ? (
                        <Bars
                            label="Reviews per week"
                            data={weekly}
                            series={WEEK_SERIES}
                            labelKey="week"
                            formatLabel={weekLabel}
                        />
                    ) : (
                        <p className="muted">No reviews yet.</p>
                    )}
                </div>
                <div className="card rv-chart-card">
                    <h3 className="rv-chart-title">Authors</h3>
                    {authors.length ? (
                        <table className="rv-authors">
                            <thead>
                                <tr>
                                    <th scope="col">Author</th>
                                    <th scope="col" title="Approved">
                                        ✓
                                    </th>
                                    <th scope="col" title="Changes requested">
                                        ✕
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {authors.map((a) => (
                                    <tr key={a.author}>
                                        <td>{a.author}</td>
                                        <td>{a.approved || 0}</td>
                                        <td>{a.changes_requested || 0}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <p className="muted">No reviews yet.</p>
                    )}
                </div>
            </div>
        </section>
    )
}

/**
 * "claude limited until 5:00 PM → codex": next is the kind new reviews
 * start with now (the server's next_kind), else "waiting".
 */
export function limitedText(kind, until, next) {
    const at = new Date(until)
    const time = at.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
    })
    return `${kind} limited until ${time} → ${next || "waiting"}`
}

function RunInfo({ run }) {
    if (!run) return null
    const parts = []
    if (run.agent_kind)
        parts.push(reviewAgentLabel(run.agent_kind, run.agent_model))
    if (run.verdict) parts.push(run.verdict.replace("_", " "))
    if (Number.isFinite(run.issues))
        parts.push(`${run.issues} issue${run.issues === 1 ? "" : "s"}`)
    if (run.status === "failed")
        parts.push(`review failed${run.error ? `: ${run.error}` : ""}`)
    if (run.status === "cancelled") parts.push("review cancelled")
    if (!parts.length && !run.summary) return null
    const head = parts.join(" · ") || "agent summary"
    if (!run.summary)
        return (
            <div
                className={`rv-run${run.status === "failed" ? " error-text" : ""}`}
            >
                {head}
            </div>
        )
    return (
        <details className="rv-run">
            <summary>{head}</summary>
            <p className="rv-run-summary">{run.summary}</p>
        </details>
    )
}

export function PrRow({
    pr,
    onReview,
    onApprove,
    onCancel,
    onFocus,
    approving = false,
}) {
    const status = prStatus(pr)
    const can = prActions(pr)
    const run = pr.run
    const ci = CI_LABEL[String(pr.ci_state || "").toUpperCase()]
    const ciBad = ["FAILURE", "ERROR"].includes(
        String(pr.ci_state || "").toUpperCase()
    )
    return (
        <li className={`rv-row rv-${status.key}`}>
            <div className="rv-main">
                <a
                    className="rv-title"
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    <span className="rv-key">
                        {pr.repo}#{pr.number}
                    </span>{" "}
                    {pr.title}
                </a>
                <div className="rv-meta">
                    <span
                        className={`pill rv-pill rv-pill-${status.key}`}
                        title={status.title}
                    >
                        {status.label}
                    </span>
                    {pr.eligible === false && pr.needs_review ? (
                        <span
                            className="chip rv-chip-muted"
                            title="Not reviewed automatically: review it by hand or press Review"
                        >
                            {pr.ineligible_reason
                                ? `manual · ${pr.ineligible_reason}`
                                : "manual"}
                        </span>
                    ) : null}
                    <span className="rv-author">{pr.author}</span>
                    {ci ? (
                        <span
                            className={`chip${ciBad ? " rv-chip-bad" : ""}`}
                            title={`CI: ${pr.ci_state}`}
                        >
                            {ci}
                        </span>
                    ) : null}
                    {pr.mergeable === "CONFLICTING" ? (
                        <span className="chip rv-chip-bad">conflicts</span>
                    ) : null}
                    <span
                        className="rv-size"
                        title={`${pr.changed_files || 0} files`}
                    >
                        <span className="rv-add">+{pr.additions || 0}</span>{" "}
                        <span className="rv-del">−{pr.deletions || 0}</span>
                    </span>
                </div>
                <RunInfo run={run} />
            </div>
            <dl className="rv-facts">
                <div>
                    <dt>Attempts</dt>
                    <dd>{pr.attempts || 0}</dd>
                </div>
                <div>
                    <dt>Issues</dt>
                    <dd>
                        {run && Number.isFinite(run.issues) ? run.issues : "—"}
                    </dd>
                </div>
                <div>
                    <dt>Our review</dt>
                    <dd>{pr.decided_at ? relativeTime(pr.decided_at) : "—"}</dd>
                </div>
                <div>
                    <dt>Opened</dt>
                    <dd>{relativeTime(pr.created_at) || "—"}</dd>
                </div>
                <div>
                    <dt>Updated</dt>
                    <dd>{relativeTime(pr.updated_at) || "—"}</dd>
                </div>
            </dl>
            <div className="rv-actions">
                {can.review ? (
                    <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`${can.reviewLabel} ${pr.repo}#${pr.number}`}
                        disabled={approving}
                        onClick={() => onReview(pr)}
                    >
                        {can.reviewLabel}
                    </button>
                ) : null}
                {can.approve ? (
                    <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`Approve ${pr.repo}#${pr.number}`}
                        title="Approve on GitHub, with no comment"
                        disabled={approving}
                        onClick={() => onApprove(pr)}
                    >
                        {approving ? "Approving…" : "Approve"}
                    </button>
                ) : null}
                {can.focus ? (
                    <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        aria-label={`Open ${pr.repo}#${pr.number} in herdr`}
                        onClick={() => onFocus(pr)}
                    >
                        herdr
                    </button>
                ) : null}
                {can.cancel ? (
                    <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        aria-label={`${can.cancelLabel} ${pr.repo}#${pr.number}`}
                        onClick={() => onCancel(pr)}
                    >
                        {can.cancelLabel}
                    </button>
                ) : null}
            </div>
        </li>
    )
}

/** The page: owner only (viewers get "Nothing here", nothing is loaded). */
export default function Reviews({ api = defaultApi }) {
    const { isOwner } = useApp()
    if (!isOwner)
        return (
            <EmptyState title="Nothing here" glyph="?">
                <Link to="/" className="btn">
                    Back to board
                </Link>
            </EmptyState>
        )
    return <ReviewsPage api={api} />
}

function ReviewsPage({ api }) {
    const toast = useToast()
    const [tab, setTabState] = useState(() =>
        tabFromSearch(
            typeof window === "undefined" ? "" : window.location.search
        )
    )
    const [input, setInput] = useState("")
    const [q, setQ] = useState("")
    const searchLater = useDebounced(setQ, 250)
    const { data, error, loading, reload, current } = useReviews(tab, q, {
        api,
    })
    const searchRef = useRef(null)
    // PRs whose approval is on its way (the button is off meanwhile)
    const [approving, setApproving] = useState(() => new Set())

    function setTab(next) {
        setTabState(next)
        if (typeof window !== "undefined")
            window.history.replaceState(
                null,
                "",
                next === DEFAULT_TAB ? "/reviews" : `/reviews?tab=${next}`
            )
    }

    async function onScan() {
        try {
            await api.scanReviews()
            toast.info("Scanning the tracked repos…")
        } catch (err) {
            toast.error(err)
        }
    }

    async function onReview(pr) {
        try {
            await api.reviewPr(pr.repo, pr.number)
            toast.success(`${pr.repo}#${pr.number}: review queued`)
            reload()
        } catch (err) {
            toast.error(err)
        }
    }

    async function onApprove(pr) {
        const key = `${pr.repo}#${pr.number}`
        if (approving.has(key)) return
        setApproving((s) => new Set(s).add(key))
        try {
            await api.approvePr(pr.repo, pr.number, pr.head_sha)
            toast.success(`${key}: approved`)
            reload()
        } catch (err) {
            toast.error(err)
        } finally {
            setApproving((s) => {
                const next = new Set(s)
                next.delete(key)
                return next
            })
        }
    }

    async function onCancel(pr) {
        try {
            await api.cancelReviewRun(pr.run.id)
            toast.success(
                pr.run.status === "queued"
                    ? `${pr.repo}#${pr.number}: review dropped`
                    : `${pr.repo}#${pr.number}: agent closed`
            )
            reload()
        } catch (err) {
            toast.error(err)
        }
    }

    async function onFocus(pr) {
        try {
            await api.focusReviewRun(pr.run.id)
            toast.success(`herdr: switched to #${pr.number}`)
        } catch (err) {
            toast.error(err)
        }
    }

    const prs = (data && data.prs) || []
    const counts = (data && data.counts) || {}
    // rows of another tab / search are never shown as this one's
    const fresh = Boolean(data && current)
    // skeleton only before the first answer; later the rows on screen stay
    // (dimmed while the new tab / search loads: no blinking, no jumps)
    const skeleton = loading && !data
    const fatal = !skeleton && error && !fresh
    const stale = Boolean(data) && !fresh
    const settings = (data && data.settings) || null

    return (
        <div className="page reviews">
            <header className="rv-head">
                <div className="rv-head-title">
                    <h1 className="page-title">PR reviews</h1>
                    {settings ? (
                        <Link to="/settings" className="rv-settings muted">
                            every {settings.poll_minutes} min ·{" "}
                            {settings.parallel} parallel ·{" "}
                            {reviewAgentLabel(
                                settings.agent_kind,
                                settings.agent_model
                            )}
                            {settings.fallback_kind &&
                            settings.fallback_kind !== "none"
                                ? ` → ${reviewAgentLabel(settings.fallback_kind, settings.fallback_model)}`
                                : ""}
                        </Link>
                    ) : null}
                    {settings && settings.limited
                        ? Object.entries(settings.limited).map(
                              ([kind, until]) => (
                                  <span
                                      key={kind}
                                      className="chip rv-limited"
                                      title="Usage limit: reviews use the fallback (or wait) until then"
                                  >
                                      {limitedText(
                                          kind,
                                          until,
                                          settings.next_kind &&
                                              reviewAgentLabel(
                                                  settings.next_kind,
                                                  settings.next_model
                                              )
                                      )}
                                  </span>
                              )
                          )
                        : null}
                </div>
                <div className="rv-head-tools">
                    <input
                        ref={searchRef}
                        type="search"
                        className="input rv-search"
                        placeholder="PR number or title"
                        aria-label="Search PRs"
                        value={input}
                        onChange={(e) => {
                            setInput(e.target.value)
                            searchLater(e.target.value)
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") {
                                setInput("")
                                setQ("")
                                // replaces a search still waiting to run
                                searchLater("")
                            }
                        }}
                    />
                    <button
                        type="button"
                        className="btn btn-sm"
                        onClick={onScan}
                    >
                        Scan now
                    </button>
                    <ReviewRepos api={api} onChanged={reload} />
                </div>
            </header>

            {data && data.stats ? <ReviewStats stats={data.stats} /> : null}

            <div className="lane-tabs rv-tabs" role="tablist" aria-label="PRs">
                {REVIEW_TABS.map((t) => (
                    <button
                        key={t.key}
                        type="button"
                        role="tab"
                        aria-selected={tab === t.key}
                        className={`lane-tab${tab === t.key ? " is-current" : ""}`}
                        onClick={() => setTab(t.key)}
                    >
                        {t.label}
                        <span className="lane-count">
                            {Number.isFinite(counts[t.key])
                                ? counts[t.key]
                                : "…"}
                        </span>
                    </button>
                ))}
                {loading && data ? (
                    <span className="spinner" aria-hidden="true" />
                ) : null}
            </div>

            {skeleton ? (
                <SkeletonRows count={5} label="Loading PRs" />
            ) : fatal ? (
                <EmptyState title="Can't load the PR reviews" glyph="!">
                    <p>{errorMessage(error)}</p>
                    <button type="button" className="btn" onClick={reload}>
                        Retry
                    </button>
                </EmptyState>
            ) : error ? (
                <div className="rv-refresh-error" role="alert">
                    <span>Refresh failed: {errorMessage(error)}</span>
                    <button
                        type="button"
                        className="btn btn-sm"
                        onClick={reload}
                    >
                        Retry
                    </button>
                </div>
            ) : null}
            {skeleton || fatal ? null : prs.length ? (
                <ul
                    className={`rv-list${stale ? " rv-list-stale" : ""}`}
                    aria-label="Pull requests"
                    aria-busy={stale ? "true" : undefined}
                >
                    {prs.map((pr, i) => (
                        <Fragment key={`${pr.repo}#${pr.number}`}>
                            {tab === "all" &&
                            pr.group &&
                            pr.group !== (prs[i - 1] || {}).group ? (
                                <li
                                    className="lane-sep rv-group"
                                    role="presentation"
                                >
                                    {GROUP_LABELS[pr.group] || pr.group}
                                    <span className="lane-sep-count">
                                        {
                                            prs.filter(
                                                (p) => p.group === pr.group
                                            ).length
                                        }
                                    </span>
                                </li>
                            ) : null}
                            <PrRow
                                pr={pr}
                                onReview={onReview}
                                onApprove={onApprove}
                                approving={approving.has(
                                    `${pr.repo}#${pr.number}`
                                )}
                                onCancel={onCancel}
                                onFocus={onFocus}
                            />
                        </Fragment>
                    ))}
                </ul>
            ) : (
                <EmptyState
                    title={
                        q.trim() ? `No PRs match “${q.trim()}”` : "No PRs here"
                    }
                    glyph="∅"
                >
                    {counts.all === 0 && !q.trim()
                        ? "Track a repo in the Repos menu to see its PRs."
                        : tab === "new" && !q.trim()
                          ? "Nothing waits for your review; automatic reviews are in Queued."
                          : null}
                </EmptyState>
            )}
        </div>
    )
}
