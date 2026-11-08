/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

const FOCUSABLE =
    "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"

/** Focus without scrolling the page to the element. */
function focusQuietly(el) {
    if (el && typeof el.focus === "function") el.focus({ preventScroll: true })
}

/**
 * Modal confirmation. onConfirm() -> Promise; a rejection is swallowed
 * here (the caller shows its own errors). Escape or the backdrop cancels.
 * Rendered into document.body: inside the page (e.g. a header whose
 * ancestor has a filter or transform) "fixed" would be relative to that
 * ancestor, and focusing the dialog would scroll the page.
 */
export default function ConfirmDialog({
    title,
    children,
    confirmLabel = "Confirm",
    danger = false,
    onConfirm,
    onCancel,
}) {
    const [busy, setBusy] = useState(false)
    const cancelRef = useRef(null)
    const dialogRef = useRef(null)

    // Focus goes to Cancel (the safe choice) and comes back to whatever
    // opened the dialog when it closes; neither scrolls the page.
    useEffect(() => {
        const opener = document.activeElement
        focusQuietly(cancelRef.current)
        return () => {
            if (opener && opener.isConnected) focusQuietly(opener)
        }
    }, [])

    // Escape cancels; Tab / Shift+Tab stay inside the dialog (the page
    // behind is not reachable from the keyboard while it is open).
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === "Escape") {
                onCancel()
                return
            }
            if (e.key !== "Tab" || !dialogRef.current) return
            const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)]
            if (!items.length) {
                e.preventDefault()
                return
            }
            const first = items[0]
            const last = items[items.length - 1]
            const active = document.activeElement
            const inside = dialogRef.current.contains(active)
            if (e.shiftKey && (active === first || !inside)) {
                e.preventDefault()
                focusQuietly(last)
            } else if (!e.shiftKey && (active === last || !inside)) {
                e.preventDefault()
                focusQuietly(first)
            }
        }
        document.addEventListener("keydown", onKey)
        return () => document.removeEventListener("keydown", onKey)
    }, [onCancel])

    async function confirm() {
        setBusy(true)
        try {
            await onConfirm()
        } catch {
            // the caller shows its own errors (toasts)
        } finally {
            setBusy(false)
        }
    }

    return createPortal(
        <>
            <button
                type="button"
                className="confirm-backdrop"
                aria-label="Cancel"
                tabIndex={-1}
                onClick={onCancel}
            />
            <div
                ref={dialogRef}
                className="confirm-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="confirm-dialog-title"
            >
                <h2 id="confirm-dialog-title" className="confirm-title">
                    {title}
                </h2>
                <div className="confirm-body">{children}</div>
                <div className="confirm-actions">
                    <button
                        ref={cancelRef}
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={onCancel}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        className={`btn btn-sm${danger ? " btn-danger" : " btn-accent"}`}
                        disabled={busy}
                        onClick={confirm}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </>,
        document.body
    )
}

/**
 * Button for a consequential action: it opens the confirmation dialog
 * (title, children as the explanation) and runs onConfirm() on confirm.
 */
export function ConfirmButton({
    label,
    title,
    children,
    confirmLabel = "Confirm",
    danger = false,
    onConfirm,
    className = "btn btn-ghost btn-sm",
    disabled = false,
    buttonTitle,
}) {
    const [open, setOpen] = useState(false)
    return (
        <>
            <button
                type="button"
                className={className}
                disabled={disabled}
                title={buttonTitle}
                onClick={() => setOpen(true)}
            >
                {label}
            </button>
            {open ? (
                <ConfirmDialog
                    title={title}
                    confirmLabel={confirmLabel}
                    danger={danger}
                    onCancel={() => setOpen(false)}
                    onConfirm={async () => {
                        try {
                            await onConfirm()
                        } finally {
                            setOpen(false)
                        }
                    }}
                >
                    {children}
                </ConfirmDialog>
            ) : null}
        </>
    )
}
