/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Task-page panels for the phase 2 worker flow: the herdr agent, the
// per-repo deliverables (PRs), PR feedback rounds and review results.

import { useState } from "react"
import AgentChip from "./AgentChip.jsx"
import { relativeTime } from "../lib/time.js"
import {
    FB_KIND_LABELS,
    FB_STATUS_LABELS,
    feedbackState,
    groupRounds,
    roundSummary,
} from "../lib/feedback.js"
import {
    changeRecordBlocker,
    deliverableState,
    watchFor,
} from "../lib/worker.js"
import { AGENT_KIND_LABELS } from "../lib/constants.js"

export { groupRounds, roundSummary }

/** "#812" from a GitHub pull URL (or null). */
export function prNumber(url) {
    const m = /\/pull\/(\d+)/.exec(String(url || ""))
    return m ? `#${m[1]}` : null
}

function ExtLink({ href, children, className = "ext-link", label }) {
    if (!href) return null
    return (
        <a
            className={className}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={label}
        >
            {children}
        </a>
    )
}

function firstLine(text, max = 90) {
    const line = String(text || "").split("\n")[0]
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// --- Agent ---------------------------------------------------------------

/**
 * agent = { state, kind, name, session_id, pane_id, outbox } | null
 * outbox = pending and failed prompts [{ id, text, reason, status, error,
 *          created_at }]. Failed ones are never resent automatically:
 *          Retry sends one again, Cancel drops a pending one.
 * onAction(name, body) runs a worker action ("retry" / "cancel" { id }).
 */
export function AgentPanel({ agent, outbox, task, onAction }) {
    const queued = outbox || []
    const error = task && task.flags && task.flags.error
    return (
        <div className="agent-panel">
            {agent ? (
                <dl className="kv">
                    <dt>state</dt>
                    <dd>
                        <AgentChip state={agent.state} name={agent.name} />
                    </dd>
                    <dt>kind</dt>
                    <dd>
                        {AGENT_KIND_LABELS[agent.kind] || agent.kind || "—"}
                    </dd>
                    <dt>name</dt>
                    <dd>{agent.name ? <code>{agent.name}</code> : "—"}</dd>
                    <dt>session</dt>
                    <dd>
                        {agent.session_id ? (
                            <code className="kv-id">{agent.session_id}</code>
                        ) : (
                            "—"
                        )}
                    </dd>
                    {agent.pane_id ? (
                        <>
                            <dt>pane</dt>
                            <dd>
                                <code>{agent.pane_id}</code>
                            </dd>
                        </>
                    ) : null}
                </dl>
            ) : (
                <p className="muted">
                    No live agent.
                    {task && task.worker_kind
                        ? ` Last worker: ${AGENT_KIND_LABELS[task.worker_kind] || task.worker_kind}.`
                        : ""}
                </p>
            )}
            {error ? (
                <p className="task-error" role="note">
                    Last error: {error}
                </p>
            ) : null}
            <h3 className="panel-sub">
                Prompts for the agent
                <span className="lane-count">{queued.length}</span>
            </h3>
            {queued.length ? (
                <ol className="outbox">
                    {queued.map((o) => (
                        <li
                            key={o.id}
                            className={`outbox-item outbox-${o.status || "pending"}`}
                        >
                            <div className="outbox-head">
                                <span className="tag">{o.reason}</span>
                                {o.status && o.status !== "pending" ? (
                                    <span className={`tag tag-${o.status}`}>
                                        {o.status}
                                    </span>
                                ) : null}
                                {o.created_at ? (
                                    <time
                                        className="row-time"
                                        dateTime={o.created_at}
                                    >
                                        {relativeTime(o.created_at)}
                                    </time>
                                ) : null}
                            </div>
                            <details className="outbox-text">
                                <summary>{firstLine(o.text)}</summary>
                                <pre>{o.text}</pre>
                            </details>
                            {o.error ? (
                                <p className="error-text outbox-error">
                                    {o.error}
                                </p>
                            ) : null}
                            {onAction ? (
                                <div className="outbox-actions">
                                    {o.status === "failed" ? (
                                        <button
                                            type="button"
                                            className="btn btn-sm"
                                            aria-label={`Retry prompt ${o.id}`}
                                            onClick={() =>
                                                onAction("retry", { id: o.id })
                                            }
                                        >
                                            Retry
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            className="btn btn-ghost btn-sm"
                                            aria-label={`Cancel prompt ${o.id}`}
                                            onClick={() =>
                                                onAction("cancel", { id: o.id })
                                            }
                                        >
                                            Cancel
                                        </button>
                                    )}
                                </div>
                            ) : null}
                        </li>
                    ))}
                </ol>
            ) : (
                <p className="muted">Nothing queued for the agent.</p>
            )}
        </div>
    )
}

// --- Deliverables ----------------------------------------------------------

/** A repo can have several deliverables (follow-ups): key by repo, PR or
 * branch and disposition, plus the position (the list only grows). */
const dlvKey = (d, i) => `${i}:${d.repo}:${d.pr || d.branch}:${d.disposition}`

/**
 * "Can I press Done?" for the deliverables (the server's close rule) and,
 * on a SOC2-area task, its change record (changeRecord: the task payload's
 * change_record).
 */
export function DeliverablesSummary({
    deliverables,
    prs,
    changeRecord,
    manual,
}) {
    const list = deliverables || []
    const manualList = manual || []
    const blocking = list.filter(
        (d) => !deliverableState(d, watchFor(prs, d)).done
    )
    const manualOpen = manualList.filter((m) => !m.done_at)
    const total = list.length + manualList.length
    const blocked = blocking.length + manualOpen.length
    const record = changeRecordBlocker(changeRecord)
    if (record || blocked)
        return (
            <div className="dlv-summary is-blocked" role="status">
                <strong>
                    {blocked
                        ? `${blocked} of ${total} block Done`
                        : "The SOC2 change record blocks Done"}
                </strong>
                <ul>
                    {blocking.map((d, i) => (
                        <li key={dlvKey(d, i)}>
                            <code>{d.repo}</code>:{" "}
                            {deliverableState(d, watchFor(prs, d)).reason}
                        </li>
                    ))}
                    {manualOpen.map((m) => (
                        <li key={m.id}>manual: {m.text} (not checked off)</li>
                    ))}
                    {record ? (
                        <li className="dlv-record">SOC2: {record}</li>
                    ) : null}
                </ul>
            </div>
        )
    if (!total)
        return (
            <p className="dlv-summary is-clear" role="status">
                ✓ No deliverables: nothing blocks Done.
            </p>
        )
    return (
        <p className="dlv-summary is-clear" role="status">
            ✓ All {total} done (
            {manualList.length
                ? "merged, no change or checked off"
                : "merged or no change"}
            ): nothing blocks Done.
        </p>
    )
}

/**
 * deliverables: task.deliverables; prs: pr_watch rows; candidates:
 * [{ repo, url, reason }] (unclaimed PRs on the branch).
 * onNoChange(repo, created_at), onClaim(url) -> Promise.
 * manual: task.manual_deliverables (Leo's checklist, e.g. a manual install
 * after merge); onAddManual(text), onSetManual(id, done),
 * onRemoveManual(id) -> Promise.
 */
export function DeliverablesPanel({
    deliverables,
    prs,
    changeRecord,
    candidates,
    manual,
    onNoChange,
    onClaim,
    onAddManual,
    onSetManual,
    onRemoveManual,
}) {
    const list = deliverables || []
    const cands = candidates || []
    const manualList = manual || []
    const [url, setUrl] = useState("")
    const [step, setStep] = useState("")
    const [busy, setBusy] = useState(null)

    async function run(key, fn) {
        setBusy(key)
        try {
            await fn()
            return true
        } catch {
            return false // caller toasts
        } finally {
            setBusy(null)
        }
    }

    return (
        <div className="deliverables">
            <DeliverablesSummary
                deliverables={list}
                prs={prs}
                changeRecord={changeRecord}
                manual={manualList}
            />
            {list.length ? (
                <ul className="dlv-list">
                    {list.map((d, i) => {
                        const w = watchFor(prs, d)
                        const st = deliverableState(d, w)
                        return (
                            <li
                                key={dlvKey(d, i)}
                                className={`dlv dlv-${d.disposition} ${st.done ? "is-done" : "is-blocking"}`}
                            >
                                <div className="dlv-head">
                                    <span
                                        className="dlv-mark"
                                        aria-hidden="true"
                                    >
                                        {st.done ? "✓" : "●"}
                                    </span>
                                    <span className="dlv-repo">{d.repo}</span>
                                    <span
                                        className={`tag tag-${d.disposition}`}
                                    >
                                        {d.merged_at
                                            ? `merged ${relativeTime(d.merged_at)}`
                                            : st.label}
                                    </span>
                                    <span className="dlv-verdict">
                                        {st.done ? "done" : "blocks Done"}
                                    </span>
                                </div>
                                {d.branch ? (
                                    <code className="dlv-branch">
                                        {d.branch}
                                    </code>
                                ) : null}
                                <div className="dlv-sub">
                                    {d.pr ? (
                                        <ExtLink
                                            href={d.pr}
                                            label={`Pull request ${prNumber(d.pr) || d.pr} on GitHub`}
                                        >
                                            PR {prNumber(d.pr) || ""} ↗
                                        </ExtLink>
                                    ) : null}
                                    {w && w.state ? (
                                        <span className="tag">{w.state}</span>
                                    ) : null}
                                    {w && w.ci_state ? (
                                        <span
                                            className={`tag tag-ci-${w.ci_state}`}
                                        >
                                            CI {w.ci_state}
                                        </span>
                                    ) : null}
                                    {w && w.last_checked_at ? (
                                        <span className="row-time">
                                            checked{" "}
                                            {relativeTime(w.last_checked_at)}
                                        </span>
                                    ) : null}
                                    {d.disposition === "pending" ? (
                                        <button
                                            type="button"
                                            className="btn btn-ghost btn-xs"
                                            aria-label={`Mark ${d.repo} as no change`}
                                            disabled={busy !== null}
                                            onClick={() =>
                                                run(`nc-${d.repo}`, () =>
                                                    onNoChange(
                                                        d.repo,
                                                        d.created_at
                                                    )
                                                )
                                            }
                                        >
                                            No change
                                        </button>
                                    ) : null}
                                </div>
                            </li>
                        )
                    })}
                </ul>
            ) : (
                <p className="muted">No work repos yet.</p>
            )}

            <h3 className="panel-sub">
                Manual
                <span className="lane-count">
                    {manualList.filter((m) => !m.done_at).length}
                </span>
            </h3>
            {manualList.length ? (
                <ul className="dlv-list">
                    {manualList.map((m) => (
                        <li
                            key={m.id}
                            className={`dlv dlv-manual ${m.done_at ? "is-done" : "is-blocking"}`}
                        >
                            <div className="dlv-head">
                                <label className="dlv-check">
                                    <input
                                        type="checkbox"
                                        checked={Boolean(m.done_at)}
                                        disabled={busy !== null}
                                        onChange={(e) => {
                                            const done = e.target.checked
                                            run(`m-${m.id}`, () =>
                                                onSetManual(m.id, done)
                                            )
                                        }}
                                    />
                                    <span>{m.text}</span>
                                </label>
                                <span className="dlv-verdict">
                                    {m.done_at
                                        ? `done ${relativeTime(m.done_at)}`
                                        : "blocks Done"}
                                </span>
                                <button
                                    type="button"
                                    className="btn btn-ghost btn-xs"
                                    aria-label={`Remove ${m.text}`}
                                    disabled={busy !== null}
                                    onClick={() =>
                                        run(`rm-${m.id}`, () =>
                                            onRemoveManual(m.id)
                                        )
                                    }
                                >
                                    Remove
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="muted">
                    None. Add one for work outside the PRs (a manual install
                    after merge): the task closes only once it is checked off.
                </p>
            )}
            <form
                className="dlv-claim"
                onSubmit={async (e) => {
                    e.preventDefault()
                    const value = step.trim()
                    if (!value) return
                    if (await run("manual-add", () => onAddManual(value)))
                        setStep("")
                }}
            >
                <input
                    className="input input-sm"
                    type="text"
                    maxLength={300}
                    placeholder="e.g. Install on the farm after merge"
                    aria-label="Manual deliverable"
                    value={step}
                    onChange={(e) => setStep(e.target.value)}
                />
                <button
                    type="submit"
                    className="btn btn-sm"
                    disabled={busy !== null || !step.trim()}
                >
                    Add
                </button>
            </form>

            <h3 className="panel-sub">
                Unclaimed PRs
                <span className="lane-count">{cands.length}</span>
            </h3>
            {cands.length ? (
                <ul className="dlv-list">
                    {cands.map((c) => (
                        <li key={c.url} className="dlv dlv-candidate">
                            <div className="dlv-head">
                                <span className="dlv-repo">{c.repo}</span>
                                <ExtLink href={c.url}>
                                    PR {prNumber(c.url) || ""} ↗
                                </ExtLink>
                            </div>
                            {c.reason ? (
                                <p className="dlv-reason">{c.reason}</p>
                            ) : null}
                            <button
                                type="button"
                                className="btn btn-sm"
                                aria-label={`Claim ${c.url}`}
                                disabled={busy !== null}
                                onClick={() =>
                                    run(`claim-${c.url}`, () => onClaim(c.url))
                                }
                            >
                                Claim
                            </button>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="muted">None found on the task branches.</p>
            )}
            <form
                className="dlv-claim"
                onSubmit={async (e) => {
                    e.preventDefault()
                    const value = url.trim()
                    if (!value) return
                    if (await run("claim-manual", () => onClaim(value)))
                        setUrl("")
                }}
            >
                <input
                    className="input input-sm"
                    type="url"
                    inputMode="url"
                    placeholder="https://github.com/…/pull/123"
                    aria-label="Pull request URL to claim"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                />
                <button
                    type="submit"
                    className="btn btn-sm"
                    disabled={busy !== null || !url.trim()}
                >
                    Claim PR
                </button>
            </form>
        </div>
    )
}

// --- Feedback --------------------------------------------------------------

function FeedbackItem({ item, onReopen, busy }) {
    const resolved = ["fixed", "answered", "declined"].includes(item.status)
    const where = item.path
        ? `${item.path}${item.line ? `:${item.line}` : ""}`
        : null
    return (
        <li className={`fb fb-${item.status}`}>
            <div className="fb-head">
                <span className={`tag fb-kind fb-kind-${item.kind}`}>
                    {FB_KIND_LABELS[item.kind] || item.kind}
                </span>
                {item.author ? (
                    <span className="fb-author">@{item.author}</span>
                ) : null}
                <span className={`tag tag-${item.status}`}>
                    {FB_STATUS_LABELS[item.status] || item.status}
                </span>
                {item.verified ? (
                    <span className="tag tag-verified">✓ verified</span>
                ) : resolved ? (
                    <span className="tag">unverified</span>
                ) : null}
                {item.verify_failures ? (
                    <span className="tag tag-failed">
                        verify failed ×{item.verify_failures}
                    </span>
                ) : null}
            </div>
            {where ? <code className="fb-path">{where}</code> : null}
            {item.summary ? <p className="fb-summary">{item.summary}</p> : null}
            {item.note ? <p className="fb-note">{item.note}</p> : null}
            <div className="fb-links">
                <ExtLink href={item.url}>
                    {item.kind === "ci_failure" ? "check" : "comment"} ↗
                </ExtLink>
                <ExtLink href={item.reply_url}>reply ↗</ExtLink>
                {item.commit ? (
                    <code title={item.commit}>
                        {String(item.commit).slice(0, 7)}
                    </code>
                ) : null}
                {prNumber(item.pr) ? (
                    <ExtLink href={item.pr}>PR {prNumber(item.pr)} ↗</ExtLink>
                ) : null}
                {item.status === "no_action" ? (
                    <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        aria-label={`Reopen feedback ${item.id}`}
                        disabled={busy}
                        onClick={() => onReopen(item)}
                    >
                        Reopen
                    </button>
                ) : null}
            </div>
        </li>
    )
}

/** feedback: folded feedback items; onReopen(item) -> Promise. */
export function FeedbackPanel({ feedback, onReopen }) {
    const [busy, setBusy] = useState(false)
    const rounds = groupRounds(feedback)
    if (!rounds.length) return <p className="muted">No PR feedback yet.</p>

    async function reopen(item) {
        setBusy(true)
        try {
            await onReopen(item)
        } catch {
            // caller toasts
        } finally {
            setBusy(false)
        }
    }

    const st = feedbackState(feedback)
    return (
        <div className="feedback">
            {st ? (
                <p className={`fb-state fb-state-${st.state}`} role="status">
                    {st.state === "addressed" ? "✓ " : ""}
                    {st.label}
                </p>
            ) : null}
            {rounds.map((r) => (
                <section
                    key={r.round}
                    className="fb-round"
                    aria-label={`Round ${r.round}`}
                >
                    <h3 className="panel-sub">
                        Round {r.round}
                        <span className="fb-round-sum">
                            {roundSummary(r.items)}
                        </span>
                    </h3>
                    <ul className="fb-list">
                        {r.items.map((it) => (
                            <FeedbackItem
                                key={it.id}
                                item={it}
                                busy={busy}
                                onReopen={reopen}
                            />
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    )
}

// --- Reviews ---------------------------------------------------------------

/**
 * reviews: latest review-orchestrator result per work folder:
 * [{ folder, repo?, branch?, status, timestamp, file?, dashboardUrl }]
 */
export function ReviewsPanel({ reviews }) {
    const list = (reviews || []).filter(Boolean)
    if (!list.length) return <p className="muted">No reviews yet.</p>
    return (
        <ul className="reviews">
            {list.map((r, i) => {
                const status = String(r.status || "unknown")
                const dash = r.dashboardUrl || r.dashboard_url
                return (
                    <li
                        key={r.folder || r.file || i}
                        className={`review rv-${status.toLowerCase()}`}
                    >
                        <div className="dlv-head">
                            <span className="dlv-repo">
                                {r.folder || r.repo || "review"}
                            </span>
                            <span className={`tag rv-status`}>{status}</span>
                        </div>
                        <div className="dlv-sub">
                            {r.branch ? <code>{r.branch}</code> : null}
                            {r.timestamp ? (
                                <time
                                    className="row-time"
                                    dateTime={r.timestamp}
                                >
                                    {relativeTime(r.timestamp)}
                                </time>
                            ) : null}
                            <ExtLink
                                href={dash}
                                label={`Open the review dashboard for ${r.folder || r.repo || "this folder"}`}
                            >
                                Dashboard ↗
                            </ExtLink>
                        </div>
                    </li>
                )
            })}
        </ul>
    )
}
