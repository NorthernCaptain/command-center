/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { openDb } from "../store/db.js"
import { createFakeClock } from "../util/clock.js"
import { createReviewsRepo } from "./reviewsRepo.js"

let db
let repo

beforeEach(() => {
    db = openDb(":memory:")
    repo = createReviewsRepo(db, { clock: createFakeClock() })
})
afterEach(() => db.close())

describe("repos", () => {
    test("track / auto_review rules, scan marks, backfill", () => {
        expect(repo.getRepo("mobile")).toBeNull()
        expect(repo.setRepo("mobile", { auto_review: true })).toMatchObject({
            name: "mobile",
            track: true,
            auto_review: true,
        })
        expect(repo.setRepo("mobile", { track: false })).toMatchObject({
            track: false,
            auto_review: false,
        })
        expect(repo.setRepo("mobile", { track: true })).toMatchObject({
            track: true,
            auto_review: false,
        })
        // nothing given keeps the flags
        expect(repo.setRepo("mobile")).toMatchObject({ track: true })
        repo.markScanned("mobile", "x".repeat(600))
        expect(repo.getRepo("mobile").error).toHaveLength(500)
        expect(repo.getRepo("mobile").last_scan_at).toBeTruthy()
        repo.markScanned("mobile")
        expect(repo.getRepo("mobile").error).toBeNull()
        expect(repo.getRepo("mobile").backfilled).toBe(false)
        repo.markBackfilled("mobile")
        expect(repo.getRepo("mobile").backfilled).toBe(true)
        repo.setRepo("api")
        expect(repo.listRepos().map((r) => r.name)).toEqual(["api", "mobile"])
    })
})

describe("prs and decisions", () => {
    test("upsert keeps first_seen_at, maps booleans", () => {
        const a = repo.upsertPr({
            repo: "mobile",
            number: 417,
            title: "a",
            author: "dev1",
            is_draft: true,
            author_bot: false,
            state: "OPEN",
            updated_at: "2026-11-10T00:00:00Z",
        })
        expect(a).toMatchObject({ title: "a", is_draft: true, attempts: 0 })
        const b = repo.upsertPr({
            repo: "mobile",
            number: 417,
            title: "b",
            state: "MERGED",
            attempts: 2,
        })
        expect(b).toMatchObject({ title: "b", is_draft: false, attempts: 2 })
        expect(b.first_seen_at).toBe(a.first_seen_at)
        repo.upsertPr({ repo: "mobile", number: 9, state: "OPEN" })
        expect(repo.openPrs("mobile").map((p) => p.number)).toEqual([9])
        expect(repo.listPrs()).toHaveLength(2)
        expect(repo.getPr("mobile", 1)).toBeNull()
    })

    test("decisions are upserted by review id, with the PR author", () => {
        repo.upsertPr({ repo: "mobile", number: 417, author: "dev1" })
        repo.addDecisions("mobile", 417, [
            {
                id: "r1",
                state: "CHANGES_REQUESTED",
                submittedAt: "2026-11-11T00:00:00Z",
                commit: "a",
            },
            {
                id: "r2",
                state: "APPROVED",
                submittedAt: "2026-11-10T00:00:00Z",
            },
        ])
        repo.addDecisions("mobile", 417, [
            {
                id: "r1",
                state: "DISMISSED",
                submittedAt: "2026-11-11T00:00:00Z",
                commit: "a",
            },
        ])
        expect(repo.decisions()).toEqual([
            expect.objectContaining({
                review_id: "r2",
                state: "APPROVED",
                author: "dev1",
                commit_sha: null,
            }),
            expect.objectContaining({
                review_id: "r1",
                state: "DISMISSED",
                commit_sha: "a",
            }),
        ])
    })
})

describe("runs", () => {
    test("prLeftOpen: one PR's finished runs with an open agent", () => {
        const mk = (number, patch) => {
            const r = repo.createRun({ repo: "mobile", number, kind: "new" })
            return repo.updateRun(r.id, patch)
        }
        const a = mk(1, {
            status: "failed",
            error: "no report",
            workspace_id: "w1",
        })
        const b = mk(1, { status: "cancelled", workspace_id: "w2" })
        mk(1, { status: "done", workspace_id: null })
        mk(1, { status: "running", workspace_id: "w3" })
        mk(2, { status: "failed", workspace_id: "w4" })
        expect(repo.prLeftOpen("mobile", "1").map((r) => r.id)).toEqual([
            a.id,
            b.id,
        ])
        expect(repo.prLeftOpen("web", 1)).toEqual([])
    })

    test("create, patch, latest, by key and status", () => {
        const r1 = repo.createRun({
            repo: "mobile",
            number: 417,
            kind: "new",
            trigger_key: "k1",
        })
        expect(r1).toMatchObject({
            status: "queued",
            manual: 0,
            seen_working: false,
        })
        const r2 = repo.createRun({
            repo: "mobile",
            number: 417,
            kind: "re_review",
            manual: true,
            head_sha: "h",
        })
        repo.createRun({ repo: "api", number: 1, kind: "new" })
        expect(
            repo.updateRun(r1.id, {
                status: "running",
                seen_working: true,
                bogus: 1,
            })
        ).toMatchObject({
            status: "running",
            seen_working: true,
        })
        expect(repo.updateRun(r1.id, {})).toMatchObject({ status: "running" })
        expect(repo.latestRun("mobile", 417).id).toBe(r2.id)
        expect(repo.latestRun("mobile", 5)).toBeNull()
        expect(repo.runWithKey("mobile", 417, "k1").id).toBe(r1.id)
        expect(repo.runWithKey("mobile", 417, "k2")).toBeNull()
        expect(repo.runsByStatus(["queued"]).map((r) => r.repo)).toEqual([
            "mobile",
            "api",
        ])
        const latest = repo.latestRuns()
        expect(latest.get("mobile#417").id).toBe(r2.id)
        expect(latest.get("api#1").kind).toBe("new")
        expect(repo.getRun(999)).toBeNull()
    })
})
