/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useState } from "react"
import { relativeTime } from "../lib/time.js"

// The reply in the task's Slack thread that says we track the request in
// Asana (posted through Brain). Shown in the task header so a missing or
// failed one is seen and can be retried: the people who asked should know
// we work on it.

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

export default function SlackNotice({ notice, onPost, onCheck }) {
    const [busy, setBusy] = useState(false)
    if (!notice || !VIEW[notice.status]) return null
    const view = VIEW[notice.status]
    const detail = notice.error || notice.answer
    const clipped =
        detail && detail.length > MAX_ANSWER
            ? `${detail.slice(0, MAX_ANSWER)}…`
            : detail

    async function act() {
        if (busy) return
        setBusy(true)
        try {
            await (view.action === "check" ? onCheck() : onPost())
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
            {clipped && view.tone === "warn" ? (
                <blockquote className="slack-notice-answer">
                    {notice.error ? "Error: " : "Brain: "}
                    {clipped}
                </blockquote>
            ) : null}
            <div className="slack-notice-actions">
                {view.action ? (
                    <button
                        type="button"
                        className={`btn btn-sm${view.tone === "warn" ? " btn-accent" : " btn-ghost"}`}
                        disabled={busy}
                        onClick={act}
                    >
                        {ACTION_LABEL[view.action]}
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
                {notice.brain_job ? (
                    <code className="slack-notice-job" title="Brain job">
                        {notice.brain_job}
                    </code>
                ) : null}
            </div>
        </div>
    )
}
