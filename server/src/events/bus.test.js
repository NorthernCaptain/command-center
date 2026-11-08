/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */
import { createBus } from "./bus.js"
import { createFakeClock } from "../util/clock.js"

test("emits events with timestamp and unsubscribes", () => {
    const clock = createFakeClock("2026-01-01T00:00:00.000Z")
    const bus = createBus({ clock })
    const seen = []
    const off = bus.subscribe((e) => seen.push(e))
    expect(bus.listenerCount()).toBe(1)
    const ev = bus.emit("task.created", { task_id: 3, data: { a: 1 } })
    expect(ev).toEqual({
        type: "task.created",
        task_id: 3,
        data: { a: 1 },
        at: "2026-01-01T00:00:00.000Z",
    })
    bus.emit("x")
    expect(seen.map((e) => e.type)).toEqual(["task.created", "x"])
    expect(seen[1].task_id).toBeNull()
    off()
    bus.emit("y")
    expect(seen).toHaveLength(2)
    expect(bus.listenerCount()).toBe(0)
})

test("works without a clock", () => {
    const bus = createBus()
    expect(typeof bus.emit("z").at).toBe("string")
})
