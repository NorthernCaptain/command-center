/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useEffect, useRef, useState } from "react"
import { errorMessage } from "../lib/api.js"
import { snoozePresets } from "../lib/time.js"

/**
 * Snooze button + menu. onPick({ at } | { text }) is awaited; the menu
 * closes when it resolves. When it rejects (e.g. the server can't read the
 * custom text) the menu stays open and shows the error.
 */
export default function SnoozeMenu({
    onPick,
    label = "Snooze",
    className = "",
}) {
    const [open, setOpen] = useState(false)
    const [text, setText] = useState("")
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)
    const ref = useRef(null)

    useEffect(() => {
        if (!open) return
        const onDown = (e) => {
            if (ref.current && !ref.current.contains(e.target)) setOpen(false)
        }
        const onKey = (e) => e.key === "Escape" && setOpen(false)
        document.addEventListener("pointerdown", onDown)
        document.addEventListener("keydown", onKey)
        return () => {
            document.removeEventListener("pointerdown", onDown)
            document.removeEventListener("keydown", onKey)
        }
    }, [open])

    async function pick(choice) {
        setBusy(true)
        setError(null)
        try {
            await onPick(choice)
            setOpen(false)
            setText("")
        } catch (err) {
            setError(errorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className={`snooze ${className}`} ref={ref}>
            <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => {
                    setError(null)
                    setOpen((v) => !v)
                }}
            >
                <span aria-hidden="true">◔</span> {label}
            </button>
            {open ? (
                <div className="menu" role="menu" aria-label="Snooze until">
                    {snoozePresets().map((p) => (
                        <button
                            key={p.id}
                            type="button"
                            role="menuitem"
                            className="menu-item"
                            disabled={busy}
                            onClick={() => pick({ at: p.at, label: p.label })}
                        >
                            {p.label}
                        </button>
                    ))}
                    <form
                        className="menu-custom"
                        onSubmit={(e) => {
                            e.preventDefault()
                            if (text.trim()) pick({ text: text.trim() })
                        }}
                    >
                        <input
                            type="text"
                            className="input input-sm"
                            placeholder="e.g. 3d, friday 2pm"
                            aria-label="Custom snooze"
                            value={text}
                            onChange={(e) => {
                                setText(e.target.value)
                                setError(null)
                            }}
                        />
                        <button
                            type="submit"
                            className="btn btn-sm"
                            disabled={busy || !text.trim()}
                        >
                            Set
                        </button>
                    </form>
                    {error ? (
                        <p className="menu-error error-text" role="alert">
                            {error}
                        </p>
                    ) : null}
                </div>
            ) : null}
        </div>
    )
}
