/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useEffect, useMemo, useRef } from "react"
import { renderMarkdown } from "../lib/markdown.js"
import { relativeTime } from "../lib/time.js"

function Reply({ c }) {
    const center = c.author === "center"
    // the center agent writes Markdown (rendered escaped, no raw HTML)
    const html = useMemo(
        () => (center ? renderMarkdown(c.body) : null),
        [center, c.body]
    )
    return (
        <div className={`chat-msg ${center ? "chat-center" : "chat-me"}`}>
            <div className="msg-head">
                <span className="msg-author">{c.author || "?"}</span>
                <time dateTime={c.at}>{relativeTime(c.at)}</time>
            </div>
            {center ? (
                <div
                    className="chat-md"
                    dangerouslySetInnerHTML={{ __html: html }}
                />
            ) : (
                <p className="msg-body">{c.body}</p>
            )}
        </div>
    )
}

function Turn({ thread }) {
    const replies = thread.replies || []
    const waiting = !replies.length
    return (
        <li className="chat-turn" data-thread-id={thread.id}>
            <Reply c={thread} />
            {replies.map((r) => (
                <Reply key={r.id} c={r} />
            ))}
            {waiting && thread.status === "working" ? (
                <p className="chat-note">center is answering…</p>
            ) : null}
            {waiting && thread.status === "open" && thread.resolution ? (
                <p className="chat-note chat-failed">{thread.resolution}</p>
            ) : null}
        </li>
    )
}

/**
 * The whole task chat with the center agent, oldest first, scrolled to the
 * newest message. `threads`: the chat threads (lib/chat.js chatThreads).
 */
export default function ChatPanel({ threads }) {
    const list = threads || []
    const endRef = useRef(null)
    const last = list.at(-1)
    const lastKey = last
        ? `${last.id}:${(last.replies || []).length}:${last.status}`
        : ""
    useEffect(() => {
        const el = endRef.current
        if (el && el.scrollIntoView) el.scrollIntoView({ block: "end" })
    }, [lastKey])

    if (!list.length) {
        return (
            <div className="panel-empty">
                <p>No chat yet. Ask the center agent below.</p>
            </div>
        )
    }
    return (
        <div className="chat-panel">
            <ol className="chat-log" aria-label="Chat with the center agent">
                {list.map((t) => (
                    <Turn key={t.id} thread={t} />
                ))}
            </ol>
            <p className="chat-hint" ref={endRef}>
                Continue in the chat box below.
            </p>
        </div>
    )
}
