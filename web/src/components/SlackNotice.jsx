/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useState } from "react"
import { relativeTime } from "../lib/time.js"

// The reply in the task's Slack thread that says we track the request in
// Asana (posted through Brain). Shown in the task header so a missing or
// failed one is seen and can be retried: the people who asked should know
// we work on it. Dismiss hides it (Leo handled it, or does not want it).

const MAX_ANSWER = 400

const VIEW = {
    missing: {
        tone: "warn",
        text: "The Slack thread has not been told about the Asana task.",
        action: "post",
    },
    pending: {
        tone: "info",
        text: "Posting the Asana link to the Slack thread (Brain)…",
        action: "check",
    },
    posted: {
        tone: "ok",
        text: "Slack thread told about the Asana task",
    },
    not_posted: {
        tone: "warn",
        text: "Brain did not post the Asana link to the Slack thread.",
        action: "retry",
    },
    failed: {
        tone: "warn",
        text: "Posting the Asana link to the Slack thread failed.",
        action: "retry",
    },
    unknown: {
        tone: "warn",
        text: "Not sure the Asana link reached the Slack thread: check it.",
        action: "retry",
    },
}

const ACTION_LABEL = {
    post: "Post to Slack",
    retry: "Try again",
    check: "Check now",
}

/** Does the notice need Leo (a warning in the header)? */
export function noticeNeedsAttention(notice) {
    return Boolean(notice && VIEW[notice.status]?.tone === "warn")
}

export default function SlackNotice({ notice, onPost, onCheck, onDismiss }) {
    const [busy, setBusy] = useState(false)
    if (!notice || !VIEW[notice.status]) return null
    const view = VIEW[notice.status]
    const detail = notice.error || notice.answer
    const clipped =
        detail && detail.length > MAX_ANSWER
            ? `${detail.slice(0, MAX_ANSWER)}…`
            : detail

    async function act(fn) {
        if (busy) return
        setBusy(true)
        try {
            await fn()
        } catch {
            // the caller toasts
        } finally {
            setBusy(false)
        }
    }

    return (
        <div
            className={`slack-notice slack-notice-${view.tone}`}
            role={view.tone === "warn" ? "alert" : "status"}
        >
            <p className="slack-notice-line">
                <span aria-hidden="true">
                    {view.tone === "ok"
                        ? "✓"
                        : view.tone === "warn"
                          ? "!"
                          : "…"}
                </span>{" "}
                {view.text}
                {notice.at ? (
                    <time className="slack-notice-time" dateTime={notice.at}>
                        {" "}
                        · {relativeTime(notice.at)}
                    </time>
                ) : null}
                {notice.attempts > 1 ? (
                    <span className="slack-notice-time">
                        {" "}
                        · try {notice.attempts}
                    </span>
                ) : null}
            </p>
            {view.tone === "warn" && notice.reason ? (
                <p className="slack-notice-reason">
                    <span className="slack-notice-why">Why:</span>{" "}
                    {notice.reason}
                </p>
            ) : null}
            {view.tone === "warn" && clipped && !notice.reason ? (
                <blockquote className="slack-notice-answer">
                    {notice.error ? "Error: " : "Brain: "}
                    {clipped}
                </blockquote>
            ) : null}
            {view.tone === "warn" &&
            notice.reason &&
            detail &&
            detail.trim() !== `RESULT: NOT POSTED - ${notice.reason}` ? (
                <details className="slack-notice-more">
                    <summary>Brain's full answer</summary>
                    <blockquote className="slack-notice-answer">
                        {clipped}
                    </blockquote>
                </details>
            ) : null}
            <div className="slack-notice-actions">
                {view.action ? (
                    <button
                        type="button"
                        className={`btn btn-sm${view.tone === "warn" ? " btn-accent" : " btn-ghost"}`}
                        disabled={busy}
                        onClick={() =>
                            act(view.action === "check" ? onCheck : onPost)
                        }
                    >
                        {ACTION_LABEL[view.action]}
                    </button>
                ) : null}
                {view.tone === "warn" && onDismiss ? (
                    <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        title="Handled it myself, or not needed: hide this"
                        onClick={() => act(onDismiss)}
                    >
                        Dismiss
                    </button>
                ) : null}
                <a
                    className="btn btn-ghost btn-sm"
                    href={notice.thread}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    Thread ↗
                </a>
                {notice.transcript ? (
                    <a
                        className="btn btn-ghost btn-sm"
                        href={notice.transcript}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Brain's transcript of this job (Brain admins)"
                    >
                        Brain transcript ↗
                    </a>
                ) : null}
                {notice.brain_job ? (
                    <code className="slack-notice-job" title="Brain job">
                        {notice.brain_job}
                    </code>
                ) : null}
            </div>
        </div>
    )
}
