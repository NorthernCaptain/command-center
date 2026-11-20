/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    AGENT_KIND_LABELS,
    AGENT_KINDS,
    baseKind,
    kindEnv,
} from "./agentKinds.js"

test("kinds, labels and the CLI each runs", () => {
    expect(AGENT_KINDS).toEqual(["claude", "klaude", "codex"])
    for (const k of AGENT_KINDS) expect(AGENT_KIND_LABELS[k]).toBeTruthy()
    expect(baseKind("klaude")).toBe("claude")
    expect(baseKind("claude")).toBe("claude")
    expect(baseKind("codex")).toBe("codex")
    expect(baseKind(undefined)).toBeUndefined()
})

test("kindEnv: the kind's workspace env from config, else none", () => {
    const agents = {
        klaude: { env: { CLAUDE_CONFIG_DIR: "/h/.claude-2" } },
        codex: { env: "nope" },
    }
    const env = kindEnv("klaude", agents)
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: "/h/.claude-2" })
    // a copy: the caller may extend it
    env.X = "1"
    expect(agents.klaude.env).toEqual({ CLAUDE_CONFIG_DIR: "/h/.claude-2" })
    expect(kindEnv("claude", agents)).toEqual({})
    expect(kindEnv("codex", agents)).toEqual({})
    expect(kindEnv("klaude", undefined)).toEqual({})
})
