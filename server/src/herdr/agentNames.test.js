/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { freeAgentName } from "./agentNames.js"

const lookup = (taken) => async (name) => (taken.includes(name) ? {} : null)

test("base, else a numbered free name; unknown (undefined) counts as taken", async () => {
    expect(await freeAgentName("t1-x", lookup([]))).toBe("t1-x")
    expect(await freeAgentName("t1-x", lookup(["t1-x", "t1-x-2"]))).toBe(
        "t1-x-3"
    )
    expect(
        await freeAgentName("t1-x", async () => undefined).catch((e) => e.code)
    ).toBe("agent_name_taken")
    const long = "a".repeat(32)
    expect(await freeAgentName(long, lookup([long]))).toBe(
        `${"a".repeat(29)}-2`
    )
})

test("reserved names are skipped and taken at once", async () => {
    const reserved = new Set(["t1-x"])
    expect(await freeAgentName("t1-x", lookup([]), { reserved })).toBe("t1-x-2")
    expect(reserved.has("t1-x-2")).toBe(true)
    // two lookups in flight for the same base: different names
    const slow = async () => {
        await new Promise((r) => setTimeout(r, 5))
        return null
    }
    const both = new Set()
    const [a, b] = await Promise.all([
        freeAgentName("t2-y", slow, { reserved: both }),
        freeAgentName("t2-y", slow, { reserved: both }),
    ])
    expect(a).not.toBe(b)
})

test("no free name: 409", async () => {
    const all = ["b", ...Array.from({ length: 8 }, (_, i) => `b-${i + 2}`)]
    await expect(freeAgentName("b", lookup(all))).rejects.toMatchObject({
        code: "agent_name_taken",
        status: 409,
    })
})
