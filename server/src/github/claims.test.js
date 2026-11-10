/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { openDb } from "../store/db.js"
import { createFakeClock } from "../util/clock.js"
import {
    checkCandidate,
    checkReported,
    createClaims,
    hasTaskMarker,
    parsePrUrl,
} from "./claims.js"

const URL = "https://github.com/acme/aws-lambda/pull/812"

describe("parsePrUrl", () => {
    test("parses and normalizes", () => {
        expect(parsePrUrl(`${URL}/files#x`)).toEqual({
            owner: "acme",
            repo: "aws-lambda",
            number: 812,
            url: URL,
        })
        expect(parsePrUrl(` ${URL} `).number).toBe(812)
        expect(parsePrUrl("https://github.com/a/b/issues/1")).toBeNull()
        expect(parsePrUrl(null)).toBeNull()
    })
})

describe("hasTaskMarker", () => {
    test("matches the exact task id", () => {
        expect(hasTaskMarker("x\nCommand-Center-Task: T-12\n", 12)).toBe(true)
        expect(hasTaskMarker("Command-Center-Task:T-0012", 12)).toBe(true)
        expect(hasTaskMarker("Command-Center-Task: T-123", 12)).toBe(false)
        expect(hasTaskMarker("Command-Center-Task: T-1", 12)).toBe(false)
        expect(hasTaskMarker(null, 1)).toBe(false)
    })
})

describe("checkCandidate", () => {
    const task = { id: 7 }
    const deliverable = {
        repo: "aws-lambda",
        branch: "t7-fix",
        created_at: "2026-11-07T10:00:00.000Z",
    }
    const good = {
        url: URL,
        headRefName: "t7-fix",
        headRepository: { name: "aws-lambda", owner: "Acme" },
        isCrossRepository: false,
        createdAt: "2026-11-07T11:00:00Z",
        body: "Command-Center-Task: T-7",
    }
    const claims = (owner) => ({
        claimOf: () => (owner ? { task_id: owner } : null),
    })
    const run = (pr, c = claims(null)) =>
        checkCandidate({
            task,
            deliverable,
            pr: { ...good, ...pr },
            claims: c,
            org: "acme",
        })

    test("passes all four checks", () => {
        expect(run({})).toEqual({ ok: true })
        expect(run({}, claims(7))).toEqual({ ok: true })
    })

    test("reports the first failing check", () => {
        expect(run({ headRefName: "other" }).reason).toBe("branch_mismatch")
        expect(run({ isCrossRepository: true }).reason).toBe(
            "foreign_head_repo"
        )
        expect(
            run({ headRepository: { name: "aws-lambda", owner: "fork" } })
                .reason
        ).toBe("foreign_head_repo")
        expect(
            run({ headRepository: { name: "other", owner: "acme" } }).reason
        ).toBe("foreign_head_repo")
        expect(run({ headRepository: undefined }).reason).toBe(
            "foreign_head_repo"
        )
        expect(run({ createdAt: "2026-11-07T10:00:00.000Z" }).reason).toBe(
            "created_before_start"
        )
        expect(run({ createdAt: null }).reason).toBe("created_before_start")
        expect(run({ body: "no marker" }).reason).toBe("missing_task_marker")
        expect(run({}, claims(8)).reason).toBe("claimed_by_other_task")
    })

    test("checkReported: an agent's PR may be on another branch", () => {
        const rep = (pr, c = claims(null)) =>
            checkReported({
                task,
                deliverable,
                pr: { ...good, ...pr },
                claims: c,
                org: "acme",
            })
        // existing PR on someone else's branch, no marker, older than start
        expect(
            rep({
                headRefName: "feat/other",
                createdAt: "2026-10-01T00:00:00Z",
                body: "",
            })
        ).toEqual({ ok: true })
        expect(rep({ isCrossRepository: true }).reason).toBe(
            "foreign_head_repo"
        )
        expect(
            rep({ headRepository: { name: "other", owner: "acme" } }).reason
        ).toBe("foreign_head_repo")
        expect(rep({}, claims(8)).reason).toBe("claimed_by_other_task")
        expect(rep({}, claims(7))).toEqual({ ok: true })
    })
})

describe("createClaims", () => {
    let db
    let claims
    beforeEach(() => {
        db = openDb(":memory:")
        claims = createClaims(db, { clock: createFakeClock() })
    })
    afterEach(() => db.close())

    test("claim, lookup, uniqueness and release", () => {
        expect(claims.claimOf(URL)).toBeNull()
        const r = claims.claim({
            url: URL,
            task_id: 1,
            repo: "aws-lambda",
            number: 812,
            branch: "t1-fix",
        })
        expect(r.ok).toBe(true)
        expect(r.claim).toEqual({
            url: URL,
            task_id: 1,
            repo: "aws-lambda",
            number: 812,
            branch: "t1-fix",
            claimed_at: "2026-11-07T12:00:00.000Z",
            manual: false,
        })
        // idempotent for the same task
        expect(
            claims.claim({
                url: URL,
                task_id: 1,
                repo: "aws-lambda",
                number: 812,
                branch: "t1-fix",
                manual: true,
            }).ok
        ).toBe(true)
        // another task cannot take it
        const other = claims.claim({
            url: URL,
            task_id: 2,
            repo: "aws-lambda",
            number: 812,
            branch: "x",
            manual: true,
        })
        expect(other.ok).toBe(false)
        expect(other.claim.task_id).toBe(1)

        claims.claim({
            url: `${URL}0`,
            task_id: 1,
            repo: "aws-lambda",
            number: 8120,
            branch: "b",
            manual: true,
        })
        const mine = claims.claimsForTask(1)
        expect(mine.map((c) => c.url)).toEqual([URL, `${URL}0`])
        expect(mine[1].manual).toBe(true)
        expect(claims.claimsForTask("2")).toEqual([])

        expect(claims.release(URL)).toBe(true)
        expect(claims.release(URL)).toBe(false)
        expect(claims.claimOf(URL)).toBeNull()
    })

    test("default clock", () => {
        const c = createClaims(db)
        const r = c.claim({
            url: URL,
            task_id: 1,
            repo: "r",
            number: 1,
            branch: "b",
        })
        expect(r.ok).toBe(true)
    })
})
