/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import express from "express"
import request from "supertest"
import { mapError } from "../http/app.js"
import { openDb } from "../store/db.js"
import { createFakeClock } from "../util/clock.js"
import { ValidationError } from "../util/errors.js"
import { createReviews } from "./index.js"
import { mountReviews } from "./routes.js"
import { createReviewsRepo } from "./reviewsRepo.js"

function parse(schema, value, what = "request") {
    const r = schema.safeParse(value)
    if (!r.success) throw new ValidationError(`invalid ${what}`, r.error.issues)
    return r.data
}

let db
beforeEach(() => {
    db = openDb(":memory:")
})
afterEach(() => db.close())

function makeApp({ viewer = false } = {}) {
    const clock = createFakeClock(new Date("2026-11-14T12:00:00Z"))
    const reviews = createReviewsRepo(db, { clock })
    const reviewService = {
        settings: jest.fn(() => ({
            poll_minutes: 20,
            parallel: 4,
            agent_kind: "claude",
        })),
        whoami: jest.fn(() => "leok"),
        listRepos: jest.fn(() => [{ name: "mobile", track: true }]),
        setRepo: jest.fn((name, flags) => ({ name, ...flags })),
        scanRepo: jest.fn(async () => ({})),
        scanAll: jest.fn(async () => {
            throw new Error("gh down") // background: never reaches the client
        }),
        requestReview: jest.fn(async (repo, number) => ({
            id: 1,
            repo,
            number,
        })),
        cancelRun: jest.fn(async (id) => ({ id, status: "cancelled" })),
        focusRun: jest.fn(async () => ({ ok: true })),
    }
    const app = express()
    const api = express.Router()
    api.use(express.json())
    mountReviews(
        api,
        { parse, isViewer: () => viewer },
        { reviewService, reviews, clock }
    )
    app.use("/api", api)
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        const { status, body } = mapError(err)
        res.status(status).json(body)
    })
    return { app, reviewService, reviews }
}

describe("mountReviews", () => {
    test("GET /reviews: rows, counts, stats, settings, me", async () => {
        const { app, reviews } = makeApp()
        reviews.upsertPr({
            repo: "mobile",
            number: 417,
            title: "Fix the login flow",
            author: "dev1",
            state: "OPEN",
            base: "main",
            needs_review: "new",
            created_at: "2026-11-13T10:00:00Z",
        })
        reviews.upsertPr({
            repo: "mobile",
            number: 12,
            title: "Old",
            author: "dev2",
            state: "OPEN",
            base: "main",
            decision: "changes_requested",
            decided_at: "2026-11-13T10:00:00Z",
        })
        reviews.setRepo("mobile", { auto_review: true })
        reviews.createRun({ repo: "mobile", number: 417, kind: "new" })
        // in the queue: Queued, not New
        const res = await request(app).get("/api/reviews")
        expect(res.status).toBe(200)
        expect(res.body.prs).toEqual([])
        const queued = await request(app).get("/api/reviews?tab=queued")
        expect(queued.body.prs.map((p) => p.number)).toEqual([417])
        expect(queued.body.prs[0].run).toMatchObject({ status: "queued" })
        expect(res.body.counts).toEqual({
            new: 0,
            queued: 1,
            rejected: 1,
            approved: 0,
            all: 2,
        })
        expect(res.body.stats).toMatchObject({ queued: 1, waiting: 0 })
        expect(res.body.settings).toEqual({
            poll_minutes: 20,
            parallel: 4,
            agent_kind: "claude",
        })
        expect(res.body.me).toBe("leok")
        const q = await request(app).get("/api/reviews?tab=all&q=%2312")
        expect(q.body.prs.map((p) => p.number)).toEqual([12])
        const bad = await request(app).get("/api/reviews?tab=nope")
        expect(bad.status).toBe(400)
    })

    test("repos: list and flags", async () => {
        const { app, reviewService } = makeApp()
        expect((await request(app).get("/api/reviews/repos")).body).toEqual({
            repos: [{ name: "mobile", track: true }],
        })
        const res = await request(app)
            .put("/api/reviews/repos/mobile")
            .send({ auto_review: true })
        expect(res.body).toEqual({
            repo: { name: "mobile", auto_review: true },
        })
        expect(reviewService.setRepo).toHaveBeenCalledWith("mobile", {
            auto_review: true,
        })
        expect(
            (await request(app).put("/api/reviews/repos/mobile").send({ x: 1 }))
                .status
        ).toBe(400)
        expect(
            (
                await request(app)
                    .put("/api/reviews/repos/bad%20name")
                    .send({ track: true })
            ).status
        ).toBe(400)
    })

    test("scan: one repo or all, in the background", async () => {
        const { app, reviewService } = makeApp()
        expect(
            (
                await request(app)
                    .post("/api/reviews/scan")
                    .send({ repo: "mobile" })
            ).body
        ).toEqual({ ok: true })
        expect(reviewService.scanRepo).toHaveBeenCalledWith("mobile", {
            full: true,
        })
        expect((await request(app).post("/api/reviews/scan")).body).toEqual({
            ok: true,
        })
        expect(reviewService.scanAll).toHaveBeenCalled()
    })

    test("review, cancel, focus", async () => {
        const { app, reviewService } = makeApp()
        const r = await request(app).post("/api/reviews/prs/mobile/417/review")
        expect(r.body).toEqual({ run: { id: 1, repo: "mobile", number: 417 } })
        expect(
            (await request(app).post("/api/reviews/prs/mobile/x/review")).status
        ).toBe(400)
        const c = await request(app).post("/api/reviews/runs/3/cancel")
        expect(c.body).toEqual({ run: { id: 3, status: "cancelled" } })
        expect(reviewService.cancelRun).toHaveBeenCalledWith(3)
        const f = await request(app).post("/api/reviews/runs/3/focus")
        expect(f.body).toEqual({ ok: true })
        expect(
            (await request(app).post("/api/reviews/runs/0/focus")).status
        ).toBe(400)
    })

    test("viewers are refused", async () => {
        const { app } = makeApp({ viewer: true })
        for (const [method, path] of [
            ["get", "/api/reviews"],
            ["get", "/api/reviews/repos"],
            ["put", "/api/reviews/repos/mobile"],
            ["post", "/api/reviews/scan"],
            ["post", "/api/reviews/prs/mobile/1/review"],
            ["post", "/api/reviews/runs/1/cancel"],
            ["post", "/api/reviews/runs/1/focus"],
        ])
            expect((await request(app)[method](path).send({})).status).toBe(403)
    })
})

describe("createReviews", () => {
    test("builds the repo, the service and the mount", async () => {
        const mod = createReviews({
            db,
            config: {
                reviews: { dir: "/tmp/acme-reviews" },
                github: { login: "leok" },
            },
            gh: { org: "acme" },
            herdr: {},
            repoTable: { list: () => [{ name: "mobile" }] },
        })
        expect(mod.reviewService.whoami()).toBe("leok")
        expect(mod.reviewService.listRepos()).toEqual([
            expect.objectContaining({ name: "mobile", track: false }),
        ])
        const app = express()
        const api = express.Router()
        mod.mount(api, { parse, isViewer: () => false })
        app.use("/api", api)
        const res = await request(app).get("/api/reviews/repos")
        expect(res.body.repos[0].name).toBe("mobile")
        const bare = createReviews({ db, gh: {}, herdr: {} })
        expect(bare.reviewService.whoami()).toBeNull()
    })
})
