/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Prompts and names for PR review agents (docs/09-pr-reviews.md).

import { cleanTitle, oneLine } from "../workers/prompts.js"
import { truncateName } from "../workers/identity.js"
import { stackedBase } from "./prScan.js"

/** herdr agent name: "pr-<repo>-<number>" in [a-z][a-z0-9_-]{0,31}. */
export function reviewAgentName(repo, number) {
    const slug = String(repo || "repo")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    const tail = `-${number}`
    return `${truncateName(`pr-${slug}`, 32 - tail.length)}${tail}`
}

/** "#417 Fix the upload": workspace label and claude --name. */
export function reviewTitle(pr, max = 60) {
    const title = cleanTitle(pr.title, max)
    return title ? `#${pr.number} ${title}` : `#${pr.number}`
}

/** Checkout folder name of one run: "<repo>-pr-<number>-r<run id>". */
export function reviewFolderName(repo, number, runId) {
    return `${repo}-pr-${number}-r${runId}`
}

/**
 * The review agent's first prompt.
 * @param {{ pr: object, run: object, org: string, folder: string, me: string }} p
 */
export function reviewPrompt({ pr, run, org, folder, me, retry = null }) {
    const ref = `${org}/${pr.repo}#${pr.number}`
    const lines = [
        `Review PR ${ref}: "${oneLine(pr.title, 200)}" by ${pr.author || "unknown"}.`,
        `URL: ${pr.url}`,
        ...(stackedBase(pr)
            ? [
                  `It targets ${stackedBase(pr)}, not the default branch (stacked on another PR): this prompt is the explicit request by PR ID that AGENTS.md asks for. Review its changes against ${stackedBase(pr)}.`,
              ]
            : []),
        "Follow AGENTS.md in this folder exactly (selection, checkout, review, submit, clean up).",
        "You are the reviewer: do the review yourself. Never call the review orchestrator (the review MCP tools request_review / reset_review_context): it reviews code you write, and you write none here.",
        `Use this new checkout folder for it: ${folder} (fetch the PR there; keep every file of this review, diffs and notes included, inside it; no other folder).`,
        `Clone over SSH: gh repo clone ${org}/${pr.repo} <folder> or git clone git@github.com:${org}/${pr.repo}.git <folder>, then fetch the PR head (git fetch origin pull/${pr.number}/head). Plain git over HTTPS has no valid GitHub credential here. Use gh for every GitHub read and write (PR data, the review, comments).`,
    ]
    if (retry) {
        lines.push(
            `An earlier attempt at this review (started ${retry.started_at || "earlier"}) stopped at a usage limit. Check the PR on GitHub for any review or comments ${me} posted since then, and do not post them again; finish what is missing.`
        )
    }
    if (run.kind === "re_review") {
        const when = [
            pr.decided_at,
            pr.decided_sha && `on ${String(pr.decided_sha).slice(0, 7)}`,
        ]
            .filter(Boolean)
            .join(" ")
        lines.push(
            `This is a RE-REVIEW: ${me} ${pr.decision === "approved" ? "approved it" : "requested changes"} before${when ? ` (${when})` : ""}. ` +
                "Read that review and every comment and reply since, pay close attention to the comments, verify each earlier finding against the new head, then review all changes since." +
                (pr.decision === "approved"
                    ? " New commits came after that approval and the author asks for our review again: submit a new review on the current head (approve it, or request changes); unchanged does not apply."
                    : pr.rerequested_at
                      ? ` The author asked for our review again (${pr.rerequested_at}): answer with a new review on the current head (approve it, or request changes again saying what is still missing and why); unchanged does not apply.`
                      : "")
        )
    }
    lines.push(
        "Command center tracks this PR: do not register it with .pr-monitor.",
        `When the GitHub review is submitted (or you decide not to submit one), call the command-center MCP tool cc_review_report with review_id=${run.id}, verdict (approved | changes_requested | unchanged | skipped), issues (number of actionable issues in the submitted review, or still open for unchanged) and a short summary (for skipped: why). unchanged is for a re-review where nothing since our change request changes it (no fix, only replies): it stands and you submit no new review. skipped only when the review could not be done. Then delete your checkout folder and stop; this session is closed after your report.`
    )
    return lines.join("\n")
}

/** Reminder for an agent that went idle without cc_review_report. */
export function reviewNudgePrompt(run) {
    return `You have not reported this review yet. If the GitHub review is submitted, call cc_review_report with review_id=${run.id}, verdict, issues and summary now. If you are stuck, call it with verdict=skipped and say why in the summary.`
}
