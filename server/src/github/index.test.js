/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import express from "express"
import { openDb } from "../store/db.js"
import { createFakeClock } from "../util/clock.js"
import * as github from "./index.js"

describe("github index", () => {
    test("re-exports the module API", () => {
        for (const name of [
            "createClaims",
            "checkCandidate",
            "parsePrUrl",
            "createGhClient",
            "createPrWatcher",
            "classify",
            "extractItems",
            "verifyItem",
            "createReviewArchive",
            "workFolder",
            "githubTaskExtras",
            "mountGithub",
            "createGithub",
        ])
            expect(typeof github[name]).toBe("function")
    })

    test("createGithub wires gh, claims, watcher, archive, routes", async () => {
        const db = openDb(":memory:")
        const exec = jest.fn(async () => "[]")
        const mod = github.createGithub({
            config: {
                github: { org: "acme", ghBin: "gh2", pollMinutes: 5 },
                review: { archiveDir: "/nonexistent", dashboardUrl: "d" },
            },
            exec,
            db,
            store: {},
            clock: createFakeClock(),
        })
        expect(await mod.gh.listPrsByHead("r", "b")).toEqual([])
        expect(exec.mock.calls[0][0]).toBe("gh2")
        expect(exec.mock.calls[0][1]).toContain("acme/r")
        expect(mod.claims.claimOf("x")).toBeNull()
        expect(mod.prWatcher.prs(1)).toEqual([])
        expect(
            await mod.reviewArchive.latest({ folder: "f", branch: "b" })
        ).toBeNull()
        const api = express.Router()
        mod.mount(api, { parse: () => ({}), parseTaskId: Number })
        expect(api.stack.length).toBe(4)
        expect(await mod.taskExtras(1, {})).toEqual({
            prs: [],
            pr_candidates: [],
            reviews: [],
        })
        db.close()
    })

    test("createGithub defaults", () => {
        const db = openDb(":memory:")
        const mod = github.createGithub({ db, store: {} })
        expect(mod.prWatcher).toBeTruthy()
        db.close()
    })
})
