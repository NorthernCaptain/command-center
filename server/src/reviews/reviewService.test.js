/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import os from "node:os"
import path from "node:path"
import { openDb } from "../store/db.js"
import { createFakeClock } from "../util/clock.js"
import { CLOSED_PRS_QUERY, OPEN_PRS_QUERY, ineligibleReason } from "./prScan.js"
import { createReviewsRepo } from "./reviewsRepo.js"
import { createReviewService } from "./reviewService.js"

const ORG = "acme"
const ME = "acme-me"
const DIR = "/tmp/acme-reviews"
const MCP = ["--mcp-config", "{}"]

function node(n, over = {}) {
    return {
        number: n,
        url: `https://github.com/${ORG}/mobile/pull/${n}`,
        title: `Fix thing ${n}`,
        isDraft: false,
        baseRefName: "main",
        headRefOid: `sha${n}`,
        createdAt: "2026-11-01T10:00:00Z",
        updatedAt: "2026-11-06T10:00:00Z",
        mergedAt: null,
        closedAt: null,
        state: "OPEN",
        additions: 3,
        deletions: 1,
        changedFiles: 2,
        mergeable: "MERGEABLE",
        reviewDecision: null,
        author: { __typename: "User", login: "dev1" },
        reviews: { nodes: [] },
        commits: {
            nodes: [
                {
                    commit: {
                        oid: over.headRefOid || `sha${n}`,
                        committedDate: "2026-11-05T10:00:00Z",
                        statusCheckRollup: { state: "SUCCESS" },
                    },
                },
            ],
        },
        comments: { nodes: [] },
        reviewThreads: { nodes: [] },
        ...over,
    }
}

const mine = (id, state, at, oid) => ({
    id,
    author: { __typename: "User", login: ME },
    state,
    submittedAt: at,
    commit: { oid },
})

function makeGh() {
    const gh = {
        org: ORG,
        open: {},
        closed: {},
        byNum: {},
        fail: null,
        login: jest.fn(async () => ME),
        errors: [],
        graphql: jest.fn(async (query, vars, opts) => {
            const data = await gh.answer(query, vars)
            return opts && opts.partial ? { data, errors: gh.errors } : data
        }),
        answer: jest.fn(async (query, vars) => {
            if (gh.fail) throw gh.fail
            const repo = vars.name
            if (query === OPEN_PRS_QUERY)
                return gh.open[repo] === null
                    ? { repository: null }
                    : {
                          repository: {
                              defaultBranchRef: { name: "main" },
                              pullRequests: { nodes: gh.open[repo] || [] },
                          },
                      }
            if (query === CLOSED_PRS_QUERY)
                return {
                    repository: {
                        defaultBranchRef: { name: "main" },
                        pullRequests: { nodes: gh.closed[repo] || [] },
                    },
                }
            const out = { defaultBranchRef: { name: "main" } }
            // details by number: an explicit answer, else the open node
            for (const m of query.matchAll(/p(\d+): pullRequest/g))
                out[`p${m[1]}`] =
                    gh.byNum[`${repo}#${m[1]}`] ??
                    (gh.open[repo] || []).find(
                        (n) => n && n.number === Number(m[1])
                    ) ??
                    null
            return { repository: out }
        }),
    }
    return gh
}

function makeHerdr() {
    let seq = 0
    const h = {
        agents: new Map(), // name -> status
        agentGet: jest.fn(async (name) =>
            h.agents.has(name) ? { name, status: h.agents.get(name) } : null
        ),
        workspaceCreate: jest.fn(async () => {
            seq++
            return { workspaceId: `w${seq}`, paneId: `p${seq}` }
        }),
        agentStart: jest.fn(async ({ name }) => {
            h.agents.set(name, "idle")
        }),
        agentPrompt: jest.fn(async () => ({})),
        workspaceClose: jest.fn(async () => ({})),
        agentFocus: jest.fn(async () => ({})),
    }
    return h
}

let db
let clock

beforeEach(() => {
    db = openDb(":memory:")
    clock = createFakeClock("2026-11-07T12:00:00.000Z")
})

afterEach(() => db.close())

function setup(over = {}) {
    const reviews = createReviewsRepo(db, { clock })
    const gh = makeGh()
    const herdr = makeHerdr()
    const values = {}
    const settingsRepo = {
        values,
        get: jest.fn((k, f) => (k in values ? values[k] : f)),
    }
    const bus = { emit: jest.fn() }
    const fs = {
        promises: {
            rm: jest.fn(async () => {}),
            mkdir: jest.fn(async () => {}),
        },
    }
    const log = { warn: jest.fn(), info: jest.fn(), debug: jest.fn() }
    const repoTable = {
        list: () => [
            { name: "mobile", description: "the app" },
            { name: "web", description: "the site" },
        ],
    }
    const svc = createReviewService({
        reviews,
        gh,
        herdr,
        repoTable,
        settingsRepo,
        bus,
        clock,
        log,
        reviewsDir: DIR,
        agentEnv: () => ({ CC_URL: "http://127.0.0.1:1", CC_TOKEN: "t" }),
        mcpArgs: () => MCP,
        fs,
        ...over,
    })
    return { svc, reviews, gh, herdr, settingsRepo, bus, fs, log }
}

const emitted = (bus) =>
    bus.emit.mock.calls.filter((c) => c[0] === "reviews.updated").length
const openQueries = (gh) =>
    gh.graphql.mock.calls.filter((c) => c[0] === OPEN_PRS_QUERY)

describe("ineligibleReason", () => {
    test("closed and draft; bots and stacked PRs are eligible", () => {
        const pr = {
            state: "OPEN",
            base: "main",
            default_branch: "develop",
        }
        expect(ineligibleReason(pr)).toBeNull()
        expect(ineligibleReason({ ...pr, base: "develop" })).toBeNull()
        expect(ineligibleReason({ ...pr, state: "MERGED" })).toBe("merged")
        expect(ineligibleReason({ ...pr, state: "CLOSED" })).toBe("closed")
        expect(ineligibleReason({ ...pr, is_draft: true })).toBe("draft")
        expect(ineligibleReason({ ...pr, author_bot: true })).toBeNull()
        expect(ineligibleReason({ ...pr, base: "rel" })).toBeNull()
    })
})

describe("scan", () => {
    test("stores other developers' PRs with our decisions; skips ours", async () => {
        const { svc, reviews, gh, bus } = setup()
        reviews.setRepo("mobile", { track: true })
        gh.open.mobile = [
            node(1),
            node(2, { author: { __typename: "User", login: ME } }),
            node(3, { author: { __typename: "Bot", login: "renovate" } }),
            node(4, {
                headRefOid: "sha4b",
                reviews: {
                    nodes: [
                        mine(
                            "r1",
                            "CHANGES_REQUESTED",
                            "2026-11-03T10:00:00Z",
                            "sha4a"
                        ),
                    ],
                },
            }),
            null,
        ]
        const r = await svc.scanRepo("mobile")
        expect(r).toEqual({ repo: "mobile", prs: 3, queued: 0 })
        expect(reviews.getPr("mobile", 2)).toBeNull()
        expect(reviews.getPr("mobile", 1)).toMatchObject({
            needs_review: "new",
            author: "dev1",
            default_branch: "main",
        })
        expect(reviews.getPr("mobile", 3)).toMatchObject({ author_bot: true })
        expect(reviews.getPr("mobile", 4)).toMatchObject({
            decision: "changes_requested",
            attempts: 1,
            needs_review: "re_review",
        })
        expect(reviews.decisions()).toHaveLength(1)
        expect(reviews.getRepo("mobile")).toMatchObject({
            error: null,
            backfilled: true,
        })
        expect(reviews.getRepo("mobile").last_scan_at).toBeTruthy()
        expect(emitted(bus)).toBeGreaterThan(0)
        expect(svc.whoami()).toBe(ME)
        // one scan per repo at a time
        const a = svc.scanRepo("mobile")
        expect(svc.scanRepo("mobile")).toBe(a)
        await a
        expect(gh.login).toHaveBeenCalledTimes(1)
    })

    test("PRs gone from the open list are fetched by number", async () => {
        const { svc, reviews, gh } = setup()
        gh.open.mobile = [node(1), node(2), node(5)]
        await svc.scanRepo("mobile")
        gh.open.mobile = [node(1)]
        gh.byNum["mobile#2"] = node(2, {
            state: "MERGED",
            mergedAt: "2026-11-07T11:00:00Z",
        })
        await svc.scanRepo("mobile")
        const byNum = gh.graphql.mock.calls.at(-1)[0]
        expect(byNum).toContain("p2: pullRequest(number: 2)")
        expect(byNum).toContain("p5: pullRequest(number: 5)")
        expect(reviews.getPr("mobile", 2)).toMatchObject({
            state: "MERGED",
            needs_review: null,
        })
        // not answered: kept as it was
        expect(reviews.getPr("mobile", 5).state).toBe("OPEN")
        // an untracked repo is never backfilled
        expect(
            gh.graphql.mock.calls.filter((c) => c[0] === CLOSED_PRS_QUERY)
        ).toHaveLength(0)
    })

    test("first scan backfills the closed PRs we reviewed, once", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { track: true })
        gh.closed.mobile = [
            node(7, {
                state: "MERGED",
                mergedAt: "2026-11-02T10:00:00Z",
                reviews: {
                    nodes: [
                        mine("r7", "APPROVED", "2026-11-02T09:00:00Z", "sha7"),
                    ],
                },
            }),
            node(8, { state: "CLOSED", closedAt: "2026-11-02T10:00:00Z" }),
            null,
        ]
        await svc.scanRepo("mobile")
        await svc.scanRepo("mobile")
        expect(
            gh.graphql.mock.calls.filter((c) => c[0] === CLOSED_PRS_QUERY)
        ).toHaveLength(1)
        expect(reviews.getPr("mobile", 7)).toMatchObject({
            decision: "approved",
            state: "MERGED",
        })
        expect(reviews.getPr("mobile", 8)).toBeNull()
    })

    test("errors are recorded on the repo and emitted", async () => {
        const { svc, reviews, gh, bus } = setup()
        reviews.setRepo("mobile", { track: true })
        gh.fail = new Error("gh down")
        expect(await svc.scanRepo("mobile")).toEqual({
            repo: "mobile",
            error: "gh down",
        })
        expect(reviews.getRepo("mobile").error).toBe("gh down")
        expect(emitted(bus)).toBe(1)
        gh.fail = null
        gh.open.mobile = null
        expect((await svc.scanRepo("mobile")).error).toBe(
            "repository acme/mobile not found"
        )
        // a successful scan clears the error
        gh.open.mobile = []
        await svc.scanRepo("mobile")
        expect(reviews.getRepo("mobile").error).toBeNull()
        const noOrg = setup({ gh: { ...makeGh(), org: null } })
        expect((await noOrg.svc.scanRepo("mobile")).error).toBe(
            "github.org is not configured"
        )
    })

    test("scanAll scans every tracked repo", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { track: true })
        reviews.setRepo("web", { track: true })
        reviews.setRepo("other", { track: false })
        const r = await svc.scanAll()
        expect(r.map((x) => x.repo)).toEqual(["mobile", "web"])
        expect(openQueries(gh).map((c) => c[1].name)).toEqual(["mobile", "web"])
    })
})

