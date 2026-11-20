/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Agent kinds of task workers and PR review agents (docs/04, docs/09). A
// kind is a CLI and an account: "klaude" is Claude Code signed in with a
// second account (its own CLAUDE_CONFIG_DIR, config `agents.klaude.env`).
// herdr knows the CLI only: klaude runs as its "claude" kind, in a
// workspace whose env points the CLI at that account. Usage limits are per
// kind (per account). The web client imports this module too (keep it free
// of node and zod imports).

export const AGENT_KINDS = ["claude", "klaude", "codex"]

export const AGENT_KIND_LABELS = {
    claude: "Claude",
    klaude: "Klaude",
    codex: "Codex",
}

const RUNS_AS = { klaude: "claude" }

/** The CLI (herdr agent kind) a kind runs: klaude -> claude. */
export function baseKind(kind) {
    return RUNS_AS[kind] || kind
}

/**
 * Extra env of a kind's agent workspace, from config `agents.<kind>.env`
 * (e.g. klaude: { CLAUDE_CONFIG_DIR }); {} when none.
 */
export function kindEnv(kind, agents) {
    const env = agents && agents[kind] && agents[kind].env
    return env && typeof env === "object" ? { ...env } : {}
}
