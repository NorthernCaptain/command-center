/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Injectable clock so tests can control time.

export const systemClock = {
    now: () => new Date(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
}

/** Manual clock for tests. advance(ms) runs due timers in order. */
export function createFakeClock(start = "2026-11-07T12:00:00.000Z") {
    let t = new Date(start).getTime()
    let seq = 0
    const timers = new Map()
    return {
        now: () => new Date(t),
        setTimeout(fn, ms) {
            const id = ++seq
            timers.set(id, { at: t + Math.max(0, ms), fn })
            return id
        },
        clearTimeout(id) {
            timers.delete(id)
        },
        async advance(ms) {
            const target = t + ms
            for (;;) {
                const due = [...timers.entries()]
                    .filter(([, v]) => v.at <= target)
                    .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
                if (!due.length) break
                const [id, timer] = due[0]
                timers.delete(id)
                t = timer.at
                await timer.fn()
            }
            t = target
        },
        set(iso) {
            t = new Date(iso).getTime()
        },
        pending: () => timers.size,
    }
}
