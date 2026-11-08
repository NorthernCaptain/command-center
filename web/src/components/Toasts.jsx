/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react"
import { errorMessage } from "../lib/api.js"

const ToastContext = createContext(null)

let seq = 0

export function ToastProvider({ children, timeout = 5000 }) {
    const [toasts, setToasts] = useState([])
    const timers = useRef(new Map())

    const dismiss = useCallback((id) => {
        setToasts((list) => list.filter((t) => t.id !== id))
        clearTimeout(timers.current.get(id))
        timers.current.delete(id)
    }, [])

    const push = useCallback(
        (kind, text, opts = {}) => {
            const id = ++seq
            setToasts((list) => [...list.slice(-3), { id, kind, text }])
            const ms =
                opts.timeout ?? (kind === "error" ? timeout * 1.6 : timeout)
            if (ms > 0)
                timers.current.set(
                    id,
                    setTimeout(() => dismiss(id), ms)
                )
            return id
        },
        [dismiss, timeout]
    )

    useEffect(() => {
        const map = timers.current
        return () => map.forEach((t) => clearTimeout(t))
    }, [])

    const value = useMemo(
        () => ({
            push,
            dismiss,
            info: (text, o) => push("info", text, o),
            success: (text, o) => push("success", text, o),
            error: (err, o) =>
                push(
                    "error",
                    typeof err === "string" ? err : errorMessage(err),
                    o
                ),
        }),
        [push, dismiss]
    )

    return (
        <ToastContext.Provider value={value}>
            {children}
            <div className="toasts" role="status" aria-live="polite">
                {toasts.map((t) => (
                    <div key={t.id} className={`toast toast-${t.kind}`}>
                        <span className="toast-dot" aria-hidden="true" />
                        <span className="toast-text">{t.text}</span>
                        <button
                            type="button"
                            className="toast-close"
                            aria-label="Dismiss"
                            onClick={() => dismiss(t.id)}
                        >
                            ×
                        </button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    )
}

const NOOP = {
    push: () => 0,
    dismiss: () => {},
    info: () => 0,
    success: () => 0,
    error: () => 0,
}

export function useToast() {
    return useContext(ToastContext) || NOOP
}
