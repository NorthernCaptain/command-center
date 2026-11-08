/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Live smoke test against the local herdr server. Read-only calls only.
// Skipped unless HERDR_LIVE=1:
//   HERDR_LIVE=1 NODE_OPTIONS=--experimental-vm-modules npx jest server/src/herdr/herdrClient.live.test.js

import { createHerdrClient, HERDR_PROTOCOL } from "./herdrClient.js"

const live = process.env.HERDR_LIVE === "1" ? describe : describe.skip

live("herdr live (read-only)", () => {
    const client = createHerdrClient({ timeoutMs: 5000 })

    test("ping reports protocol 22", async () => {
        const r = await client.ping()
        expect(r.protocol).toBe(HERDR_PROTOCOL)
        expect(typeof r.version).toBe("string")
    })

    test("agentList returns normalized agents", async () => {
        const agents = await client.agentList()
        expect(Array.isArray(agents)).toBe(true)
        for (const a of agents) {
            expect(typeof a.paneId).toBe("string")
            expect(typeof a.status).toBe("string")
        }
    })
})
