/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// PR review contract (docs/09-pr-reviews.md): cc_review_report's verdicts,
// shared by the MCP tool schema and the review service, stored run values
// shared by the service and its repo, and the review agent models (shared
// with the web client).

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

/**
 * Models a PR review agent can run on, with their reasoning effort, by agent
 * kind (Settings: review agent / fallback). "default" is the CLI's own
 * configuration. The web client imports this list too (keep this module
 * free of node and zod imports).
 */
export const REVIEW_MODELS = {
    claude: [
        {
            id: "opus-medium",
            model: "opus",
            effort: "medium",
            label: "Opus, medium",
        },
        { id: "opus-high", model: "opus", effort: "high", label: "Opus, high" },
        {
            id: "sonnet-high",
            model: "sonnet",
            effort: "high",
            label: "Sonnet, high",
        },
        {
            id: "sonnet-xhigh",
            model: "sonnet",
            effort: "xhigh",
            label: "Sonnet, xhigh",
        },
    ],
    codex: [
        {
            id: "terra-medium",
            model: "gpt-6.1-terra",
            effort: "medium",
            label: "Terra, medium",
        },
        {
            id: "terra-high",
            model: "gpt-6.1-terra",
            effort: "high",
            label: "Terra, high",
        },
        {
            id: "terra-xhigh",
            model: "gpt-6.1-terra",
            effort: "xhigh",
            label: "Terra, xhigh",
        },
    ],
}
export const DEFAULT_REVIEW_MODEL = "default"
export const REVIEW_MODEL_IDS = [
    DEFAULT_REVIEW_MODEL,
    ...Object.values(REVIEW_MODELS).flatMap((list) => list.map((m) => m.id)),
]

/** The review model `id` of agent `kind`, or null (default / another kind's). */
export function reviewModel(kind, id) {
    return (REVIEW_MODELS[kind] || []).find((m) => m.id === id) || null
}
