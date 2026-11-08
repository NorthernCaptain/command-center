/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useState } from "react"
import TextBox from "./TextBox.jsx"

/** Pinned chat input for the center agent. onSend(text) -> Promise. */
export default function ChatBar({
    onSend,
    placeholder = "Tell the center agent…",
}) {
    const [text, setText] = useState("")
    const [busy, setBusy] = useState(false)

    async function send(e) {
        if (e) e.preventDefault()
        const body = text.trim()
        if (!body || busy) return
        setBusy(true)
        try {
            await onSend(body)
            setText("")
        } catch {
            // caller toasts; keep the draft
        } finally {
            setBusy(false)
        }
    }

    return (
        <form className="chatbar" onSubmit={send}>
            <span className="chatbar-glyph" aria-hidden="true">
                ✦
            </span>
            <TextBox
                className="chatbar-input"
                aria-label="Message the center agent"
                placeholder={placeholder}
                value={text}
                disabled={busy}
                maxRows={6}
                onChange={(e) => setText(e.target.value)}
                onSubmit={() => send()}
            />
            <button
                type="submit"
                className="btn btn-accent btn-sm"
                disabled={busy || !text.trim()}
            >
                {busy ? (
                    <span className="spinner" aria-hidden="true" />
                ) : (
                    "Send"
                )}
            </button>
        </form>
    )
}
