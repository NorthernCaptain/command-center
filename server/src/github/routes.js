/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// PR watcher routes (owner only) and the task detail extras.

import { z } from "zod"
import { ForbiddenError } from "../util/errors.js"
import { workFolder } from "./reviewArchive.js"

const ClaimBody = z.object({ url: z.string().min(1).max(500) })
const DispositionBody = z.object({
    disposition: z.literal("no_change"),
    // the deliverable clicked (a repo can have several): its created_at
    created_at: z.string().min(1).max(64).optional(),
})
const FeedbackPatchBody = z.object({ status: z.literal("open") })
const ManualBody = z.object({ text: z.string().trim().min(1).max(300) })
const ManualPatchBody = z.object({ done: z.boolean() })

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
        const { created_at: createdAt } = parse(
            DispositionBody,
            req.body || {},
            "deliverable"
        )
        res.json(
            await prWatcher.setNoChange(id, req.params.repo, createdAt || null)
        )
    })

    // manual deliverables: Leo's checklist next to the PRs (a manual
    // install after merge); an unchecked one blocks Done
    api.post("/tasks/:id/manual-deliverables", async (req, res) => {
        ownerOnly(req)
        const id = parseTaskId(req.params.id)
        const { text } = parse(ManualBody, req.body || {}, "manual deliverable")
        res.json(await prWatcher.addManual(id, text))
    })

    api.patch("/tasks/:id/manual-deliverables/:item", async (req, res) => {
        ownerOnly(req)
        const id = parseTaskId(req.params.id)
        const { done } = parse(
            ManualPatchBody,
            req.body || {},
            "manual deliverable"
        )
        res.json(await prWatcher.setManual(id, req.params.item, done))
    })

    api.delete("/tasks/:id/manual-deliverables/:item", async (req, res) => {
        ownerOnly(req)
        const id = parseTaskId(req.params.id)
        res.json(await prWatcher.removeManual(id, req.params.item))
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
            const seen = new Set()
            for (const d of task.deliverables || []) {
                const folder = workFolder(d.repo, d.branch, task.slug)
                // a follow-up PR's deliverable can share its folder and
                // branch (the archive's key)
                const key = `${folder}\n${d.branch}`
                if (seen.has(key)) continue
                seen.add(key)
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
