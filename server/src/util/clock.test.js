/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */
import { createFakeClock, systemClock } from "./clock.js"

test("fake clock runs due timers in order and supports clear", async () => {
    const c = createFakeClock("2026-01-01T00:00:00.000Z")
    const order = []
    c.setTimeout(() => order.push("b"), 200)
    c.setTimeout(() => order.push("a"), 100)
    const h = c.setTimeout(() => order.push("never"), 150)
    c.clearTimeout(h)
    c.setTimeout(() => order.push("late"), 5000)
    expect(c.pending()).toBe(3)
    await c.advance(300)
    expect(order).toEqual(["a", "b"])
    expect(c.now().toISOString()).toBe("2026-01-01T00:00:00.300Z")
    c.set("2026-02-01T00:00:00.000Z")
    expect(c.now().getUTCMonth()).toBe(1)
})

test("timers scheduled by timers fire within the window", async () => {
    const c = createFakeClock()
    const seen = []
    c.setTimeout(() => {
        seen.push(1)
        c.setTimeout(() => seen.push(2), 10)
    }, 10)
    c.setTimeout(() => seen.push("neg"), -5)
    await c.advance(30)
    expect(seen).toEqual(["neg", 1, 2])
})

test("system clock delegates to globals", () => {
    expect(systemClock.now()).toBeInstanceOf(Date)
    const h = systemClock.setTimeout(() => {}, 1000)
    systemClock.clearTimeout(h)
})
