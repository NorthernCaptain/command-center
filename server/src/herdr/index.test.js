/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import * as herdr from "./index.js"

test("re-exports the herdr bridge API", () => {
    for (const name of [
        "createHerdrClient",
        "HerdrError",
        "expandHome",
        "toAgentInfo",
        "createHerdrEvents",
        "buildSubscriptions",
        "parseEvent",
        "createAgentSessionsRepo",
        "createOutboxRepo",
    ])
        expect(typeof herdr[name]).toBe("function")
    expect(herdr.HERDR_PROTOCOL).toBe(22)
    expect(herdr.DEFAULT_SOCKET_PATH).toBe("~/.config/herdr/herdr.sock")
    expect(herdr.SESSION_KINDS).toEqual(["claude", "codex"])
})
