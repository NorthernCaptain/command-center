/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useState } from "react"
import TextBox from "./TextBox.jsx"
import { chatDraft, saveChatDraft } from "../lib/chat.js"

/**
 * Pinned chat input for the center agent. onSend(text) -> Promise.
 * draftKey (the task id): unsent text is saved on this device and comes
 * back when the page is opened again; a sent message clears it. Remount
 * (key) for another task.
 */
export default function ChatBar({
    onSend,
    draftKey = null,
    placeholder = "Tell the center agent…",
}) {
    const [text, setText] = useState(() =>
        draftKey == null ? "" : chatDraft(draftKey)
    )
    function edit(next) {
        setText(next)
        if (draftKey != null) saveChatDraft(draftKey, next)
    }
    const [busy, setBusy] = useState(false)

    async function send(e) {
        if (e) e.preventDefault()
        const body = text.trim()
        if (!body || busy) return
        setBusy(true)
        try {
            await onSend(body)
            edit("")
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
                onChange={(e) => edit(e.target.value)}
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
