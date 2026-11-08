/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Keyed async mutex. Re-entrant within one async call chain (tracked with
// AsyncLocalStorage), so code running inside store.withTaskLock(id) can call
// store methods that take the same lock without deadlocking.
//
// Ownership is a token that is revoked when the owning scope exits. Async
// work started inside the scope but still running afterwards (timers, queued
// jobs) inherits the context, sees a revoked token and queues for the lock
// like everyone else instead of bypassing it.

import { AsyncLocalStorage } from "node:async_hooks"

export function createLockManager() {
    const als = new AsyncLocalStorage()
    const tails = new Map()

    async function withLock(key, fn) {
        const held = als.getStore()
        const token = held && held.get(key)
        if (token && token.active) return fn()

        const prev = tails.get(key) || Promise.resolve()
        let release
        const mine = new Promise((resolve) => {
            release = resolve
        })
        const tail = prev.then(() => mine)
        tails.set(key, tail)
        await prev
        const owner = { active: true }
        try {
            const next = new Map(held || [])
            next.set(key, owner)
            return await als.run(next, fn)
        } finally {
            owner.active = false
            release()
            if (tails.get(key) === tail) tails.delete(key)
        }
    }

    /** Run fn outside of any held-lock context (e.g. bus listeners). */
    function outside(fn) {
        return als.exit(fn)
    }

    return {
        withLock,
        outside,
        isHeld: (key) => {
            const held = als.getStore()
            const token = held && held.get(key)
            return Boolean(token && token.active)
        },
        size: () => tails.size,
    }
}
