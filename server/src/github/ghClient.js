/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Thin `gh` CLI wrapper for the PR watcher. Every call goes through the
// injected exec(file, args) so tests never touch the real tool. Output is
// normalized to the shapes in docs/implementation/phase2-contracts.md (E).
//
// Reviews and PR conversation comments come from the REST API (numeric ids,
// html_url, user.type) rather than `gh pr view --json reviews,comments`,
// which only exposes GraphQL node ids and no review URL.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { nullLogger } from "../util/logger.js"

const execFileAsync = promisify(execFile)
const EXEC_TIMEOUT_MS = 60000
const MAX_BUFFER = 32 * 1024 * 1024

export const LIST_FIELDS = [
    "number",
    "url",
    "headRefName",
    "headRepository",
    "headRepositoryOwner",
    "isCrossRepository",
    "createdAt",
    "body",
    "state",
    "mergedAt",
    "closedAt",
    "headRefOid",
    "author",
]
export const VIEW_FIELDS = [
    ...LIST_FIELDS,
    "reviewDecision",
    "statusCheckRollup",
    "commits",
]

/** Default exec: execFile without a shell; resolves to stdout. */
export async function defaultExec(file, args) {
    const { stdout } = await execFileAsync(file, args, {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
    })
    return stdout
}

function parseOutput(out, what) {
    const text = typeof out === "string" ? out : out && out.stdout
    try {
        return JSON.parse(String(text || "").trim() || "null")
    } catch (err) {
        throw new Error(`gh ${what}: invalid JSON (${err.message})`)
    }
}

/** `gh api --paginate --slurp` returns an array of pages: flatten them. */
function flattenPages(data) {
    if (!Array.isArray(data)) return []
    return data.flatMap((p) => (Array.isArray(p) ? p : [p]))
}

const userOf = (u) => ({
    login: (u && u.login) || null,
    type: (u && u.type) || null,
})

/** Normalize a `gh pr list/view` PR object (repo shape + author). */
export function normalizePr(pr) {
    const repo = pr.headRepository || {}
    const owner =
        (pr.headRepositoryOwner && pr.headRepositoryOwner.login) ||
        (repo.owner && repo.owner.login) ||
        (typeof repo.owner === "string" ? repo.owner : null) ||
        (repo.nameWithOwner ? repo.nameWithOwner.split("/")[0] : null)
    return {
        number: pr.number,
        url: pr.url,
        headRefName: pr.headRefName,
        headRepository: { name: repo.name || null, owner },
        isCrossRepository: Boolean(pr.isCrossRepository),
        createdAt: pr.createdAt || null,
        body: pr.body || "",
        state: pr.state || null,
        mergedAt: pr.mergedAt || null,
        closedAt: pr.closedAt || null,
        headRefOid: pr.headRefOid || null,
        author: {
            login: (pr.author && pr.author.login) || null,
            is_bot: Boolean(pr.author && pr.author.is_bot),
        },
    }
}

/**
 * Normalize one statusCheckRollup entry. CheckRun has name/status/
 * conclusion; StatusContext has context/state/targetUrl.
 */
export function normalizeCheck(c) {
    if (c && c.__typename === "StatusContext") {
        const state = String(c.state || "").toUpperCase()
        const pending = state === "PENDING" || state === "EXPECTED"
        return {
            name: c.context || "status",
            status: pending ? "IN_PROGRESS" : "COMPLETED",
            conclusion: pending ? null : state === "ERROR" ? "FAILURE" : state,
            detailsUrl: c.targetUrl || null,
            workflowName: null,
        }
    }
    return {
        name: (c && c.name) || "check",
        status: String((c && c.status) || "").toUpperCase() || null,
        conclusion:
            c && c.conclusion ? String(c.conclusion).toUpperCase() : null,
        detailsUrl: (c && c.detailsUrl) || null,
        workflowName: (c && c.workflowName) || null,
    }
}

/**
 * @param {object} deps
 * @param {(file: string, args: string[]) => Promise<string|{stdout:string}>} [deps.exec]
 * @param {string} [deps.ghBin]
 * @param {string} [deps.org]  github.org; calls fail without it
 * @param {object} [deps.log]
 */
