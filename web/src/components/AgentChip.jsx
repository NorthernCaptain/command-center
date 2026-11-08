/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Worker agent overlay chip (herdr agent status).

export const AGENT_STATES = {
    working: { glyph: "●", label: "working" },
    idle: { glyph: "◐", label: "idle" },
    blocked: { glyph: "⛔", label: "blocked" },
    done: { glyph: "✓", label: "done" },
    gone: { glyph: "○", label: "gone" },
    unknown: { glyph: "?", label: "unknown" },
}

/** True when an agentState (or a bare state string) is a live session. */
export function isLiveAgent(agent) {
    const state = typeof agent === "string" ? agent : agent && agent.state
    return Boolean(state) && state !== "gone"
}

export default function AgentChip({ state, name }) {
    if (!state) return null
    const meta = AGENT_STATES[state] || { glyph: "·", label: state }
    const title = name ? `Agent ${name}: ${meta.label}` : `Agent ${meta.label}`
    return (
        <span
            className={`chip agent agent-${state}`}
            title={title}
            aria-label={title}
        >
            <span className="agent-glyph" aria-hidden="true">
                {meta.glyph}
            </span>
            {meta.label}
        </span>
    )
}
