/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

/**
 * Is herdr's agent `info` (looked up by name) the one recorded in `rec`
 * (an agent session or a review run)? Names can be reused by another
 * agent, so the pane decides when both sides know it (a resumed
 * conversation may get a new session id in the same pane); otherwise the
 * session id, when both know it. Nothing to compare: trusted.
 */
export function sameAgent(rec, info) {
    if (!rec || !info) return true
    if (rec.pane_id && info.paneId) return rec.pane_id === info.paneId
    if (rec.session_id && info.sessionId)
        return rec.session_id === info.sessionId
    return true
}
