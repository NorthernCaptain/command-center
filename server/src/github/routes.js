/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// PR watcher routes (owner only) and the task detail extras.

import { z } from "zod"
import { ForbiddenError } from "../util/errors.js"
import { workFolder } from "./reviewArchive.js"

const ClaimBody = z.object({ url: z.string().min(1).max(500) })
const DispositionBody = z.object({ disposition: z.literal("no_change") })
const FeedbackPatchBody = z.object({ status: z.literal("open") })

/**
 * @param {import("express").Router} api
 * @param {{ parse: Function, parseTaskId: Function, isViewer?: Function }} helpers
 * @param {{ prWatcher: object }} deps
 */
export function mountGithub(api, helpers, { prWatcher }) {
    const { parse, parseTaskId, isViewer } = helpers
    const ownerOnly = (req) => {
        if (isViewer && isViewer(req)) throw new ForbiddenError("owner only")
    }

    api.post("/tasks/:id/prs/poll", async (req, res) => {
        ownerOnly(req)
        res.json(await prWatcher.pollTask(parseTaskId(req.params.id)))
    })

    api.post("/tasks/:id/prs/claim", async (req, res) => {
        ownerOnly(req)
        const id = parseTaskId(req.params.id)
        const { url } = parse(ClaimBody, req.body || {}, "claim")
        res.json(await prWatcher.claim(id, url, { manual: true }))
    })

    api.post("/tasks/:id/deliverables/:repo", async (req, res) => {
        ownerOnly(req)
        const id = parseTaskId(req.params.id)
        parse(DispositionBody, req.body || {}, "deliverable")
        res.json(await prWatcher.setNoChange(id, req.params.repo))
    })

    api.patch("/tasks/:id/feedback/:item", async (req, res) => {
        ownerOnly(req)
        const id = parseTaskId(req.params.id)
        parse(FeedbackPatchBody, req.body || {}, "feedback patch")
        res.json(await prWatcher.reopenItem(id, req.params.item))
    })
}

/**
 * taskExtras entry: { prs, pr_candidates, reviews } for GET /api/tasks/:id.
 * reviews = latest review-orchestrator result per work folder.
 */
export function githubTaskExtras({ prWatcher, reviewArchive }) {
    return async (id, task) => {
        const reviews = []
        if (reviewArchive && task && task.slug) {
            for (const d of task.deliverables || []) {
                const folder = workFolder(d.repo, d.branch, task.slug)
                const latest = await reviewArchive.latest({
                    folder,
                    branch: d.branch,
                })
                if (latest)
                    reviews.push({
                        repo: d.repo,
                        folder,
                        branch: d.branch,
                        ...latest,
                    })
            }
        }
        return {
            prs: prWatcher.prs(id),
            pr_candidates: prWatcher.candidates(id),
            reviews,
        }
    }
}