describe("auto-review queue", () => {
    test("queues new and re-review runs once per trigger key", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { auto_review: true })
        gh.open.mobile = [
            node(1),
            node(4, {
                headRefOid: "sha4b",
                reviews: {
                    nodes: [
                        mine(
                            "r1",
                            "CHANGES_REQUESTED",
                            "2026-11-03T10:00:00Z",
                            "sha4a"
                        ),
                    ],
                },
            }),
            node(5, { isDraft: true }),
        ]
        expect((await svc.scanRepo("mobile")).queued).toBe(2)
        const queued = reviews.runsByStatus(["queued"])
        expect(queued.map((r) => [r.number, r.kind])).toEqual([
            [1, "new"],
            [4, "re_review"],
        ])
        // an active run: nothing more
        expect((await svc.scanRepo("mobile")).queued).toBe(0)
        // done for this state: never again automatically
        for (const r of queued) reviews.updateRun(r.id, { status: "done" })
        expect((await svc.scanRepo("mobile")).queued).toBe(0)
        // new commits (GitHub bumps updatedAt): a new run
        gh.open.mobile[0] = node(1, {
            headRefOid: "sha1b",
            updatedAt: "2026-11-07T10:00:00Z",
        })
        expect((await svc.scanRepo("mobile")).queued).toBe(1)
    })

    test("only new / changed / long unrefreshed PRs get their details", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { track: true })
        gh.open.mobile = [
            node(1),
            node(2),
            node(3, { author: { __typename: "User", login: ME } }),
        ]
        await svc.scanRepo("mobile")
        const details = () =>
            gh.graphql.mock.calls
                .filter(
                    (c) => c[0] !== OPEN_PRS_QUERY && c[0] !== CLOSED_PRS_QUERY
                )
                .map((c) =>
                    [...c[0].matchAll(/p(\d+): pullRequest/g)].map((m) =>
                        Number(m[1])
                    )
                )
        // ours (#3) is never fetched in detail
        expect(details()).toEqual([[1, 2]])
        // nothing changed: the list only
        await svc.scanRepo("mobile")
        expect(details()).toHaveLength(1)
        // #2 changed
        gh.open.mobile[1] = node(2, { updatedAt: "2026-11-08T10:00:00Z" })
        await svc.scanRepo("mobile")
        expect(details().at(-1)).toEqual([2])
        // full refresh, and the 6 h refresh
        await svc.scanRepo("mobile", { full: true })
        expect(details().at(-1)).toEqual([1, 2])
        later(6 * 3600000)
        await svc.scanRepo("mobile")
        expect(details().at(-1)).toEqual([1, 2])
        // a stored PR that is no longer open is fetched again when it reopens
        reviews.upsertPr({ ...reviews.getPr("mobile", 1), state: "CLOSED" })
        gh.open.mobile = [node(1), gh.open.mobile[1]]
        await svc.scanRepo("mobile")
        expect(details().at(-1)).toEqual([1])
    })

    test("the open list follows its pages", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { track: true })
        gh.open.mobile = [node(1), node(2)]
        const base = gh.graphql.getMockImplementation()
        gh.graphql.mockImplementation(async (query, vars, opts) => {
            if (query !== OPEN_PRS_QUERY) return base(query, vars, opts)
            const page = vars.after === "c1" ? [node(2)] : [node(1)]
            return {
                repository: {
                    defaultBranchRef: { name: "main" },
                    pullRequests: {
                        nodes: page,
                        pageInfo: {
                            hasNextPage: !vars.after,
                            endCursor: vars.after ? null : "c1",
                        },
                    },
                },
            }
        })
        await svc.scanRepo("mobile")
        expect(
            gh.graphql.mock.calls
                .filter((c) => c[0] === OPEN_PRS_QUERY)
                .map((c) => c[1].after || null)
        ).toEqual([null, "c1"])
        expect(reviews.openPrs("mobile").map((p) => p.number)).toEqual([1, 2])
        // our reviews come with the author filter variable
        expect(
            gh.graphql.mock.calls.find((c) => c[0] !== OPEN_PRS_QUERY)[1]
        ).toMatchObject({ me: ME })
    })

    test("a PR answered with an error keeps its stored state; a query error fails the scan", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { track: true })
        gh.open.mobile = [
            node(1, {
                reviews: {
                    nodes: [
                        mine("r1", "APPROVED", "2026-11-05T10:00:00Z", "sha1"),
                    ],
                },
            }),
            node(2),
        ]
        await svc.scanRepo("mobile")
        expect(reviews.getPr("mobile", 1).decision).toBe("approved")
        // #1 comes back without its reviews and an error on that path
        gh.open.mobile = [
            node(1, { reviews: null, updatedAt: "2026-11-08T10:00:00Z" }),
            node(2, { updatedAt: "2026-11-08T10:00:00Z", title: "Renamed" }),
        ]
        gh.errors = [{ message: "boom", path: ["repository", "p1", "reviews"] }]
        const r = await svc.scanRepo("mobile")
        expect(r.error).toBeUndefined()
        expect(reviews.getPr("mobile", 1)).toMatchObject({
            decision: "approved",
            updated_at: "2026-11-06T10:00:00Z",
        })
        expect(reviews.getPr("mobile", 2).title).toBe("Renamed")
        // an error that is not about one PR: the scan fails
        gh.errors = [{ message: "rate limited" }]
        gh.open.mobile[1] = node(2, { updatedAt: "2026-11-09T10:00:00Z" })
        expect((await svc.scanRepo("mobile")).error).toBe(
            "gh graphql: rate limited"
        )
        await svc.stop()
    })

    test("a queued re-review survives the author's answer leaving the fetched window", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { auto_review: true })
        const cr = {
            nodes: [
                mine("r1", "CHANGES_REQUESTED", "2026-11-05T10:00:00Z", "sha1"),
            ],
        }
        gh.open.mobile = [
            node(1, {
                reviews: cr,
                comments: {
                    nodes: [
                        {
                            author: { __typename: "User", login: "dev1" },
                            createdAt: "2026-11-06T09:00:00Z",
                        },
                    ],
                },
            }),
        ]
        await svc.scanRepo("mobile")
        const run = reviews.latestRun("mobile", 1)
        expect(run).toMatchObject({ status: "queued", kind: "re_review" })
        // 50 newer comments by others push the answer out of the window
        gh.open.mobile = [
            node(1, {
                reviews: cr,
                updatedAt: "2026-11-07T10:00:00Z",
                comments: { nodes: [] },
            }),
        ]
        await svc.scanRepo("mobile")
        expect(reviews.getRun(run.id).status).toBe("queued")
        expect(reviews.getPr("mobile", 1).needs_review).toBe("re_review")
        await svc.stop()
    })

    test("an incomplete list (a cursor repeats) never marks PRs gone", async () => {
        const { svc, reviews, gh, log } = setup()
        reviews.setRepo("mobile", { track: true })
        gh.open.mobile = [node(1), node(2)]
        await svc.scanRepo("mobile")
        const base = gh.graphql.getMockImplementation()
        let page = 0
        gh.graphql.mockImplementation(async (query, vars, opts) => {
            if (query !== OPEN_PRS_QUERY) return base(query, vars, opts)
            page++
            // GitHub hands out the same cursor again; #2 never listed
            return {
                repository: {
                    defaultBranchRef: { name: "main" },
                    pullRequests: {
                        nodes: [node(1)],
                        pageInfo: { hasNextPage: true, endCursor: "c1" },
                    },
                },
            }
        })
        await svc.scanRepo("mobile")
        expect(page).toBe(2)
        expect(reviews.getPr("mobile", 2).state).toBe("OPEN")
        expect(log.warn).toHaveBeenCalledWith(
            { repo: "mobile", listed: 2 },
            "review scan: open PR list incomplete"
        )
        await svc.stop()
    })

    test("an author's answer older than the newest 100 comments still counts", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { track: true })
        const others = Array.from({ length: 100 }, (_, i) => ({
            author: { __typename: "User", login: "dev2" },
            createdAt: `2026-11-06T1${String(i).padStart(3, "0").slice(0, 1)}:${String(i % 60).padStart(2, "0")}:00Z`,
        }))
        gh.open.mobile = [
            node(1, {
                reviews: {
                    nodes: [
                        mine(
                            "r1",
                            "CHANGES_REQUESTED",
                            "2026-11-05T10:00:00Z",
                            "sha1"
                        ),
                    ],
                },
                comments: {
                    nodes: others,
                    pageInfo: { hasPreviousPage: true, startCursor: "c0" },
                },
            }),
        ]
        const base = gh.graphql.getMockImplementation()
        gh.graphql.mockImplementation(async (query, vars, opts) => {
            if (!query.includes("before: $before"))
                return base(query, vars, opts)
            expect(vars.before).toBe("c0")
            // the older page holds the author's answer
            return {
                repository: {
                    pullRequest: {
                        comments: {
                            pageInfo: {
                                hasPreviousPage: true,
                                startCursor: "c-1",
                            },
                            nodes: [
                                {
                                    author: { __typename: "Bot", login: "x" },
                                    createdAt: "2026-11-05T08:00:00Z",
                                },
                                {
                                    author: {
                                        __typename: "User",
                                        login: "dev1",
                                    },
                                    createdAt: "2026-11-05T12:00:00Z",
                                },
                            ],
                        },
                    },
                },
            }
        })
        await svc.scanRepo("mobile")
        expect(reviews.getPr("mobile", 1)).toMatchObject({
            needs_review: "re_review",
            trigger_key: "re_review:sha1:2026-11-05T12:00:00Z",
        })
        await svc.stop()
    })

    test("unchanged is refused for a first review; it never hides an unreviewed PR", async () => {
        const { svc, reviews, run } = await launched()
        expect(run.kind).toBe("new")
        await expect(
            svc.report({ review_id: run.id, verdict: "unchanged" }, {})
        ).rejects.toThrow("unchanged is only for a re-review")
        expect(reviews.getRun(run.id).status).toBe("running")
        await svc.stop()
    })

    test("a failing older-comments page skips that PR only; the others are queued", async () => {
        const { svc, reviews, gh, log } = setup()
        reviews.setRepo("mobile", { auto_review: true })
        gh.open.mobile = [
            node(1),
            node(2, {
                reviews: {
                    nodes: [
                        mine(
                            "r2",
                            "CHANGES_REQUESTED",
                            "2026-11-05T10:00:00Z",
                            "sha2"
                        ),
                    ],
                },
                comments: {
                    nodes: [
                        {
                            author: { __typename: "User", login: "dev2" },
                            createdAt: "2026-11-06T10:00:00Z",
                        },
                    ],
                    pageInfo: { hasPreviousPage: true, startCursor: "c0" },
                },
            }),
        ]
        const base = gh.graphql.getMockImplementation()
        gh.graphql.mockImplementation(async (query, vars, opts) => {
            if (query.includes("before: $before")) throw new Error("502")
            return base(query, vars, opts)
        })
        const r = await svc.scanRepo("mobile")
        expect(r.error).toBeUndefined()
        expect(log.warn).toHaveBeenCalledWith(
            { err: "502", repo: "mobile", pr: 2 },
            "review scan: older comments"
        )
        expect(reviews.getPr("mobile", 2)).toBeNull()
        expect(reviews.latestRun("mobile", 1)).toMatchObject({
            status: "queued",
            kind: "new",
        })
        await svc.stop()
    })

    test("a scan that fails midway still queues what it stored", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { auto_review: true })
        gh.open.mobile = [node(1)]
        await svc.scanRepo("mobile")
        // stored and wanted, but not queued yet (e.g. a crash before)
        reviews.updateRun(reviews.latestRun("mobile", 1).id, {
            status: "cancelled",
            started_at: null,
        })
        gh.fail = new Error("gh down")
        expect((await svc.scanRepo("mobile")).error).toBe("gh down")
        expect(reviews.runsByStatus(["queued"])).toHaveLength(1)
        await svc.stop()
    })

    test("a deciding review older than our newest 100 still decides", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { auto_review: true })
        const recent = Array.from({ length: 100 }, (_, i) =>
            mine(
                `a${i}`,
                "DISMISSED",
                `2026-11-06T10:${String(i % 60).padStart(2, "0")}:00Z`,
                "sha1"
            )
        )
        gh.open.mobile = [
            node(1, {
                reviews: {
                    nodes: recent,
                    pageInfo: { hasPreviousPage: true, startCursor: "r0" },
                },
            }),
        ]
        const base = gh.graphql.getMockImplementation()
        gh.graphql.mockImplementation(async (query, vars, opts) => {
            if (!query.includes("reviews(last: 100, before: $before"))
                return base(query, vars, opts)
            expect(vars).toMatchObject({ before: "r0", me: ME })
            return {
                repository: {
                    pullRequest: {
                        reviews: {
                            pageInfo: { hasPreviousPage: false },
                            nodes: [
                                mine(
                                    "old",
                                    "CHANGES_REQUESTED",
                                    "2026-11-05T10:00:00Z",
                                    "sha1"
                                ),
                            ],
                        },
                    },
                },
            }
        })
        await svc.scanRepo("mobile")
        expect(reviews.getPr("mobile", 1)).toMatchObject({
            decision: "changes_requested",
            attempts: 101,
            needs_review: null,
        })
        expect(reviews.runsByStatus(["queued"])).toHaveLength(0)
        // the history page failing: the PR keeps its stored state
        reviews.upsertPr({ ...reviews.getPr("mobile", 1), title: "kept" })
        gh.open.mobile = [
            node(1, {
                reviews: {
                    nodes: recent,
                    pageInfo: { hasPreviousPage: true, startCursor: "r0" },
                },
            }),
        ]
        gh.graphql.mockImplementation(async (query, vars, opts) => {
            if (query.includes("reviews(last: 100, before: $before"))
                throw new Error("502")
            return base(query, vars, opts)
        })
        await svc.scanRepo("mobile", { full: true })
        expect(reviews.getPr("mobile", 1).title).toBe("kept")
        await svc.stop()
    })

    test("a queued run whose PR closed is dropped by the next scan", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { auto_review: true })
        gh.open.mobile = [node(1)]
        await svc.scanRepo("mobile")
        const run = reviews.latestRun("mobile", 1)
        expect(run.status).toBe("queued") // all slots busy: not started
        gh.open.mobile = []
        gh.byNum["mobile#1"] = node(1, {
            state: "MERGED",
            mergedAt: "2026-11-07T11:00:00Z",
        })
        await svc.scanRepo("mobile")
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "cancelled",
            error: "PR is not open",
        })
        await svc.stop()
    })

    test("a backfill with a failed history page is tried again", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { track: true })
        const closed = () => [
            node(7, {
                state: "MERGED",
                mergedAt: "2026-11-02T10:00:00Z",
                reviews: {
                    nodes: [
                        mine("r7", "APPROVED", "2026-11-02T09:00:00Z", "sha7"),
                    ],
                    pageInfo: { hasPreviousPage: true, startCursor: "h0" },
                },
            }),
        ]
        gh.closed.mobile = closed()
        const base = gh.graphql.getMockImplementation()
        let fail = true
        gh.graphql.mockImplementation(async (query, vars, opts) => {
            if (!query.includes("reviews(last: 100, before: $before"))
                return base(query, vars, opts)
            if (fail) throw new Error("502")
            return {
                repository: {
                    pullRequest: {
                        reviews: {
                            pageInfo: { hasPreviousPage: false },
                            nodes: [],
                        },
                    },
                },
            }
        })
        await svc.scanRepo("mobile")
        expect(reviews.getRepo("mobile").backfilled).toBe(false)
        expect(reviews.getPr("mobile", 7)).toBeNull()
        fail = false
        gh.closed.mobile = closed()
        await svc.scanRepo("mobile")
        expect(reviews.getRepo("mobile").backfilled).toBe(true)
        expect(reviews.getPr("mobile", 7)).toMatchObject({
            decision: "approved",
        })
        await svc.stop()
    })

    test("details come in batches of ten", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { track: true })
        gh.open.mobile = Array.from({ length: 23 }, (_, i) => node(i + 1))
        await svc.scanRepo("mobile")
        const sizes = gh.graphql.mock.calls
            .filter((c) => c[0] !== OPEN_PRS_QUERY && c[0] !== CLOSED_PRS_QUERY)
            .map((c) => [...c[0].matchAll(/pullRequest\(/g)].length)
        expect(sizes).toEqual([10, 10, 3])
        expect(reviews.openPrs("mobile")).toHaveLength(23)
    })

    test("tracked-only repos queue nothing", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { track: true })
        gh.open.mobile = [node(1)]
        expect((await svc.scanRepo("mobile")).queued).toBe(0)
        expect(reviews.runsByStatus(["queued"])).toHaveLength(0)
    })

    test("a queued automatic run is dropped once no review is needed; manual ones stay", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { auto_review: true })
        // #2 is a draft: no automatic run, a manual one
        gh.open.mobile = [node(1), node(2, { isDraft: true })]
        await svc.scanRepo("mobile")
        const manual = await svc.requestReview("mobile", 2)
        expect(manual).toMatchObject({ kind: "new", manual: 1 })
        const approved = (n) =>
            node(n, {
                reviews: {
                    nodes: [
                        mine(
                            `a${n}`,
                            "APPROVED",
                            "2026-11-07T11:00:00Z",
                            `sha${n}`
                        ),
                    ],
                },
            })
        // reviewed by hand meanwhile (GitHub bumps updatedAt)
        const bumped = (n) => ({
            ...approved(n),
            updatedAt: "2026-11-07T11:00:00Z",
        })
        gh.open.mobile = [bumped(1), { ...bumped(2), isDraft: true }]
        await svc.scanRepo("mobile")
        const runs = [reviews.latestRun("mobile", 1), reviews.getRun(manual.id)]
        expect(runs[0]).toMatchObject({
            status: "cancelled",
            error: "no review needed any more",
        })
        expect(runs[1].status).toBe("queued")
    })
})

