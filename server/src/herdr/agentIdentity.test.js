/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { sameAgent } from "./agentIdentity.js"

test("the pane decides, else the session id, else trusted", () => {
    expect(sameAgent(null, { paneId: "p1" })).toBe(true)
    expect(sameAgent({ pane_id: "p1" }, null)).toBe(true)
    expect(sameAgent({ pane_id: "p1" }, { paneId: "p1" })).toBe(true)
    expect(sameAgent({ pane_id: "p1" }, { paneId: "p2" })).toBe(false)
    expect(
        sameAgent({ session_id: "s1" }, { paneId: "p2", sessionId: "s1" })
    ).toBe(true)
    expect(sameAgent({ session_id: "s1" }, { sessionId: "s2" })).toBe(false)
    expect(sameAgent({}, { paneId: "p1" })).toBe(true)
})
