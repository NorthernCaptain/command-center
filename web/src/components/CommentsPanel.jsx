/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useEffect, useRef, useState } from "react"
import { relativeTime } from "../lib/time.js"
import TextBox from "./TextBox.jsx"

const INTENT_LABEL = {
    note: "note",
    ask: "ask",
    change: "change",
    chat: "chat",
}

const AGENT_INTENTS = ["ask", "change", "chat"]

/** Intent for an "Ask agent" reply: the thread's own, or "ask" for notes. */
export function agentIntent(thread) {
    return thread && AGENT_INTENTS.includes(thread.intent)
        ? thread.intent
        : "ask"
}

function authorLabel(author) {
    if (author === "me") return "me"
    if (author === "center") return "center"
    if (author && author.startsWith("agent:")) return author.slice(6)
    return author || "?"
}

function Message({ c }) {
    return (
        <div
            className={`msg msg-${authorLabel(c.author) === "me" ? "me" : "agent"}`}
        >
            <div className="msg-head">
                <span className="msg-author">{authorLabel(c.author)}</span>
                <time dateTime={c.at}>{relativeTime(c.at)}</time>
            </div>
            <p className="msg-body">{c.body}</p>
        </div>
    )
}

function Thread({ thread, orphaned, active, onFocus, onReply, onStatus }) {
    const [reply, setReply] = useState("")
    const [busy, setBusy] = useState(false)
    const ref = useRef(null)
    const resolved = thread.status === "resolved"

    useEffect(() => {
        if (active && ref.current && ref.current.scrollIntoView) {
            ref.current.scrollIntoView({ block: "nearest", behavior: "smooth" })
        }
    }, [active])

    // Plain replies are notes (no agent run); "Ask agent" sends the
    // thread's intent so the center agent picks it up.
    async function send(e, intent = "note") {
        e.preventDefault()
        if (!reply.trim() || busy) return
        setBusy(true)
        try {
            await onReply(thread, reply.trim(), intent)
            setReply("")
        } catch {
            // toasted by caller
        } finally {
            setBusy(false)
        }
    }

    return (
        <li
            ref={ref}
            className={`thread thread-${thread.status || "open"}${active ? " is-active" : ""}${orphaned ? " is-orphaned" : ""}`}
            data-thread-id={thread.id}
        >
            <div className="thread-tags">
                <span className={`tag intent-${thread.intent}`}>
                    {INTENT_LABEL[thread.intent] || thread.intent}
                </span>
                {thread.status && thread.status !== "open" ? (
                    <span className={`tag tag-status tag-${thread.status}`}>
                        {thread.status}
                    </span>
                ) : null}
                {orphaned && thread.status !== "orphaned" ? (
                    <span className="tag tag-orphaned">text gone</span>
                ) : null}
            </div>
            {thread.anchor ? (
                <button
                    type="button"
                    className="thread-quote"
                    disabled={orphaned}
                    onClick={() => onFocus && onFocus(thread.id)}
                    title={
                        thread.anchor.section
                            ? `§ ${thread.anchor.section}`
                            : undefined
                    }
                >
                    {thread.anchor.exact}
                </button>
            ) : null}
            <Message c={thread} />
            {(thread.replies || []).map((r) => (
                <Message key={r.id} c={r} />
            ))}
            {thread.resolution ? (
                <p className="thread-resolution">✓ {thread.resolution}</p>
            ) : null}
            <div className="thread-actions">
                {!resolved ? (
                    <form className="thread-reply" onSubmit={send}>
                        <TextBox
                            className="input input-sm"
                            placeholder="Reply…"
                            aria-label="Reply"
                            value={reply}
                            maxRows={6}
                            onChange={(e) => setReply(e.target.value)}
                            onSubmit={(e) => send(e)}
                        />
                        <button
                            type="submit"
                            className="btn btn-sm"
                            disabled={busy || !reply.trim()}
                        >
                            Reply
                        </button>
                        <button
                            type="button"
                            className="btn btn-sm btn-ask"
                            disabled={busy || !reply.trim()}
                            title={`Reply and run the agent (${agentIntent(thread)})`}
                            onClick={(e) => send(e, agentIntent(thread))}
                        >
                            Ask agent
                        </button>
                    </form>
                ) : null}
                <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                        onStatus(thread, resolved ? "open" : "resolved")
                    }
                >
                    {resolved ? "Reopen" : "Resolve"}
                </button>
            </div>
        </li>
    )
}

/**
 * Comment threads: open first, then orphaned (anchor can't be located),
 * then resolved (collapsed).
 */
export default function CommentsPanel({
    threads,
    orphanIds = [],
    activeId,
    onFocus,
    onReply,
    onStatus,
}) {
    const [showResolved, setShowResolved] = useState(false)
    const orphanSet = new Set(orphanIds.map(String))
    const all = threads || []
    const isOrphan = (t) =>
        t.status === "orphaned" ||
        (t.status !== "resolved" && t.anchor && orphanSet.has(String(t.id)))
    const open = all.filter((t) => t.status !== "resolved" && !isOrphan(t))
    const orphaned = all.filter(isOrphan)
    const resolved = all.filter((t) => t.status === "resolved")

    if (!all.length) {
        return (
            <div className="panel-empty">
                <p>No comments yet.</p>
                <p className="muted">
                    Select text in the artifact to comment, ask or request a
                    change.
                </p>
            </div>
        )
    }

    const render = (t) => (
        <Thread
            key={t.id}
            thread={t}
            orphaned={isOrphan(t)}
            active={String(activeId) === String(t.id)}
            onFocus={onFocus}
            onReply={onReply}
            onStatus={onStatus}
        />
    )

    return (
        <div className="comments">
            {open.length ? (
                <ul className="threads">{open.map(render)}</ul>
            ) : (
                <p className="muted">No open threads.</p>
            )}
            {orphaned.length ? (
                <>
                    <h3 className="panel-sub">Orphaned · {orphaned.length}</h3>
                    <ul className="threads">{orphaned.map(render)}</ul>
                </>
            ) : null}
            {resolved.length ? (
                <>
                    <button
                        type="button"
                        className="panel-sub panel-toggle"
                        aria-expanded={showResolved}
                        onClick={() => setShowResolved((v) => !v)}
                    >
                        Resolved · {resolved.length} {showResolved ? "▾" : "▸"}
                    </button>
                    {showResolved ? (
                        <ul className="threads">{resolved.map(render)}</ul>
                    ) : null}
                </>
            ) : null}
        </div>
    )
}
