/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// PR review contract (docs/09-pr-reviews.md): cc_review_report's verdicts,
// shared by the MCP tool schema and the review service, and stored run
// values shared by the service and its repo.

/**
 * approved / changes_requested: the GitHub review is submitted. unchanged
 * (re-review): nothing since our change request changes it (no fix, only
 * replies), it stands, no new review. skipped: no review could be done.
 */
export const REVIEW_VERDICTS = [
    "approved",
    "changes_requested",
    "unchanged",
    "skipped",
]
/** A finished run with this verdict settles the PR state it reviewed. */
export const SETTLED_VERDICT = "unchanged"
/**
 * The error prefix of a run stopped at its agent's usage limit (stored;
 * such a run never counts as a reviewed state).
 */
export const USAGE_LIMIT_ERROR = "usage limit"
