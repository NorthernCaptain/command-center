/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Tiny history-API router: "/", "/t/:id", "/settings". The server serves
// index.html for unknown paths (SPA fallback).

import { useSyncExternalStore } from "react"

const listeners = new Set()

function notify() {
    for (const fn of listeners) fn()
}

if (typeof window !== "undefined") {
    window.addEventListener("popstate", notify)
}

export function currentPath() {
    return typeof window === "undefined" ? "/" : window.location.pathname
}

export function navigate(to, { replace = false } = {}) {
    if (to === currentPath() + window.location.search) return
    if (replace) window.history.replaceState(null, "", to)
    else window.history.pushState(null, "", to)
    window.scrollTo && window.scrollTo(0, 0)
    notify()
}

function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
}

/** Current pathname, re-rendering on navigation. */
export function usePath() {
    return useSyncExternalStore(subscribe, currentPath, () => "/")
}

/** Route match -> { name, params }. */
export function matchRoute(path) {
    const p = (path || "/").replace(/\/+$/, "") || "/"
    if (p === "/") return { name: "home", params: {} }
    if (p === "/settings") return { name: "settings", params: {} }
    const m = p.match(/^\/t\/(?:T-)?(\d+)$/i)
    if (m) return { name: "task", params: { id: Number(m[1]) } }
    return { name: "not_found", params: {} }
}
