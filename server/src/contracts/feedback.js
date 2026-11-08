/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Shared PR-feedback helpers used by the PR watcher (which records rounds and
// queues the feedback prompt) and the worker service ("Address feedback"):
// both must build the same outbox dedupe key and agree on the current round.

const PR_URL_RE =
    /^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/

/** "https://github.com/acme/aws-lambda/pull/812" -> { repo, number }. */
export function parsePrUrl(url) {
    const m = PR_URL_RE.exec(String(url || ""))
    return m ? { repo: m[1], number: Number(m[2]) } : null
}

/**
 * Outbox dedupe key for the feedback prompt of one PR round:
 * "round-<repo>-<number>-<round>". Throws on a URL that is not a GitHub PR.
 */
export function feedbackDedupeKey(prUrl, round) {
    const pr = parsePrUrl(prUrl)
    if (!pr) throw new Error(`not a GitHub PR URL: ${prUrl}`)
    if (!Number.isInteger(round) || round < 1)
        throw new Error(`invalid feedback round: ${round}`)
    return `round-${pr.repo}-${pr.number}-${round}`
}

/**
 * The round to work on for one PR: the OLDEST round that still has an open
 * actionable item (later rounds wait until it is resolved), or null.
 * `items` = latest record per feedback item id.
 */
export function currentRound(items, prUrl) {
    let min = null
    for (const it of items || []) {
        if (it.pr !== prUrl || it.status !== "open" || !it.actionable) continue
        if (min === null || it.round < min) min = it.round
    }
    return min
}