/** Service started, one tracked auto-review repo, PR #1 stored. */
async function started(over = {}, prs = [node(1)]) {
    const env = setup(over)
    env.gh.open.mobile = prs
    env.reviews.setRepo("mobile", { track: true })
    await env.svc.scanRepo("mobile")
    env.svc.start()
    return env
}

describe("agents", () => {
    test("launch: workspace, claude agent with the title, prompt", async () => {
        const { svc, herdr, reviews, fs } = await started()
        const run = await svc.requestReview("mobile", 1)
        await svc.idle()
        expect(fs.promises.mkdir).toHaveBeenCalledWith(DIR, {
            recursive: true,
        })
        expect(herdr.workspaceCreate).toHaveBeenCalledWith({
            cwd: DIR,
            label: "#1 Fix thing 1",
            env: {
                CC_URL: "http://127.0.0.1:1",
                CC_TOKEN: "t",
                REVIEW_ORCH_SKIP: "1",
                CC_REVIEW_ID: String(run.id),
            },
            focus: false,
        })
        expect(herdr.agentStart).toHaveBeenCalledWith({
            name: "pr-mobile-1",
            kind: "claude",
            paneId: "p1",
            args: [...MCP, "--name", "#1 Fix thing 1"],
            timeoutMs: 60000,
        })
        const [name, prompt, opts] = herdr.agentPrompt.mock.calls[0]
        expect(name).toBe("pr-mobile-1")
        expect(opts).toEqual({ wait: false })
        expect(prompt).toContain(path.join(DIR, `mobile-pr-1-r${run.id}`))
        expect(prompt).toContain(`review_id=${run.id}`)
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "running",
            agent_name: "pr-mobile-1",
            agent_kind: "claude",
            workspace_id: "w1",
            pane_id: "p1",
            head_sha: "sha1",
        })
        await svc.stop()
    })

    test("codex: no --name; a taken agent name gets a suffix; ~ dir", async () => {
        const { svc, herdr, settingsRepo } = await started({
            reviewsDir: "~/acme-reviews",
        })
        settingsRepo.values["reviews.agent_kind"] = "codex"
        herdr.agents.set("pr-mobile-1", "idle")
        await svc.requestReview("mobile", 1)
        await svc.idle()
        const start = herdr.agentStart.mock.calls[0][0]
        expect(start).toMatchObject({ name: "pr-mobile-1-2", kind: "codex" })
        // codex: no update notice at startup (it swallows the prompt)
        expect(start.args).toEqual([
            ...MCP,
            "-c",
            "check_for_update_on_startup=false",
            // sandboxed, but writes in the reviews folder and network on
            "--sandbox",
            "workspace-write",
            "-c",
            "sandbox_workspace_write.network_access=true",
        ])
        expect(herdr.workspaceCreate.mock.calls[0][0].cwd).toBe(
            path.join(os.homedir(), "acme-reviews")
        )
        await svc.stop()
    })

    test("no free agent name: the run fails", async () => {
        const { svc, herdr, reviews } = await started()
        herdr.agents.set("pr-mobile-1", "idle")
        for (let n = 2; n < 10; n++)
            herdr.agents.set(`pr-mobile-1-${n}`, "idle")
        const run = await svc.requestReview("mobile", 1)
        await svc.idle()
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "failed",
            error: "start failed: no free herdr agent name for pr-mobile-1",
        })
        expect(herdr.workspaceCreate).not.toHaveBeenCalled()
        await svc.stop()
    })

    test("parallel launches whose names collide get different names", async () => {
        const { svc, reviews, herdr } = setup()
        for (const repo of ["a.b", "a-b"]) {
            reviews.upsertPr({
                repo,
                number: 1,
                title: "x",
                author: "dev1",
                state: "OPEN",
                base: "main",
            })
            await svc.requestReview(repo, 1)
        }
        svc.start()
        await svc.pump()
        await svc.idle()
        const names = herdr.agentStart.mock.calls.map((c) => c[0].name).sort()
        expect(names).toEqual(["pr-a-b-1", "pr-a-b-1-2"])
        expect(reviews.runsByStatus(["failed"])).toHaveLength(0)
        await svc.stop()
    })

    test("launch failure: the run fails and the workspace closes", async () => {
        const { svc, herdr, reviews, fs } = await started()
        herdr.agentStart.mockRejectedValueOnce(new Error("boom"))
        const run = await svc.requestReview("mobile", 1)
        await svc.idle()
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "failed",
            error: "start failed: boom",
            workspace_id: null,
        })
        expect(herdr.workspaceClose).toHaveBeenCalledWith("w1")
        expect(fs.promises.rm).toHaveBeenCalledWith(
            path.join(DIR, `mobile-pr-1-r${run.id}`),
            { recursive: true, force: true }
        )
        await svc.stop()
    })

    test("cancelled while launching: what exists is closed, no prompt", async () => {
        const { svc, herdr, reviews } = await started()
        let release
        let started_
        const inStart = new Promise((r) => (started_ = r))
        herdr.agentStart.mockImplementationOnce(
            () =>
                new Promise((res) => {
                    release = res
                    started_()
                })
        )
        const run = await svc.requestReview("mobile", 1)
        await inStart
        const c = await svc.cancelRun(run.id)
        expect(c.status).toBe("cancelled")
        release()
        await svc.idle()
        expect(herdr.agentPrompt).not.toHaveBeenCalled()
        expect(herdr.workspaceClose).toHaveBeenCalledWith("w1")
        expect(reviews.getRun(run.id).status).toBe("cancelled")
        await svc.stop()
    })

    test("cancelled right after the workspace was created", async () => {
        const { svc, herdr, reviews } = await started()
        let release
        let created
        const inCreate = new Promise((r) => (created = r))
        herdr.workspaceCreate.mockImplementationOnce(
            () =>
                new Promise((res) => {
                    release = () => res({ workspaceId: "w9", paneId: "p9" })
                    created()
                })
        )
        const run = await svc.requestReview("mobile", 1)
        await inCreate
        await svc.cancelRun(run.id)
        release()
        await svc.idle()
        expect(herdr.agentStart).not.toHaveBeenCalled()
        expect(herdr.workspaceClose).toHaveBeenCalledWith("w9")
        expect(reviews.getRun(run.id).status).toBe("cancelled")
        await svc.stop()
    })

    test("pump respects reviews.parallel and starts the next when a slot frees", async () => {
        const { svc, herdr, reviews, settingsRepo } = await started({}, [
            node(1),
            node(2),
        ])
        settingsRepo.values["reviews.parallel"] = 1
        const a = await svc.requestReview("mobile", 1)
        const b = await svc.requestReview("mobile", 2)
        await svc.idle()
        expect(herdr.agentStart).toHaveBeenCalledTimes(1)
        expect(reviews.getRun(b.id).status).toBe("queued")
        await svc.cancelRun(a.id)
        await svc.idle()
        expect(herdr.agentStart).toHaveBeenCalledTimes(2)
        expect(reviews.getRun(b.id).status).toBe("running")
        expect(svc.settings()).toEqual({
            poll_minutes: 20,
            parallel: 1,
            agent_kind: "claude",
        })
        await svc.stop()
    })

    test("a queued run whose PR closed meanwhile is cancelled at start", async () => {
        const { svc, reviews, herdr } = setup()
        reviews.upsertPr({
            repo: "mobile",
            number: 9,
            state: "OPEN",
            title: "x",
        })
        const run = await svc.requestReview("mobile", 9)
        reviews.upsertPr({ repo: "mobile", number: 9, state: "CLOSED" })
        svc.start()
        await svc.idle()
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "cancelled",
            error: "PR is not open",
        })
        expect(herdr.workspaceCreate).not.toHaveBeenCalled()
        await svc.stop()
    })
})

