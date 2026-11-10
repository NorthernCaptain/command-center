/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Multi-line text input used for every free-text field (capture, chat,
// comments, replies). Enter inserts a newline; Cmd+Enter / Ctrl+Enter
// submits (phones use the field's Send button). Grows with its content up to
// maxRows, then scrolls.

import { useLayoutEffect, useRef } from "react"

/** Cmd/Ctrl+Enter, not while an IME is composing. */
export function isSubmitKey(e) {
    return Boolean(
        e.key === "Enter" &&
        (e.metaKey || e.ctrlKey) &&
        !(e.nativeEvent && e.nativeEvent.isComposing)
    )
}

/** Label for the submit shortcut on this platform. */
export function submitHint(
    platform = typeof navigator !== "undefined" ? navigator.platform : ""
) {
    return /mac|iphone|ipad/i.test(platform || "") ? "⌘⏎" : "Ctrl+⏎"
}

export default function TextBox({
    value,
    onSubmit,
    onKeyDown,
    maxRows = 8,
    rows = 1,
    ref,
    ...rest
}) {
    const own = useRef(null)
    const setRef = (el) => {
        own.current = el
        if (typeof ref === "function") ref(el)
        else if (ref) ref.current = el
    }

    // Auto-grow: reset, then fit the content (capped at maxRows lines).
    // The reset shrinks the box and loses its scroll position, so once it
    // scrolls keep the caret in view: typing at the end follows the end,
    // elsewhere the previous position is restored.
    useLayoutEffect(() => {
        const el = own.current
        if (!el) return
        const scrolled = el.scrollTop
        el.style.height = "auto"
        const style = window.getComputedStyle(el)
        const line = parseFloat(style.lineHeight) || 20
        const pad =
            (parseFloat(style.paddingTop) || 0) +
            (parseFloat(style.paddingBottom) || 0)
        const max = line * maxRows + pad
        const next = Math.min(el.scrollHeight, max)
        if (next > 0) el.style.height = `${next}px`
        const overflows = el.scrollHeight > max
        el.style.overflowY = overflows ? "auto" : "hidden"
        if (overflows) {
            const atEnd = el.selectionEnd >= String(el.value).length
            el.scrollTop = atEnd ? el.scrollHeight : scrolled
        }
    }, [value, maxRows])

    function handleKeyDown(e) {
        if (onKeyDown) onKeyDown(e)
        if (e.defaultPrevented) return
        if (isSubmitKey(e)) {
            e.preventDefault()
            if (onSubmit) onSubmit(e)
        }
    }

    return (
        <textarea
            {...rest}
            ref={setRef}
            rows={rows}
            value={value}
            enterKeyHint="enter"
            onKeyDown={handleKeyDown}
        />
    )
}
