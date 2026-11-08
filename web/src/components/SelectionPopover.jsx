/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { createAnchor } from "../lib/anchoring.js"
import TextBox from "./TextBox.jsx"

export const INTENTS = [
    { id: "note", label: "Comment", hint: "Note for later" },
    { id: "ask", label: "Ask", hint: "The center agent answers in the thread" },
    { id: "change", label: "Change", hint: "The center agent edits this part" },
]

/** 4th intent, only while the task has a live worker agent. */
export const AGENT_INTENT = {
    id: "agent",
    label: "Send to agent",
    hint: "Sent to the worker agent (queued while it is busy)",
}

export function intentsFor(agentLive) {
    return agentLive ? [...INTENTS, AGENT_INTENT] : INTENTS
}

function rectOf(range) {
    if (range && typeof range.getBoundingClientRect === "function") {
        const r = range.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, left: r.left, width: r.width }
    }
    return { top: 0, bottom: 0, left: 0, width: 0 }
}

/** Popover position (fixed) above the selection, or below near the top. */
export function popoverPosition(rect, viewportWidth = 1024, half = 130) {
    const above = rect.top > 72
    const top = above ? rect.top - 56 : rect.bottom + 10
    const center = rect.left + rect.width / 2
    const left = Math.max(half + 8, Math.min(viewportWidth - half - 8, center))
    return { top: Math.max(8, top), left }
}

/**
 * Comment / Ask / Change (and Send to agent when `agentLive`) on a
 * selection inside the artifact (rootRef).
 * Desktop: popover above the selection. Phone: the same popover (native
 * long-press selection) plus a floating fallback button; the composer
 * becomes a bottom sheet.
 * onSubmit({ intent, body, anchor }) -> Promise
 */
export default function SelectionPopover({ rootRef, onSubmit, agentLive }) {
    const intents = intentsFor(agentLive)
    // Half the popover width (wider with the 4th intent), for clamping.
    const halfRef = useRef(130)
    halfRef.current = agentLive ? 185 : 130
    const [sel, setSel] = useState(null) // { anchor, pos }
    const [intent, setIntent] = useState(null)
    const [body, setBody] = useState("")
    const [busy, setBusy] = useState(false)
    const composing = useRef(false)
    composing.current = Boolean(intent)

    const check = useCallback(() => {
        if (composing.current) return
        const s = document.getSelection ? document.getSelection() : null
        const root = rootRef.current
        if (!s || !root || s.rangeCount === 0 || s.isCollapsed) {
            setSel(null)
            return
        }
        const range = s.getRangeAt(0)
        if (!root.contains(range.commonAncestorContainer)) {
            setSel(null)
            return
        }
        const anchor = createAnchor(root, range)
        if (!anchor) {
            setSel(null)
            return
        }
        setSel({
            anchor,
            pos: popoverPosition(
                rectOf(range),
                window.innerWidth,
                halfRef.current
            ),
        })
    }, [rootRef])

    useEffect(() => {
        let t = null
        const later = () => {
            clearTimeout(t)
            t = setTimeout(check, 140)
        }
        const root = rootRef.current
        document.addEventListener("selectionchange", later)
        if (root) {
            root.addEventListener("mouseup", check)
            root.addEventListener("keyup", check)
            root.addEventListener("touchend", later)
        }
        return () => {
            clearTimeout(t)
            document.removeEventListener("selectionchange", later)
            if (root) {
                root.removeEventListener("mouseup", check)
                root.removeEventListener("keyup", check)
                root.removeEventListener("touchend", later)
            }
        }
    }, [check, rootRef])

    function reset() {
        setIntent(null)
        setBody("")
        setSel(null)
        const s = document.getSelection && document.getSelection()
        if (s && s.removeAllRanges) s.removeAllRanges()
    }

    async function submit(e) {
        if (e) e.preventDefault()
        if (!body.trim() || !sel || busy) return
        setBusy(true)
        try {
            const live = intents.some((i) => i.id === intent)
            await onSubmit({
                intent: live ? intent : "note",
                body: body.trim(),
                anchor: sel.anchor,
            })
            reset()
        } catch {
            // caller toasts; keep the draft
        } finally {
            setBusy(false)
        }
    }

    if (!sel) return null
    const keep = (e) => e.preventDefault() // keep the text selection on click

    if (intent) {
        // The agent can go away while composing: fall back to a comment.
        const meta = intents.find((i) => i.id === intent) || INTENTS[0]
        return (
            <form
                className="sel-composer"
                style={{ top: sel.pos.top, left: sel.pos.left }}
                onSubmit={submit}
                aria-label={`${meta.label} on selection`}
            >
                <blockquote className="sel-quote">
                    {sel.anchor.exact}
                </blockquote>
                <TextBox
                    className="input"
                    autoFocus
                    rows={3}
                    placeholder={meta.hint}
                    aria-label={meta.label}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Escape") reset()
                    }}
                    onSubmit={(e) => submit(e)}
                />
                <div className="sel-composer-actions">
                    <div className="seg" role="group" aria-label="Intent">
                        {intents.map((i) => (
                            <button
                                key={i.id}
                                type="button"
                                className={`seg-btn intent-${i.id}${i.id === meta.id ? " is-on" : ""}`}
                                aria-pressed={i.id === meta.id}
                                onClick={() => setIntent(i.id)}
                            >
                                {i.label}
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={reset}
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        className="btn btn-accent btn-sm"
                        disabled={busy || !body.trim()}
                    >
                        Send
                    </button>
                </div>
            </form>
        )
    }

    return (
        <>
            <div
                className="sel-popover"
                role="toolbar"
                aria-label="Selection actions"
                style={{ top: sel.pos.top, left: sel.pos.left }}
                onMouseDown={keep}
            >
                {intents.map((i) => (
                    <button
                        key={i.id}
                        type="button"
                        className={`sel-btn intent-${i.id}`}
                        onMouseDown={keep}
                        onClick={() => setIntent(i.id)}
                    >
                        {i.label}
                    </button>
                ))}
            </div>
            <button
                type="button"
                className="sel-fab"
                aria-label="Comment on selection"
                onMouseDown={keep}
                onClick={() => setIntent("note")}
            >
                <span aria-hidden="true">✎</span> Comment
            </button>
        </>
    )
}
