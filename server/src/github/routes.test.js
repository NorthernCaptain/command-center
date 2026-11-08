/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import express from "express"
import request from "supertest"
import { mapError, parseTaskId } from "../http/app.js"
import { ValidationError } from "../util/errors.js"
import { githubTaskExtras, mountGithub } from "./routes.js"

function parse(schema, value, what = "request") {
    const r = schema.safeParse(value)
    if (!r.success) throw new ValidationError(`invalid ${what}`, r.error.issues)
    return r.data
}

function makeApp({ viewer = false } = {}) {
    const prWatcher = {
        pollTask: jest.fn(async (id) => ({ task_id: id, claimed: [] })),
        claim: jest.fn(async () => ({ ok: true })),
        setNoChange: jest.fn(async (id, repo) => ({ task: { id, repo } })),
        reopenItem: jest.fn(async (id, item) => ({ item: { id: item } })),
    }
    const app = express()
    const api = express.Router()
    api.use(express.json())
    mountGithub(
        api,
        { parse, parseTaskId, isViewer: () => viewer },
        { prWatcher }
    )
    app.use("/api", api)
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        const { status, body } = mapError(err)
        res.status(status).json(body)
    })
    return { app, prWatcher }
}

describe("mountGithub", () => {
    test("POST prs/poll", async () => {
        const { app, prWatcher } = makeApp()
        const res = await request(app).post("/api/tasks/T-12/prs/poll")
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ task_id: 12, claimed: [] })
        expect(prWatcher.pollTask).toHaveBeenCalledWith(12)
    })

    test("POST prs/claim is a manual claim", async () => {
        const { app, prWatcher } = makeApp()
        const url = "https://github.com/acme/aws-lambda/pull/1"
        const res = await request(app)
            .post("/api/tasks/3/prs/claim")
            .send({ url })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ ok: true })
        expect(prWatcher.claim).toHaveBeenCalledWith(3, url, { manual: true })
        const bad = await request(app).post("/api/tasks/3/prs/claim").send({})
        expect(bad.status).toBe(400)
    })

    test("POST deliverables/:repo no_change", async () => {
        const { app, prWatcher } = makeApp()
        const res = await request(app)
            .post("/api/tasks/3/deliverables/aws-lambda")
            .send({ disposition: "no_change" })
        expect(res.status).toBe(200)
        expect(prWatcher.setNoChange).toHaveBeenCalledWith(3, "aws-lambda")
        const bad = await request(app)
            .post("/api/tasks/3/deliverables/aws-lambda")
            .send({ disposition: "pr" })
        expect(bad.status).toBe(400)
        const empty = await request(app).post(
            "/api/tasks/3/deliverables/aws-lambda"
        )
        expect(empty.status).toBe(400)
    })

    test("PATCH feedback/:item to open", async () => {
        const { app, prWatcher } = makeApp()
        const res = await request(app)
            .patch("/api/tasks/3/feedback/gh-ic-1")
            .send({ status: "open" })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ item: { id: "gh-ic-1" } })
        expect(prWatcher.reopenItem).toHaveBeenCalledWith(3, "gh-ic-1")
        const bad = await request(app)
            .patch("/api/tasks/3/feedback/gh-ic-1")
            .send({ status: "fixed" })
        expect(bad.status).toBe(400)
    })

    test("bad task id and viewers", async () => {
        const { app } = makeApp()
        expect(
            (await request(app).post("/api/tasks/abc/prs/poll")).status
        ).toBe(400)
        const viewer = makeApp({ viewer: true })
        for (const [method, path] of [
            ["post", "/api/tasks/1/prs/poll"],
            ["post", "/api/tasks/1/prs/claim"],
            ["post", "/api/tasks/1/deliverables/r"],
            ["patch", "/api/tasks/1/feedback/x"],
        ]) {
            const res = await request(viewer.app)[method](path).send({})
            expect(res.status).toBe(403)
        }
    })

    test("helpers without isViewer", async () => {
        const app = express()
        const api = express.Router()
        const prWatcher = { pollTask: jest.fn(async () => ({})) }
        mountGithub(api, { parse, parseTaskId }, { prWatcher })
        app.use("/api", api)
        expect((await request(app).post("/api/tasks/1/prs/poll")).status).toBe(
            200
        )
    })
})

describe("githubTaskExtras", () => {
    const prWatcher = {
        prs: jest.fn(() => [{ repo: "aws-lambda", number: 1 }]),
        candidates: jest.fn(() => [{ repo: "infra", url: "u", reason: "r" }]),
    }

    test("prs, candidates and latest reviews per work folder", async () => {
        const reviewArchive = {
            latest: jest.fn(async ({ folder }) =>
                folder.startsWith("aws-lambda")
                    ? {
                          status: "GOOD_TO_GO",
                          timestamp: "t",
                          file: "f",
                          dashboardUrl: "d",
                      }
                    : null
            ),
        }
        const extras = githubTaskExtras({ prWatcher, reviewArchive })
        const task = {
            slug: "k7q2",
            deliverables: [
                { repo: "aws-lambda", branch: "feature/x" },
                { repo: "infra", branch: "t1-fix" },
            ],
        }
        const out = await extras(1, task)
        expect(out).toEqual({
            prs: [{ repo: "aws-lambda", number: 1 }],
            pr_candidates: [{ repo: "infra", url: "u", reason: "r" }],
            reviews: [
                {
                    repo: "aws-lambda",
                    folder: "aws-lambda--feature-x--k7q2",
                    branch: "feature/x",
                    status: "GOOD_TO_GO",
                    timestamp: "t",
                    file: "f",
                    dashboardUrl: "d",
                },
            ],
        })
        expect(reviewArchive.latest).toHaveBeenCalledWith({
            folder: "aws-lambda--feature-x--k7q2",
            branch: "feature/x",
        })
    })

    test("no slug, no archive, no deliverables", async () => {
        const reviewArchive = { latest: jest.fn() }
        expect(
            (await githubTaskExtras({ prWatcher, reviewArchive })(1, {}))
                .reviews
        ).toEqual([])
        expect(
            (
                await githubTaskExtras({ prWatcher, reviewArchive })(1, {
                    slug: "s",
                })
            ).reviews
        ).toEqual([])
        expect(
            (await githubTaskExtras({ prWatcher })(1, { slug: "s" })).reviews
        ).toEqual([])
        expect(reviewArchive.latest).not.toHaveBeenCalled()
    })
})
