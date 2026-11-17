/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Usage-limit banners of agents in a herdr pane (task workers and PR
// review agents share this).

/**
 * Claude Code's and Codex's limit banners, at the start of a line (after
 * box and bullet glyphs): "You've hit your usage limit · resets 5pm",
 * "■ You've hit your usage limit … try again at 4:31 PM", "5-hour limit
 * reached ∙ resets 3pm", "Claude AI usage limit reached|…", Codex out of
 * credits ("■ Usage limit reached. You've reached your usage limit."),
 * "Credit balance is too low", "API Error: 429 … rate_limit_error". The agent's own prose
 * that mentions rate limits (e.g. a question about a gateway's per-IP rate
 * limits) is not a banner and must not match.
 */
export const USAGE_LIMIT_RE =
    /^[^\p{L}\p{N}]*(?:you['’]ve (?:hit|reached) your (?:usage )?limit\b|you['’]re out of (?:extra )?usage\b|(?:claude(?: ai)?|5-hour|session|weekly|opus weekly|sonnet weekly)(?: usage)? limit reached\b|usage limit reached\b|credit balance is too low\b|api error:.*\b(?:429|rate_limit_error)\b)/iu

/** Banners are at the bottom of the pane: only these lines count. */
export const USAGE_TAIL_LINES = 12

function tailOf(text, tailLines) {
    return String(text || "")
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(-tailLines)
}

/** The limit banner line at the bottom of a pane's text, or null. */
export function findLimitLine(text, tailLines = USAGE_TAIL_LINES) {
    const tail = tailOf(text, tailLines)
    return [...tail].reverse().find((l) => USAGE_LIMIT_RE.test(l)) || null
}

/**
 * The banner with the lines after it joined (a narrow pane wraps "try
 * again at" / "4:31 PM" onto two lines), for limitResetAt; or null.
 */
export function findLimitText(text, tailLines = USAGE_TAIL_LINES, follow = 4) {
    const tail = tailOf(text, tailLines)
    for (let i = tail.length - 1; i >= 0; i--)
        if (USAGE_LIMIT_RE.test(tail[i]))
            return tail
                .slice(i, i + 1 + follow)
                .map((l) => l.trim())
                .join(" ")
    return null
}

/**
 * A time a narrow pane wrapped mid-token ("4:" / "31 PM", "4:3" / "1 PM",
 * "4:31 P" / "M") put back together once its lines were joined with spaces.
 */
function unwrapTimes(text) {
    return text
        .replace(/(\d{1,2}):\s+(\d)/g, "$1:$2")
        .replace(/(\d{1,2}:\d)\s+(\d)\b/g, "$1$2")
        .replace(/(\d)(\s*)([ap])\s+(\.?m)\b/gi, "$1$2$3$4")
}

const RESET_RE =
    /\b(?:resets?|try again)(?:\s+(?:at|on))?\s+(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i
// "Claude AI usage limit reached|1794330000": the reset as epoch seconds
const EPOCH_RE = /\|(\d{10})\b/
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

/**
 * When the limit lifts, from the banner: an epoch ("…|1794330000"), a
 * weekday and time ("resets Mon 9am": the next such day), or a time
 * ("resets 5pm", "try again at 4:31 PM": the next such local time); else
 * now + fallbackMs.
 * @returns {number} ms since the epoch
 */
export function limitResetAt(line, nowMs, fallbackMs = 3600000) {
    const text = unwrapTimes(String(line || ""))
    const epoch = EPOCH_RE.exec(text)
    if (epoch && Number(epoch[1]) * 1000 > nowMs) return Number(epoch[1]) * 1000
    const m = RESET_RE.exec(text)
    if (!m) return nowMs + fallbackMs
    let hour = Number(m[2])
    const minute = m[3] ? Number(m[3]) : 0
    const ampm = (m[4] || "").toLowerCase().replace(/\./g, "")
    if (hour > 23 || minute > 59) return nowMs + fallbackMs
    if (ampm === "pm" && hour < 12) hour += 12
    if (ampm === "am" && hour === 12) hour = 0
    const at = new Date(nowMs)
    at.setHours(hour, minute, 0, 0)
    if (m[1]) {
        const want = DAYS.indexOf(m[1].toLowerCase())
        at.setDate(at.getDate() + ((want - at.getDay() + 7) % 7))
        if (at.getTime() <= nowMs) at.setDate(at.getDate() + 7)
        return at.getTime()
    }
    if (at.getTime() <= nowMs) at.setDate(at.getDate() + 1)
    return at.getTime()
}