/** A launched, running review of PR #1. */
async function launched(over) {
    const env = await started(over)
    const run = await env.svc.requestReview("mobile", 1)
    await env.svc.idle()
    return { ...env, run: env.reviews.getRun(run.id) }
}

const later = (ms) =>
    clock.set(new Date(clock.now().getTime() + ms).toISOString())

describe("review fixes", () => {
    test("auto-review off: queued automatic runs are cancelled, manual ones stay", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { auto_review: true })
        gh.open.mobile = [node(1), node(2)]
        await svc.scanRepo("mobile")
        const auto = reviews.latestRun("mobile", 1)
        reviews.updateRun(reviews.latestRun("mobile", 2).id, {
            status: "cancelled",
        })
        const manual = await svc.requestReview("mobile", 2)
        svc.setRepo("mobile", { auto_review: false })
        expect(reviews.getRun(auto.id)).toMatchObject({
            status: "cancelled",
            error: "auto-review switched off",
        })
        expect(reviews.getRun(manual.id).status).toBe("queued")
        await svc.stop()
    })

    test("an automatic run that no longer qualifies is dropped when it would start", async () => {
        const { svc, reviews, gh, herdr } = setup()
        reviews.setRepo("mobile", { auto_review: true })
        gh.open.mobile = [node(1)]
        await svc.scanRepo("mobile")
        const run = reviews.latestRun("mobile", 1)
        // switched off directly in the table (e.g. before a restart)
        reviews.setRepo("mobile", { auto_review: false })
        svc.start()
        await svc.pump()
        await svc.idle()
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "cancelled",
            error: "no review needed any more",
        })
        expect(herdr.workspaceCreate).not.toHaveBeenCalled()
        await svc.stop()
    })

    test("auto-review back on: PRs cancelled before they started are queued again", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { auto_review: true })
        gh.open.mobile = [node(1)]
        await svc.scanRepo("mobile")
        const first = reviews.latestRun("mobile", 1)
        svc.setRepo("mobile", { auto_review: false })
        expect(reviews.getRun(first.id).status).toBe("cancelled")
        svc.setRepo("mobile", { auto_review: true })
        await svc.scanRepo("mobile", { full: true })
        const again = reviews.latestRun("mobile", 1)
        expect(again.id).not.toBe(first.id)
        expect(again.status).toBe("queued")
        await svc.stop()
    })

    test("a failed start whose close herdr refused is cleaned up later; a no-report agent stays", async () => {
        const { svc, reviews, herdr, run } = await launched()
        reviews.updateRun(run.id, {
            status: "failed",
            error: "start failed: boom",
        })
        await svc.monitorTick()
        expect(reviews.getRun(run.id).workspace_id).toBeNull()
        const b = await launched()
        b.reviews.updateRun(b.run.id, { status: "failed", error: "no report" })
        await b.svc.monitorTick()
        expect(b.reviews.getRun(b.run.id).workspace_id).toBe(b.run.workspace_id)
        expect(herdr.workspaceClose).toHaveBeenCalledWith(run.workspace_id)
        await svc.stop()
        await b.svc.stop()
    })

    test("a failed start whose close failed is retried by the timer", async () => {
        const env = await started()
        env.herdr.agentStart.mockRejectedValueOnce(new Error("start boom"))
        env.herdr.workspaceClose.mockRejectedValueOnce(new Error("socket down"))
        const run = await env.svc.requestReview("mobile", 1)
        await env.svc.idle()
        expect(env.reviews.getRun(run.id)).toMatchObject({ status: "failed" })
        expect(env.reviews.getRun(run.id).workspace_id).toBeTruthy()
        await clock.advance(60000)
        await env.svc.idle()
        expect(env.reviews.getRun(run.id).workspace_id).toBeNull()
        await env.svc.stop()
    })

    test("a later batch failing still queues the PRs of the earlier ones", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { auto_review: true })
        gh.open.mobile = Array.from({ length: 11 }, (_, i) => node(i + 1))
        const base = gh.graphql.getMockImplementation()
        gh.graphql.mockImplementation(async (query, vars, opts) => {
            if (query.includes("p11: pullRequest")) throw new Error("502")
            return base(query, vars, opts)
        })
        const r = await svc.scanRepo("mobile")
        expect(r.error).toBe("502")
        expect(reviews.runsByStatus(["queued"])).toHaveLength(10)
        await svc.stop()
    })

    test("a queued automatic run follows the PR to its new head", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { auto_review: true })
        gh.open.mobile = [node(1)]
        await svc.scanRepo("mobile")
        const run = reviews.latestRun("mobile", 1)
        gh.open.mobile = [
            node(1, { headRefOid: "sha1b", updatedAt: "2026-11-07T10:00:00Z" }),
        ]
        await svc.scanRepo("mobile")
        expect(reviews.runsByStatus(["queued"])).toHaveLength(1)
        expect(reviews.getRun(run.id)).toMatchObject({
            kind: "new",
            trigger_key: "new:sha1b:",
            head_sha: "sha1b",
        })
        await svc.stop()
    })

    test("a claimed automatic run takes the stored PR's current trigger", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { auto_review: true })
        gh.open.mobile = [node(1)]
        await svc.scanRepo("mobile")
        const run = reviews.latestRun("mobile", 1)
        // head B stored by a scan batch, before the queue was reconciled
        reviews.upsertPr({
            ...reviews.getPr("mobile", 1),
            head_sha: "sha1b",
            trigger_key: "new:sha1b:",
        })
        svc.start()
        await svc.pump()
        await svc.idle()
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "running",
            head_sha: "sha1b",
            trigger_key: "new:sha1b:",
        })
        await svc.stop()
    })

    test("a head that moved while a run was running is queued after it finishes", async () => {
        const env = await started({}, [node(1)])
        env.reviews.setRepo("mobile", { auto_review: true })
        await env.svc.scanRepo("mobile")
        await env.svc.idle()
        const run = env.reviews.latestRun("mobile", 1)
        expect(run.status).toBe("running")
        // head B arrives while A is reviewed
        env.gh.open.mobile = [
            node(1, { headRefOid: "sha1b", updatedAt: "2026-11-07T10:00:00Z" }),
        ]
        await env.svc.scanRepo("mobile")
        expect(env.reviews.runsByStatus(["queued"])).toHaveLength(0)
        // A's run ends (skipped): the rescan has no new details, but the
        // stored state still needs a review
        env.svc.report({ review_id: run.id, verdict: "skipped" }, {})
        await env.svc.idle()
        env.herdr.agents.set(run.agent_name, "idle")
        await env.svc.monitorTick()
        await env.svc.idle()
        expect(env.reviews.getRun(run.id).status).toBe("done")
        const next = env.reviews.latestRun("mobile", 1)
        expect(next.id).not.toBe(run.id)
        expect(next).toMatchObject({ trigger_key: "new:sha1b:" })
        await env.svc.stop()
    })

    test("a run cancelled while its workspace is created is closed by the timer", async () => {
        const env = await started()
        let release
        env.herdr.workspaceCreate.mockImplementationOnce(
            () =>
                new Promise((res) => {
                    release = () => res({ workspaceId: "wX", paneId: "pX" })
                })
        )
        const run = await env.svc.requestReview("mobile", 1)
        await new Promise((r) => setImmediate(r))
        await env.svc.cancelRun(run.id)
        env.herdr.workspaceClose.mockRejectedValueOnce(new Error("socket down"))
        release()
        await env.svc.idle()
        expect(env.reviews.getRun(run.id)).toMatchObject({
            status: "cancelled",
            workspace_id: "wX",
        })
        await clock.advance(60000)
        await env.svc.idle()
        expect(env.reviews.getRun(run.id).workspace_id).toBeNull()
        expect(env.herdr.agentStart).not.toHaveBeenCalled()
        await env.svc.stop()
    })

    test("a new automatic run closes the agent a no-report run kept open", async () => {
        const env = await started({}, [node(1)])
        env.reviews.setRepo("mobile", { auto_review: true })
        await env.svc.scanRepo("mobile")
        await env.svc.idle()
        const run = env.reviews.latestRun("mobile", 1)
        env.reviews.updateRun(run.id, { status: "failed", error: "no report" })
        env.gh.open.mobile = [
            node(1, { headRefOid: "sha1b", updatedAt: "2026-11-07T10:00:00Z" }),
        ]
        await env.svc.scanRepo("mobile")
        await env.svc.idle()
        expect(env.reviews.getRun(run.id).error).toBe(
            "no report (replaced by a new run)"
        )
        await clock.advance(60000)
        await env.svc.idle()
        expect(env.herdr.workspaceClose).toHaveBeenCalledWith(run.workspace_id)
        expect(env.reviews.getRun(run.id).workspace_id).toBeNull()
        await env.svc.stop()
    })

    test("stop right after start launches nothing later", async () => {
        const { svc, reviews, herdr, gh } = setup()
        gh.open.mobile = [node(1)]
        reviews.setRepo("mobile", { track: true })
        await svc.scanRepo("mobile")
        await svc.requestReview("mobile", 1)
        svc.start()
        await svc.stop()
        await new Promise((r) => setImmediate(r))
        expect(herdr.workspaceCreate).not.toHaveBeenCalled()
        expect(reviews.runsByStatus(["queued"])).toHaveLength(1)
    })

    test("a run claimed before a restart, without an agent, fails and frees its slot", async () => {
        const { svc, reviews, gh } = setup()
        gh.open.mobile = [node(1)]
        reviews.setRepo("mobile", { track: true })
        await svc.scanRepo("mobile")
        const run = await svc.requestReview("mobile", 1)
        reviews.updateRun(run.id, { status: "running", started_at: "x" })
        svc.start()
        await svc.monitorTick()
        await svc.idle()
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "failed",
            error: "interrupted before its agent started",
        })
        await svc.stop()
    })

    test("a run cancelled on the dashboard is not queued again for the same state", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { auto_review: true })
        gh.open.mobile = [node(1)]
        await svc.scanRepo("mobile")
        const run = reviews.latestRun("mobile", 1)
        await svc.cancelRun(run.id)
        await svc.scanRepo("mobile", { full: true })
        expect(reviews.latestRun("mobile", 1).id).toBe(run.id)
        await svc.stop()
    })

    test("clean-up removes the checkout and its own siblings only", async () => {
        const { svc, herdr, fs, reviews, run } = await launched()
        const base = run.folder.split("/").pop()
        fs.promises.readdir = jest.fn(async () => [
            base,
            `${base}-artifacts`,
            `${base}0-other`,
            "AGENTS.md",
        ])
        svc.report({ review_id: run.id, verdict: "approved", issues: 0 }, {})
        await svc.idle()
        herdr.agents.set(run.agent_name, "idle")
        await svc.monitorTick()
        expect(reviews.getRun(run.id).status).toBe("done")
        const removed = fs.promises.rm.mock.calls.map((c) =>
            c[0].split("/").pop()
        )
        expect(removed).toEqual([base, `${base}-artifacts`])
        await svc.stop()
    })

    test("an agent that never worked gets the review prompt again, not the reminder", async () => {
        const { svc, herdr, run } = await launched()
        herdr.agents.set(run.agent_name, "idle")
        later(3 * 60000) // past the start grace
        await svc.monitorTick() // idle_since
        later(2 * 60000)
        const before = herdr.agentPrompt.mock.calls.length
        await svc.monitorTick()
        const sent = herdr.agentPrompt.mock.calls.slice(before).map((c) => c[1])
        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatch(/^Review PR acme\/mobile#1:/)
        expect(sent[0]).toContain(`review_id=${run.id}`)
        await svc.stop()
    })

    test("an agent name taken by another pane counts as our agent gone", async () => {
        const { svc, reviews, herdr, run } = await launched()
        const real = herdr.agentGet.getMockImplementation()
        herdr.agentGet.mockImplementation(async (name) =>
            name === run.agent_name
                ? { name, status: "idle", paneId: "someone-else" }
                : real(name)
        )
        await svc.monitorTick()
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "failed",
            error: "agent exited without a report",
        })
        expect(herdr.agentPrompt.mock.calls.map((c) => c[0])).toEqual([
            run.agent_name,
        ]) // only the launch prompt, no reminder to the other agent
        await svc.stop()
    })

    test("a late report of a replaced run is recorded, the run stays failed", async () => {
        const { svc, reviews, run } = await launched()
        reviews.updateRun(run.id, {
            status: "failed",
            error: "no report",
            workspace_id: null,
        })
        const next = await svc.requestReview("mobile", 1)
        const r = await svc.report(
            { review_id: run.id, verdict: "approved", issues: 0 },
            { callerReviewId: String(run.id) }
        )
        expect(r.note).toMatch(/newer review/)
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "failed",
            verdict: "approved",
        })
        expect(reviews.getRun(next.id).status).not.toBe("reported")
        await svc.stop()
    })

    test("closing an old workspace never clears a newer one stored meanwhile", async () => {
        const { svc, reviews, fs, run } = await launched()
        let done
        fs.promises.rm.mockImplementationOnce(
            () =>
                new Promise((r) => {
                    done = r
                })
        )
        const cancel = svc.cancelRun(run.id)
        await new Promise((r) => setImmediate(r))
        // a newer workspace lands while the checkout is being removed
        reviews.updateRun(run.id, { workspace_id: "w-new" })
        done()
        await cancel
        expect(reviews.getRun(run.id).workspace_id).toBe("w-new")
        await svc.stop()
    })

    test("a launch failing after its run was cancelled still closes its workspace", async () => {
        const env = await started()
        let created
        env.herdr.workspaceCreate.mockImplementationOnce(
            () =>
                new Promise((res) => {
                    created = () => res({ workspaceId: "wX", paneId: "pX" })
                })
        )
        let removed
        env.fs.promises.rm.mockImplementationOnce(
            () =>
                new Promise((r) => {
                    removed = r
                })
        )
        env.herdr.agentStart.mockRejectedValueOnce(new Error("start boom"))
        const run = await env.svc.requestReview("mobile", 1)
        await new Promise((r) => setImmediate(r))
        // cancelled before the workspace exists: nothing to close yet
        const cancel = env.svc.cancelRun(run.id)
        await new Promise((r) => setImmediate(r))
        // the launch stores its workspace, then its agent fails to start
        created()
        await new Promise((r) => setImmediate(r))
        removed()
        await cancel
        await env.svc.idle()
        expect(env.herdr.workspaceClose).toHaveBeenCalledWith("wX")
        expect(env.reviews.getRun(run.id)).toMatchObject({
            status: "cancelled",
            workspace_id: null,
        })
        await env.svc.stop()
    })

    test("a head back to a state whose review failed is not reviewed again", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("mobile", { auto_review: true })
        // head A queued, its review failed
        gh.open.mobile = [node(1)]
        await svc.scanRepo("mobile")
        const a = reviews.latestRun("mobile", 1)
        reviews.updateRun(a.id, { status: "failed", error: "boom" })
        // head B: a new run queued (slots busy, it waits)
        gh.open.mobile = [
            node(1, { headRefOid: "sha1b", updatedAt: "2026-11-07T10:00:00Z" }),
        ]
        await svc.scanRepo("mobile")
        const b = reviews.latestRun("mobile", 1)
        expect(b).toMatchObject({ status: "queued", trigger_key: "new:sha1b:" })
        // force-pushed back to A while B waited: no second run for A
        gh.open.mobile = [node(1, { updatedAt: "2026-11-08T10:00:00Z" })]
        await svc.scanRepo("mobile")
        expect(reviews.getRun(b.id)).toMatchObject({
            status: "cancelled",
            error: "this state was reviewed before",
        })
        expect(reviews.runsByStatus(["queued"])).toHaveLength(0)
        // and a run claimed for a state reviewed before is dropped too
        const c = reviews.createRun({
            repo: "mobile",
            number: 1,
            kind: "new",
            trigger_key: "new:old:",
        })
        svc.start()
        await svc.pump()
        await svc.idle()
        expect(reviews.getRun(c.id)).toMatchObject({
            status: "cancelled",
            error: "this state was reviewed before",
        })
        await svc.stop()
    })

    test("a workspace created while the cancel cleans up: no agent starts", async () => {
        const env = await started()
        let created
        env.herdr.workspaceCreate.mockImplementationOnce(
            () =>
                new Promise((res) => {
                    created = () => res({ workspaceId: "wY", paneId: "pY" })
                })
        )
        let removed
        env.fs.promises.rm.mockImplementationOnce(
            () =>
                new Promise((r) => {
                    removed = r
                })
        )
        const run = await env.svc.requestReview("mobile", 1)
        await new Promise((r) => setImmediate(r))
        const cancel = env.svc.cancelRun(run.id)
        await new Promise((r) => setImmediate(r))
        // the workspace lands while the cancel removes the checkout
        created()
        await new Promise((r) => setImmediate(r))
        await new Promise((r) => setImmediate(r))
        expect(env.herdr.agentStart).not.toHaveBeenCalled()
        removed()
        await cancel
        await env.svc.idle()
        expect(env.herdr.agentStart).not.toHaveBeenCalled()
        expect(env.herdr.agentPrompt).not.toHaveBeenCalled()
        expect(env.herdr.workspaceClose).toHaveBeenCalledWith("wY")
        expect(env.reviews.getRun(run.id)).toMatchObject({
            status: "cancelled",
            workspace_id: null,
        })
        await env.svc.stop()
    })

    test("a prompt send that errors keeps the review running for the monitor", async () => {
        const env = await started()
        env.herdr.agentPrompt.mockRejectedValueOnce(new Error("socket timeout"))
        const run = await env.svc.requestReview("mobile", 1)
        await env.svc.idle()
        const now = env.reviews.getRun(run.id)
        expect(now).toMatchObject({ status: "running" })
        expect(now.workspace_id).toBeTruthy()
        expect(env.herdr.workspaceClose).not.toHaveBeenCalled()
        expect(env.fs.promises.rm).not.toHaveBeenCalled()
        expect(env.log.warn).toHaveBeenCalledWith(
            { err: "socket timeout", run: run.id },
            "review prompt"
        )
        await env.svc.stop()
    })

    test("a retry closes the agent a failed run left open", async () => {
        const { svc, reviews, herdr, run } = await launched()
        reviews.updateRun(run.id, { status: "failed", error: "no report" })
        herdr.workspaceClose.mockRejectedValueOnce(new Error("socket down"))
        await expect(svc.requestReview("mobile", 1)).rejects.toMatchObject({
            code: "close_failed",
        })
        const next = await svc.requestReview("mobile", 1)
        expect(next.id).not.toBe(run.id)
        expect(herdr.workspaceClose).toHaveBeenCalledWith(run.workspace_id)
        expect(reviews.getRun(run.id).workspace_id).toBeNull()
        await svc.stop()
    })
})

