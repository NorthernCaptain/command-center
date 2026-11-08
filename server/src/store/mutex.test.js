/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { createLockManager } from "./mutex.js"

const tick = () => new Promise((r) => setImmediate(r))

test("serializes work per key and releases on error", async () => {
    const locks = createLockManager()
    const order = []
    const a = locks.withLock("k", async () => {
        order.push("a1")
        await tick()
        order.push("a2")
        throw new Error("boom")
    })
    const b = locks.withLock("k", async () => {
        order.push("b")
        return 2
    })
    await expect(a).rejects.toThrow("boom")
    expect(await b).toBe(2)
    expect(order).toEqual(["a1", "a2", "b"])
    expect(locks.size()).toBe(0)
})

test("different keys run concurrently", async () => {
    const locks = createLockManager()
    const order = []
    await Promise.all([
        locks.withLock("x", async () => {
            order.push("x1")
            await tick()
            order.push("x2")
        }),
        locks.withLock("y", async () => {
            order.push("y1")
        }),
    ])
    expect(order.indexOf("y1")).toBeLessThan(order.indexOf("x2"))
})

test("re-entrant within one call chain; isHeld; outside()", async () => {
    const locks = createLockManager()
    expect(locks.isHeld("k")).toBe(false)
    const res = await locks.withLock("k", async () => {
        expect(locks.isHeld("k")).toBe(true)
        const inner = await locks.withLock("k", async () => "inner")
        const other = await locks.withLock(
            "j",
            async () => locks.isHeld("k") && locks.isHeld("j")
        )
        const out = locks.outside(() => locks.isHeld("k"))
        return [inner, other, out]
    })
    expect(res).toEqual(["inner", true, false])
})

test("detached work started under a lock does not keep owning it", async () => {
    const locks = createLockManager()
    const order = []
    let releaseOther
    let spawned
    let startDescendant
    const gate = new Promise((r) => (startDescendant = r))
    await locks.withLock("t", async () => {
        // a background job enqueued while holding the lock, not awaited
        spawned = (async () => {
            await gate
            await locks.withLock("t", async () => order.push("descendant"))
        })()
    })
    // after the parent released, someone else takes the lock
    const other = locks.withLock("t", async () => {
        order.push("other:start")
        await new Promise((r) => (releaseOther = r))
        order.push("other:end")
    })
    await new Promise((r) => setImmediate(r))
    startDescendant()
    await new Promise((r) => setImmediate(r))
    // the descendant must wait for the independent holder
    expect(order).toEqual(["other:start"])
    releaseOther()
    await other
    await spawned
    expect(order).toEqual(["other:start", "other:end", "descendant"])
})

test("isHeld is false once the owning scope has exited", async () => {
    const locks = createLockManager()
    let later
    await locks.withLock("k", async () => {
        expect(locks.isHeld("k")).toBe(true)
        later = new Promise((r) => setImmediate(() => r(locks.isHeld("k"))))
    })
    expect(await later).toBe(false)
    expect(locks.isHeld("k")).toBe(false)
})