export function createGhClient({
    exec = defaultExec,
    ghBin = "gh",
    org,
    log = nullLogger,
} = {}) {
    // without an org (github.org unset) every call fails with a clear error
    const full = (repo) => {
        if (!org)
            throw new Error(
                "GitHub org is not configured: set github.org in config.json"
            )
        return `${org}/${repo}`
    }

    async function run(args, what) {
        log.debug({ args }, "gh")
        const out = await exec(ghBin, args)
        return parseOutput(out, what)
    }

    async function api(path, what) {
        return flattenPages(
            await run(["api", path, "--paginate", "--slurp"], what)
        )
    }

    async function listPrsByHead(repo, branch) {
        const data = await run(
            [
                "pr",
                "list",
                "--repo",
                full(repo),
                "--head",
                branch,
                "--state",
                "all",
                "--limit",
                "50",
                "--json",
                LIST_FIELDS.join(","),
            ],
            "pr list"
        )
        return (Array.isArray(data) ? data : []).map(normalizePr)
    }

    async function reviews(repo, number) {
        const rows = await api(
            `repos/${full(repo)}/pulls/${number}/reviews?per_page=100`,
            "reviews"
        )
        return rows.map((r) => ({
            id: r.id,
            author: userOf(r.user),
            state: r.state || null,
            body: r.body || "",
            submittedAt: r.submitted_at || null,
            url: r.html_url || null,
            commitId: r.commit_id || null,
        }))
    }

    async function issueComments(repo, number) {
        const rows = await api(
            `repos/${full(repo)}/issues/${number}/comments?per_page=100`,
            "issue comments"
        )
        return rows.map((c) => ({
            id: c.id,
            author: userOf(c.user),
            body: c.body || "",
            createdAt: c.created_at || null,
            url: c.html_url || null,
        }))
    }

    async function viewPr(repo, number) {
        return run(
            [
                "pr",
                "view",
                String(number),
                "--repo",
                full(repo),
                "--json",
                VIEW_FIELDS.join(","),
            ],
            "pr view"
        )
    }

    const commitsOf = (pr) =>
        ((pr && pr.commits) || []).map((c) => ({
            oid: c.oid,
            committedDate: c.committedDate || null,
        }))

    async function getPr(repo, number) {
        const pr = await viewPr(repo, number)
        const [revs, comments] = await Promise.all([
            reviews(repo, number),
            issueComments(repo, number),
        ])
        return {
            ...normalizePr(pr),
            reviewDecision: pr.reviewDecision || null,
            statusCheckRollup: (pr.statusCheckRollup || []).map(normalizeCheck),
            reviews: revs,
            comments,
            commits: commitsOf(pr),
        }
    }

    async function reviewComments(repo, number, { since } = {}) {
        let path = `repos/${full(repo)}/pulls/${number}/comments?per_page=100`
        if (since) path += `&since=${encodeURIComponent(since)}`
        const rows = await api(path, "review comments")
        return rows.map((c) => ({
            id: c.id,
            user: userOf(c.user),
            body: c.body || "",
            path: c.path || null,
            line: c.line ?? null,
            original_line: c.original_line ?? null,
            created_at: c.created_at || null,
            html_url: c.html_url || null,
            in_reply_to_id: c.in_reply_to_id ?? null,
            commit_id: c.commit_id || null,
        }))
    }

    async function commitsSince(repo, number, sinceIso) {
        const pr = await run(
            [
                "pr",
                "view",
                String(number),
                "--repo",
                full(repo),
                "--json",
                "commits",
            ],
            "pr commits"
        )
        const since = sinceIso ? new Date(sinceIso).getTime() : null
        return commitsOf(pr).filter(
            (c) =>
                since === null ||
                (c.committedDate && new Date(c.committedDate).getTime() > since)
        )
    }

    /** Not used by the watcher (agents reply themselves); kept per contract. */
    async function prComment(repo, number, body) {
        const out = await exec(ghBin, [
            "pr",
            "comment",
            String(number),
            "--repo",
            full(repo),
            "--body",
            String(body),
        ])
        return typeof out === "string" ? out.trim() : out
    }

    return {
        listPrsByHead,
        getPr,
        reviewComments,
        commitsSince,
        prComment,
    }
}