describe("monitor", () => {
    test("reported and idle: workspace closed, folder removed, done, rescan", async () => {
        const { svc, herdr, reviews, fs, gh, run } = await launched()
        herdr.agents.set(run.agent_name, "working")
        await svc.monitorTick()
        expect(reviews.getRun(run.id).seen_working).toBe(true)
        const r = await svc.report(
            {
                review_id: run.id,
                verdict: "changes_requested",
                issues: 2,
                summary: "two issues",
            },
            { callerReviewId: String(run.id) }
        )
        expect(r).toMatchObject({ ok: true, run_id: run.id })
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "reported",
            verdict: "changes_requested",
            issues: 2,
            summary: "two issues",
        })
        // still working: nothing yet
        await svc.monitorTick()
        expect(herdr.workspaceClose).not.toHaveBeenCalled()
        herdr.agents.set(run.agent_name, "idle")
        const scans = openQueries(gh).length
        await svc.monitorTick()
        await svc.idle()
        expect(herdr.workspaceClose).toHaveBeenCalledWith("w1")
        expect(fs.promises.rm).toHaveBeenCalledWith(run.folder, {
            recursive: true,
            force: true,
        })
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "done",
            workspace_id: null,
        })
        expect(openQueries(gh).length).toBe(scans + 1)
        await svc.stop()
    })

    test("idle without a report: grace, nudge, then failed with the agent left open", async () => {
        const { svc, herdr, reviews, run } = await launched()
        herdr.agents.set(run.agent_name, "idle")
        // just started, never seen working: still taking the prompt
        await svc.monitorTick()
        expect(reviews.getRun(run.id).idle_since).toBeNull()
        later(121000)
        await svc.monitorTick()
        expect(reviews.getRun(run.id).idle_since).toBeTruthy()
        later(30000)
        await svc.monitorTick()
        expect(herdr.agentPrompt).toHaveBeenCalledTimes(1)
        later(31000)
        await svc.monitorTick()
        expect(herdr.agentPrompt).toHaveBeenCalledTimes(2)
        expect(herdr.agentPrompt.mock.calls[1][1]).toContain(
            `review_id=${run.id}`
        )
        expect(reviews.getRun(run.id)).toMatchObject({
            idle_since: null,
        })
        expect(reviews.getRun(run.id).nudged_at).toBeTruthy()
        // works again, then idle
        herdr.agents.set(run.agent_name, "working")
        await svc.monitorTick()
        herdr.agents.set(run.agent_name, "idle")
        await svc.monitorTick()
        later(100000)
        await svc.monitorTick()
        expect(reviews.getRun(run.id).status).toBe("running")
        later(81000)
        await svc.monitorTick()
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "failed",
            error: "no report",
            workspace_id: "w1",
        })
        expect(herdr.workspaceClose).not.toHaveBeenCalled()
        // a late report is still taken; the agent then closes
        await svc.report({ review_id: run.id, verdict: "approved" })
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "reported",
            error: null,
            finished_at: null,
            issues: null,
            summary: null,
        })
        await svc.monitorTick()
        expect(reviews.getRun(run.id).status).toBe("done")
        expect(herdr.workspaceClose).toHaveBeenCalledWith("w1")
        await svc.stop()
    })

    test("a failed nudge is logged; blocked counts as busy; other states wait", async () => {
        const { svc, herdr, reviews, log, run } = await launched()
        herdr.agents.set(run.agent_name, "blocked")
        await svc.monitorTick()
        expect(reviews.getRun(run.id).seen_working).toBe(false)
        herdr.agents.set(run.agent_name, "unknown")
        later(200000)
        await svc.monitorTick()
        expect(reviews.getRun(run.id).idle_since).toBeNull()
        herdr.agents.set(run.agent_name, "done")
        await svc.monitorTick()
        later(61000)
        herdr.agentPrompt.mockRejectedValueOnce(new Error("socket"))
        await svc.monitorTick()
        expect(log.warn).toHaveBeenCalledWith({ err: "socket" }, "review nudge")
        // not delivered: not counted, the next tick sends it again
        expect(reviews.getRun(run.id).nudged_at).toBeNull()
        const before = herdr.agentPrompt.mock.calls.length
        await svc.monitorTick()
        expect(herdr.agentPrompt.mock.calls.length).toBe(before + 1)
        expect(reviews.getRun(run.id).nudged_at).toBeTruthy()
        expect(reviews.getRun(run.id).status).toBe("running")
        await svc.stop()
    })

    test("agent vanished: failed without a report, done with one", async () => {
        const { svc, herdr, reviews, fs, run } = await launched()
        herdr.agents.delete(run.agent_name)
        await svc.monitorTick()
        await svc.idle()
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "failed",
            error: "agent exited without a report",
            workspace_id: null,
        })
        expect(fs.promises.rm).toHaveBeenCalledWith(run.folder, {
            recursive: true,
            force: true,
        })
        await svc.report({ review_id: run.id, verdict: "skipped" })
        await svc.monitorTick()
        await svc.idle()
        expect(reviews.getRun(run.id).status).toBe("done")
        await svc.stop()
    })

    test("herdr unreachable: no change", async () => {
        const { svc, herdr, reviews, run } = await launched()
        herdr.agentGet.mockRejectedValueOnce(new Error("down"))
        await svc.monitorTick()
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "running",
            seen_working: false,
        })
        await svc.stop()
    })

    test("the monitor timer runs while agents are live", async () => {
        const { svc, herdr, reviews, run } = await launched({
            monitorMs: 1000,
        })
        herdr.agents.set(run.agent_name, "working")
        await clock.advance(1000)
        expect(reviews.getRun(run.id).seen_working).toBe(true)
        await svc.stop()
        expect(clock.pending()).toBe(0)
    })

    test("folders outside the reviews dir are never removed; rm errors are logged", async () => {
        const { svc, reviews, fs, run } = await launched()
        reviews.updateRun(run.id, { folder: "/etc/acme" })
        await svc.cancelRun(run.id)
        expect(fs.promises.rm).not.toHaveBeenCalled()
        const b = await launched()
        b.fs.promises.rm.mockRejectedValueOnce(new Error("busy"))
        // herdr no longer knows the workspace: closed
        b.herdr.workspaceClose.mockRejectedValueOnce(
            new Error("workspace not found")
        )
        await b.svc.cancelRun(b.run.id)
        expect(b.log.warn).toHaveBeenCalledWith(
            { err: "busy", folder: b.run.folder },
            "review folder removal"
        )
        expect(b.reviews.getRun(b.run.id).workspace_id).toBeNull()
        await svc.stop()
        await b.svc.stop()
    })

    test("a close herdr refuses keeps the workspace and checkout; retried", async () => {
        const { svc, reviews, herdr, fs, run, log } = await launched()
        herdr.workspaceClose.mockRejectedValueOnce(new Error("socket down"))
        await expect(svc.cancelRun(run.id)).rejects.toMatchObject({
            code: "close_failed",
        })
        expect(log.warn).toHaveBeenCalledWith(
            { err: "socket down" },
            "review workspace close"
        )
        expect(fs.promises.rm).not.toHaveBeenCalled()
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "running",
            workspace_id: run.workspace_id,
        })
        // reported, idle, close refused: stays reported until it works
        svc.report({ review_id: run.id, verdict: "approved", issues: 0 }, {})
        await svc.idle()
        herdr.agents.set(run.agent_name, "idle")
        herdr.workspaceClose.mockRejectedValueOnce(new Error("socket down"))
        await svc.monitorTick()
        expect(reviews.getRun(run.id).status).toBe("reported")
        await svc.monitorTick()
        expect(reviews.getRun(run.id)).toMatchObject({
            status: "done",
            workspace_id: null,
        })
        expect(fs.promises.rm).toHaveBeenCalled()
        await svc.stop()
    })

    test("a finished run whose close failed is closed by the monitor", async () => {
        const { svc, reviews, herdr, run } = await launched()
        reviews.updateRun(run.id, { status: "done", finished_at: "x" })
        herdr.workspaceClose.mockRejectedValueOnce(new Error("socket down"))
        await svc.monitorTick()
        expect(reviews.getRun(run.id).workspace_id).toBe(run.workspace_id)
        await svc.monitorTick()
        expect(reviews.getRun(run.id).workspace_id).toBeNull()
        await svc.stop()
    })
})

