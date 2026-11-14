/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// PR reviews routes (docs/09-pr-reviews.md), owner only.

import { z } from "zod"
import { ForbiddenError, ValidationError } from "../util/errors.js"
import { systemClock } from "../util/clock.js"
import { ACTIVE_RUN_STATUSES } from "./reviewsRepo.js"
import { TABS, computeStats, listView, settledKey } from "./reviewView.js"

const RepoFlags = z
    .object({
        track: z.boolean().optional(),
        auto_review: z.boolean().optional(),
    })
    .strict()
const ScanBody = z.object({ repo: z.string().min(1).max(100).optional() })
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/

function toNumber(raw, what) {
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0)
        throw new ValidationError(`invalid ${what}`, { [what]: raw })
    return n
}

function toRepo(raw) {
    if (!REPO_RE.test(String(raw || "")))
        throw new ValidationError("invalid repo", { repo: raw })
    return String(raw)
}

/**
 * @param {import("express").Router} api
 * @param {{ parse: Function, isViewer?: Function }} helpers
 * @param {{ reviewService: object, reviews: object, clock?: object }} deps
 */
export function mountReviews(
    api,
    helpers,
    { reviewService, reviews, clock = systemClock }
) {
    const { parse, isViewer } = helpers
    const ownerOnly = (req) => {
        if (isViewer && isViewer(req)) throw new ForbiddenError("owner only")
    }

    api.get("/reviews", (req, res) => {
        ownerOnly(req)
        const tab = String(req.query.tab || "new")
        if (!TABS.includes(tab))
            throw new ValidationError("invalid tab", { tab })
        const nowMs = clock.now().getTime()
        const prs = reviews.listPrs()
        const repos = reviews.listRepos()
        const active = reviews.runsByStatus(ACTIVE_RUN_STATUSES)
        const settledKeys = new Set(
            reviews
                .settledRuns()
                .map((r) => settledKey(r.repo, r.number, r.trigger_key))
        )
        const view = listView({
            prs,
            runs: reviews.latestRuns(),
            settledKeys,
            repos,
            tab,
            q: String(req.query.q || "").slice(0, 200),
            nowMs,
        })
        res.json({
            ...view,
            stats: computeStats({
                prs,
                decisions: reviews.decisions(),
                runs: active,
                repos,
                settledKeys,
                nowMs,
            }),
            settings: reviewService.settings(),
            me: reviewService.whoami(),
        })
    })

    api.get("/reviews/repos", (req, res) => {
        ownerOnly(req)
        res.json({ repos: reviewService.listRepos() })
    })

    api.put("/reviews/repos/:repo", (req, res) => {
        ownerOnly(req)
        const flags = parse(RepoFlags, req.body || {}, "repo flags")
        res.json({
            repo: reviewService.setRepo(toRepo(req.params.repo), flags),
        })
    })

    api.post("/reviews/scan", (req, res) => {
        ownerOnly(req)
        const { repo } = parse(ScanBody, req.body || {}, "scan")
        const work = repo
            ? reviewService.scanRepo(toRepo(repo), { full: true })
            : reviewService.scanAll()
        // the scan runs in the background; reviews.updated follows
        Promise.resolve(work).catch(() => {})
        res.json({ ok: true })
    })

    api.post("/reviews/prs/:repo/:number/review", async (req, res) => {
        ownerOnly(req)
        const run = await reviewService.requestReview(
            toRepo(req.params.repo),
            toNumber(req.params.number, "number")
        )
        res.json({ run })
    })

    api.post("/reviews/runs/:id/cancel", async (req, res) => {
        ownerOnly(req)
        res.json({
            run: await reviewService.cancelRun(toNumber(req.params.id, "id")),
        })
    })

    api.post("/reviews/runs/:id/focus", async (req, res) => {
        ownerOnly(req)
        res.json(await reviewService.focusRun(toNumber(req.params.id, "id")))
    })
}