describe("report", () => {
    test("caller checks and bad input", async () => {
        const { svc, reviews, run } = await launched()
        expect(() =>
            svc.report(
                { review_id: run.id, verdict: "approved" },
                { callerTaskId: "3" }
            )
        ).toThrow(
            expect.objectContaining({ code: "wrong_caller", status: 403 })
        )
        expect(() =>
            svc.report(
                { review_id: run.id, verdict: "approved" },
                { callerReviewId: "999" }
            )
        ).toThrow(
            expect.objectContaining({ code: "wrong_review", status: 403 })
        )
        expect(() =>
            svc.report({ review_id: run.id, verdict: "maybe" })
        ).toThrow(expect.objectContaining({ code: "validation" }))
        await expect(
            svc.report({ review_id: 999, verdict: "approved" })
        ).rejects.toMatchObject({ code: "not_found" })
        await svc.cancelRun(run.id)
        await expect(
            svc.report({ review_id: run.id, verdict: "approved" })
        ).rejects.toMatchObject({ code: "run_not_active", status: 409 })
        expect(reviews.getRun(run.id).status).toBe("cancelled")
        await svc.stop()
    })
})

describe("dashboard operations", () => {
    test("requestReview: unknown, not open, active run, re-review kind", async () => {
        const { svc, reviews, gh } = setup()
        gh.open.mobile = [
            node(1),
            node(4, {
                reviews: {
                    nodes: [
                        mine("r4", "APPROVED", "2026-11-03T10:00:00Z", "sha4"),
                    ],
                },
            }),
        ]
        await svc.scanRepo("mobile")
        await expect(svc.requestReview("mobile", 99)).rejects.toMatchObject({
            code: "not_found",
        })
        reviews.upsertPr({ repo: "mobile", number: 3, state: "MERGED" })
        await expect(svc.requestReview("mobile", 3)).rejects.toMatchObject({
            code: "pr_not_open",
            status: 409,
        })
        const a = await svc.requestReview("mobile", 1)
        expect((await svc.requestReview("mobile", 1)).id).toBe(a.id)
        const b = await svc.requestReview("mobile", 4)
        expect(b).toMatchObject({ kind: "re_review", manual: 1 })
    })

    test("cancelRun: queued, a failed run's open agent, unknown", async () => {
        const { svc, herdr, reviews, run } = await launched()
        const q = reviews.createRun({ repo: "mobile", number: 1, kind: "new" })
        expect((await svc.cancelRun(q.id)).status).toBe("cancelled")
        reviews.updateRun(run.id, { status: "failed", error: "no report" })
        const c = await svc.cancelRun(run.id)
        expect(c).toMatchObject({ status: "failed", workspace_id: null })
        expect(herdr.workspaceClose).toHaveBeenCalledWith("w1")
        // nothing left to close
        expect((await svc.cancelRun(run.id)).status).toBe("failed")
        expect(herdr.workspaceClose).toHaveBeenCalledTimes(1)
        await expect(svc.cancelRun(999)).rejects.toMatchObject({
            code: "not_found",
        })
        await svc.stop()
    })

    test("focusRun", async () => {
        const { svc, herdr, reviews, run } = await launched()
        expect(await svc.focusRun(run.id)).toEqual({ ok: true })
        expect(herdr.agentFocus).toHaveBeenCalledWith("pr-mobile-1")
        const q = reviews.createRun({ repo: "mobile", number: 1, kind: "new" })
        await expect(svc.focusRun(q.id)).rejects.toMatchObject({
            code: "not_found",
        })
        await expect(svc.focusRun(999)).rejects.toMatchObject({
            code: "not_found",
        })
        await svc.stop()
    })

    test("listRepos merges the repo table, tracked rows and open counts", async () => {
        const { svc, reviews, gh } = setup()
        reviews.setRepo("extra", { track: true })
        reviews.setRepo("mobile", { auto_review: true })
        gh.open.mobile = [node(1), node(2)]
        await svc.scanRepo("mobile")
        reviews.upsertPr({ repo: "mobile", number: 3, state: "CLOSED" })
        expect(svc.listRepos()).toEqual([
            {
                name: "extra",
                description: null,
                track: true,
                auto_review: false,
                last_scan_at: null,
                open: 0,
                error: null,
            },
            expect.objectContaining({
                name: "mobile",
                description: "the app",
                track: true,
                auto_review: true,
                open: 2,
            }),
            expect.objectContaining({ name: "web", track: false, open: 0 }),
        ])
        // no repo table: the tracked rows only
        const bare = setup({ repoTable: null })
        expect(
            bare.svc.listRepos().map((r) => [r.name, r.description])
        ).toEqual([
            ["extra", null],
            ["mobile", null],
        ])
    })

    test("setRepo: unknown repo, scan when newly tracked while started", async () => {
        const { svc, gh, bus } = setup()
        expect(() => svc.setRepo("nope", { track: true })).toThrow(
            expect.objectContaining({ code: "not_found" })
        )
        // not started: no scan
        expect(svc.setRepo("web", { track: true })).toMatchObject({
            name: "web",
            track: true,
        })
        await svc.idle()
        expect(openQueries(gh)).toHaveLength(0)
        svc.start()
        svc.setRepo("mobile", { track: true })
        await svc.idle()
        expect(openQueries(gh).map((c) => c[1].name)).toEqual(["mobile"])
        // auto-review switched on: scan again
        svc.setRepo("mobile", { auto_review: true })
        await svc.idle()
        expect(openQueries(gh)).toHaveLength(2)
        // unchanged: no scan
        svc.setRepo("mobile", { auto_review: true })
        await svc.idle()
        expect(openQueries(gh)).toHaveLength(2)
        expect(emitted(bus)).toBeGreaterThan(0)
        await svc.stop()
    })
})

describe("lifecycle and scheduling", () => {
    test("repos are scanned round robin, spread over the poll period", async () => {
        const { svc, reviews, gh, settingsRepo } = setup({
            startDelayMs: 1000,
        })
        settingsRepo.values["reviews.poll_minutes"] = 20
        reviews.setRepo("mobile", { track: true })
        reviews.setRepo("web", { track: true })
        svc.start()
        svc.start() // idempotent
        await clock.advance(1000)
        expect(openQueries(gh).map((c) => c[1].name)).toEqual(["mobile"])
        await clock.advance(10 * 60000 - 1)
        expect(openQueries(gh)).toHaveLength(1)
        await clock.advance(1)
        expect(openQueries(gh).map((c) => c[1].name)).toEqual(["mobile", "web"])
        await clock.advance(10 * 60000)
        expect(openQueries(gh).at(-1)[1].name).toBe("mobile")
        await svc.stop()
        expect(clock.pending()).toBe(0)
    })

    test("nothing tracked: the timer waits a whole period", async () => {
        const { svc, gh } = setup({ startDelayMs: 0 })
        svc.start()
        await clock.advance(0)
        expect(gh.graphql).not.toHaveBeenCalled()
        expect(clock.pending()).toBe(1)
        await svc.stop()
    })

    test("settings fall back on errors and missing values; login from config", async () => {
        const { svc, gh } = setup({
            settingsRepo: {
                get: () => {
                    throw new Error("db")
                },
            },
            login: ME,
        })
        expect(svc.settings()).toEqual({
            poll_minutes: 20,
            parallel: 4,
            agent_kind: "claude",
        })
        expect(svc.whoami()).toBe(ME)
        gh.open.mobile = []
        await svc.scanRepo("mobile")
        expect(gh.login).not.toHaveBeenCalled()
        const nulls = setup({ settingsRepo: { get: () => null } })
        expect(nulls.svc.settings().parallel).toBe(4)
        const none = setup({ settingsRepo: null, bus: null })
        expect(none.svc.settings().agent_kind).toBe("claude")
        await none.svc.scanRepo("mobile")
    })

    test("start picks up queued runs; pump does nothing while stopped", async () => {
        const { svc, reviews, herdr } = setup()
        reviews.upsertPr({
            repo: "mobile",
            number: 1,
            state: "OPEN",
            title: "a",
        })
        await svc.requestReview("mobile", 1)
        await svc.pump()
        expect(herdr.workspaceCreate).not.toHaveBeenCalled()
        svc.start()
        await svc.idle()
        expect(herdr.workspaceCreate).toHaveBeenCalledTimes(1)
        await svc.stop()
    })
})
