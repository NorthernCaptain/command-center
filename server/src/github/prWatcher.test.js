/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createBus } from "../events/bus.js"
import { openDb } from "../store/db.js"
import { createSettingsRepo } from "../store/settingsRepo.js"
import { createStore } from "../store/store.js"
import { createFakeClock } from "../util/clock.js"
import { createOutboxRepo } from "../herdr/outboxRepo.js"
import { openDeliverables } from "../contracts/lifecycle.js"
import { createClaims } from "./claims.js"
import {
    checkSlug,
    ciItemId,
    ciStateOf,
    classify,
    createPrWatcher,
    extractItems,
    isBot,
    isWatched,
    isTrivialBody,
    verifyItem,
} from "./prWatcher.js"

const ORG = "acme"
const REPO = "aws-lambda"
const REPO2 = "infrastructure"
const PR_URL = `https://github.com/${ORG}/${REPO}/pull/812`
const PR2_URL = `https://github.com/${ORG}/${REPO2}/pull/44`
const HEAD = "abcdef1234567"
/** CI feedback item id on the default PR / head (see ciItemId). */
const ciId = (name, head = HEAD, pr = PR_URL) => ciItemId(name, head, pr)

const deliv = (repo, over = {}) => ({
    repo,
    branch: "t1-fix",
    role: "work",
    created_at: "2026-11-07T10:00:00.000Z",
    disposition: "pending",
    ...over,
})

function listPr(over = {}) {
    return {
        number: 812,
        url: PR_URL,
        headRefName: "t1-fix",
        headRepository: { name: REPO, owner: ORG },
        isCrossRepository: false,
        createdAt: "2026-11-07T11:00:00Z",
        body: "Summary\n\nCommand-Center-Task: T-1",
        state: "OPEN",
        mergedAt: null,
        closedAt: null,
        headRefOid: HEAD,
        author: { login: "leo" },
        ...over,
    }
}

function fullPr(over = {}) {
    return {
        ...listPr(),
        reviewDecision: null,
        statusCheckRollup: [],
        reviews: [],
        comments: [],
        commits: [],
        ...over,
    }
}

const rc = (id, over = {}) => ({
    id,
    user: { login: "ron", type: "User" },
    body: `comment ${id}`,
    path: "src/upload.js",
    line: 42,
    original_line: 42,
    created_at: "2026-11-07T11:30:00Z",
    html_url: `${PR_URL}#discussion_r${id}`,
    in_reply_to_id: null,
    commit_id: HEAD,
    ...over,
})

let tmp
let db
let bus
let clock
let store
let busEvents

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-prw-"))
    db = openDb(":memory:")
    clock = createFakeClock()
    bus = createBus({ clock })
    busEvents = []
    bus.subscribe((e) => busEvents.push(e))
    store = createStore({ tasksDir: path.join(tmp, "tasks"), db, bus, clock })
})

afterEach(() => {
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
})

async function setup({
    deliverables = [deliv(REPO)],
    status = "ready_for_pr",
    asana = true,
    opts = {},
} = {}) {
    const gh = {
        lists: {},
        prs: {},
        rcs: {},
        listError: null,
        listPrsByHead: jest.fn(async (repo) => {
            if (gh.listError) throw gh.listError
            return gh.lists[repo] || []
        }),
        getPr: jest.fn(async (repo, n) => {
            const p = gh.prs[`${repo}#${n}`]
            if (!p) throw new Error(`no pr ${repo}#${n}`)
            return typeof p === "function" ? p() : p
        }),
        reviewComments: jest.fn(
            async (repo, n) => gh.rcs[`${repo}#${n}`] || []
        ),
    }
    const { task } = await store.createTask(
        {
            title: "Fix upload retry",
            kind: "agent_task",
            status,
            branch: "t1-fix",
            slug: "k7q2",
            deliverables,
            asana: asana ? { gid: "99" } : undefined,
        },
        "me"
    )
    const claims = createClaims(db, { clock })
    const deps = {
        workerService: { deliver: jest.fn(async () => ({ status: "sent" })) },
        jobRunner: {
            enqueue: jest.fn((type) => ({ id: "j1", type })),
            list: jest.fn(() => []),
        },
        asanaService: { comment: jest.fn(async () => ({})) },
        notifier: { notify: jest.fn(async () => true) },
        settingsRepo: createSettingsRepo(db),
        feedbackPrompt: jest.fn(
            ({ pr, round, items, branch }) =>
                `feedback ${pr} r${round} ${branch} ${items
                    .map((i) => i.id)
                    .join(",")}`
        ),
    }
    const watcher = createPrWatcher({
        store,
        gh,
        claims,
        db,
        bus,
        clock,
        org: ORG,
        ...deps,
        ...opts,
    })
    return { task, gh, claims, watcher, ...deps }
}

const getTask = async (id = 1) => (await store.getTask(id)).task
const feedback = async (id = 1) =>
    Object.fromEntries((await store.listFeedback(id)).map((i) => [i.id, i]))
const eventsOf = async (type, id = 1) =>
    (await store.listEvents(id, { limit: 1000 })).filter((e) => e.type === type)

async function resolve(id, patch) {
    const items = await feedback()
    // eslint-disable-next-line no-unused-vars
    const { at, ...rest } = items[id]
    await store.appendFeedback(1, { ...rest, ...patch }, "agent:t1-fix")
}

// ---------------------------------------------------------------------------

describe("pure helpers", () => {
    test("an actionable reviewer bot raises work, but not with its thread replies", () => {
        const ctx = { prAuthor: "leok", actionableBots: ["review-bot"] }
        const bot = { author: "review-bot[bot]", authorType: "Bot" }
        expect(
            classify(
                { kind: "review_comment", ...bot, body: "Null check missing" },
                ctx
            )
        ).toBe(true)
        expect(
            classify(
                {
                    kind: "review_comment",
                    ...bot,
                    body: "Thanks, looks fixed now",
                    inReplyTo: 123,
                },
                ctx
            )
        ).toBe(false)
        // without the allow-list the same bot comment is noise
        expect(
            classify({ kind: "review_comment", ...bot, body: "x y z" }, {})
        ).toBe(false)
        // people's thread replies still count
        expect(
            classify(
                {
                    kind: "review_comment",
                    author: "ron",
                    body: "Still wrong",
                    inReplyTo: 123,
                },
                ctx
            )
        ).toBe(true)
    })

    test("ciItemId stays short for very long check names", () => {
        const long = "integration tests / " + "shard ".repeat(40)
        const id = ciItemId(long, HEAD, PR_URL)
        expect(id.length).toBeLessThanOrEqual(64)
        expect(id).toMatch(/^ci-[a-z0-9-]{1,40}-[0-9a-f]{10}-abcdef1$/)
        expect(ciItemId(long + "x", HEAD, PR_URL)).not.toBe(id)
    })

    test("checkSlug / ciItemId", () => {
        expect(checkSlug("Analyze (actions)")).toBe("analyze-actions")
        expect(checkSlug("!!!")).toBe("check")
        expect(ciItemId("unit tests", HEAD, PR_URL)).toMatch(
            /^ci-unit-tests-[0-9a-f]{10}-abcdef1$/
        )
        expect(ciItemId("u", null)).toMatch(/^ci-u-[0-9a-f]{10}-nohead$/)
        // names with the same slug (or a long shared prefix) stay distinct
        expect(ciItemId("test (linux)", HEAD, PR_URL)).not.toBe(
            ciItemId("test-linux", HEAD, PR_URL)
        )
        const long = "x".repeat(70)
        expect(ciItemId(long + "a", HEAD, PR_URL)).not.toBe(
            ciItemId(long + "b", HEAD, PR_URL)
        )
        // scoped to the PR and the head commit
        expect(ciItemId("u", HEAD, PR_URL)).not.toBe(ciItemId("u", HEAD, "x"))
        expect(ciItemId("u", HEAD, PR_URL)).not.toBe(
            ciItemId("u", "0000000ff", PR_URL)
        )
        expect(ciItemId("u", HEAD, PR_URL)).toBe(ciItemId("u", HEAD, PR_URL))
    })

    test("isBot", () => {
        expect(isBot("review-bot[bot]", "Bot")).toBe(true)
        expect(isBot("x", "Bot")).toBe(true)
        expect(isBot("dependabot", "User")).toBe(true)
        expect(isBot("ron", "User")).toBe(false)
        expect(isBot("review-bot[bot]", "Bot", ["review-bot"])).toBe(false)
        expect(isBot(null)).toBe(false)
    })

    test("isTrivialBody", () => {
        expect(isTrivialBody("LGTM!")).toBe(true)
        expect(isTrivialBody(" :+1: ")).toBe(true)
        expect(isTrivialBody("👍")).toBe(true)
        expect(isTrivialBody("Thanks.")).toBe(true)
        expect(isTrivialBody("lgtm but rename x")).toBe(false)
        expect(isTrivialBody(null)).toBe(false)
    })

    test("classify", () => {
        const ctx = { prAuthor: "leo" }
        expect(classify({ kind: "ci_failure" }, ctx)).toBe(true)
        expect(
            classify({ kind: "issue_comment", author: "a[bot]", body: "x" })
        ).toBe(false)
        expect(
            classify(
                { kind: "issue_comment", author: "leo", body: "Re: link" },
                ctx
            )
        ).toBe(false)
        expect(
            classify(
                {
                    kind: "review_comment",
                    author: "LEO",
                    body: "done",
                    inReplyTo: 5,
                },
                ctx
            )
        ).toBe(false)
        expect(
            classify(
                { kind: "issue_comment", author: "leo", body: "also fix y" },
                ctx
            )
        ).toBe(true)
        expect(
            classify({
                kind: "review",
                author: "ron",
                body: "",
                reviewState: "APPROVED",
            })
        ).toBe(false)
        expect(
            classify({
                kind: "review",
                author: "ron",
                body: "LGTM",
                reviewState: "APPROVED",
            })
        ).toBe(false)
        expect(
            classify({
                kind: "review",
                author: "ron",
                body: "",
                reviewState: "CHANGES_REQUESTED",
            })
        ).toBe(true)
        expect(
            classify({
                kind: "review_comment",
                author: "ron",
                body: "reply",
                inReplyTo: 5,
            })
        ).toBe(true)
    })

    test("ciStateOf", () => {
        expect(ciStateOf()).toBeNull()
        expect(
            ciStateOf([
                { status: "COMPLETED", conclusion: "SUCCESS" },
                { status: "COMPLETED", conclusion: "FAILURE" },
            ])
        ).toBe("failure")
        expect(
            ciStateOf([
                { status: "COMPLETED", conclusion: "SUCCESS" },
                { status: "IN_PROGRESS", conclusion: null },
            ])
        ).toBe("pending")
        expect(
            ciStateOf([{ status: "COMPLETED", conclusion: "SKIPPED" }])
        ).toBe("success")
        // finished without passing: never "success"
        for (const conclusion of [
            "CANCELLED",
            "ACTION_REQUIRED",
            "STALE",
            null,
        ])
            expect(
                ciStateOf([
                    { status: "COMPLETED", conclusion: "SUCCESS" },
                    { status: "COMPLETED", conclusion },
                ])
            ).toBe("incomplete")
        // a failure still wins over a cancelled check
        expect(
            ciStateOf([
                { status: "COMPLETED", conclusion: "CANCELLED" },
                { status: "COMPLETED", conclusion: "FAILURE" },
            ])
        ).toBe("failure")
    })

    test("failing checks with colliding slugs stay separate items", () => {
        const items = extractItems({
            pr: {
                author: { login: "leok" },
                headRefOid: HEAD,
                statusCheckRollup: [
                    {
                        name: "test (linux)",
                        status: "COMPLETED",
                        conclusion: "FAILURE",
                    },
                    {
                        name: "test-linux",
                        status: "COMPLETED",
                        conclusion: "FAILURE",
                    },
                ],
            },
            prUrl: PR_URL,
        })
        const ci = items.filter((i) => i.kind === "ci_failure")
        expect(ci).toHaveLength(2)
        expect(new Set(ci.map((i) => i.id)).size).toBe(2)
        expect(ci.map((i) => i.summary).sort()).toEqual([
            "test (linux)",
            "test-linux",
        ])
    })

    test("extractItems builds ids, kinds and classification", () => {
        const pr = fullPr({
            reviews: [
                {
                    id: 1,
                    author: { login: "ron" },
                    state: "COMMENTED",
                    body: "",
                },
                {
                    id: 2,
                    author: { login: "ron" },
                    state: "CHANGES_REQUESTED",
                    body: "",
                    url: "rv2",
                },
                {
                    id: 3,
                    author: { login: "ann" },
                    state: "APPROVED",
                    body: "",
                },
                {
                    id: 4,
                    author: { login: "ann" },
                    state: "COMMENTED",
                    body: "\n  Please split this\nmore",
                },
            ],
            comments: [
                { id: 7, author: { login: "ann" }, body: "LGTM", url: "ic7" },
                { id: 8, author: { login: "x", type: "Bot" }, body: "deploy" },
            ],
            statusCheckRollup: [
                { name: "unit", status: "COMPLETED", conclusion: "FAILURE" },
                { name: "unit", status: "COMPLETED", conclusion: "FAILURE" },
                { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
                { name: "e2e", status: "IN_PROGRESS", conclusion: null },
                {
                    name: "build",
                    status: "COMPLETED",
                    conclusion: "TIMED_OUT",
                    detailsUrl: "run9",
                },
            ],
        })
        const items = extractItems({
            pr,
            reviewComments: [
                rc(10),
                rc(11, { line: null, original_line: 7, html_url: null }),
                rc(12, { line: null, original_line: null, user: null }),
            ],
            prUrl: PR_URL,
        })
        const by = Object.fromEntries(items.map((i) => [i.id, i]))
        expect(Object.keys(by)).toEqual([
            "gh-rc-10",
            "gh-rc-11",
            "gh-rc-12",
            "gh-rv-2",
            "gh-rv-3",
            "gh-rv-4",
            "gh-ic-7",
            "gh-ic-8",
            ciId("unit"),
            ciId("build"),
        ])
        expect(by["gh-rc-10"]).toMatchObject({
            kind: "review_comment",
            author: "ron",
            path: "src/upload.js",
            line: 42,
            summary: "comment 10",
            actionable: true,
            pr: PR_URL,
        })
        expect(by["gh-rc-11"]).toMatchObject({ line: 7, url: PR_URL })
        expect(by["gh-rc-12"]).toMatchObject({ line: null, author: null })
        expect(by["gh-rv-2"]).toMatchObject({
            summary: "Review: CHANGES_REQUESTED",
            url: "rv2",
            actionable: true,
        })
        expect(by["gh-rv-3"].actionable).toBe(false)
        expect(by["gh-rv-4"]).toMatchObject({
            summary: "Please split this",
            url: PR_URL,
            actionable: true,
        })
        expect(by["gh-ic-7"].actionable).toBe(false)
        expect(by["gh-ic-8"]).toMatchObject({ actionable: false, url: PR_URL })
        expect(by[ciId("unit")]).toMatchObject({
            kind: "ci_failure",
            summary: "unit",
            url: `${PR_URL}/checks`,
            actionable: true,
        })
        expect(by[ciId("build")].url).toBe("run9")
        expect(extractItems({ pr: { author: null }, prUrl: "u" })).toEqual([])
    })

    test("verifyItem covers every kind/status", () => {
        const base = { url: "https://x/item", verify_failures: 0 }
        const pr = fullPr({
            commits: [{ oid: "ABC1234ffff" }],
            comments: [
                { body: "Re: https://x/item fixed in abc1234" },
                { body: "unrelated https://x/other" },
            ],
            statusCheckRollup: [
                { name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
                { name: "e2e", status: "IN_PROGRESS", conclusion: null },
                { name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
            ],
        })
        const rcs = [
            rc(100),
            rc(101, {
                in_reply_to_id: 100,
                created_at: "2026-11-07T12:00:00Z",
            }),
            rc(102, {
                in_reply_to_id: 100,
                created_at: "2026-11-07T13:00:00Z",
            }),
        ]
        const v = (item, extra = {}) =>
            verifyItem(
                { ...base, ...item },
                { pr, reviewComments: rcs, ...extra }
            )
        // review_comment
        expect(
            v({
                id: "gh-rc-100",
                kind: "review_comment",
                status: "fixed",
                commit: "abc1234",
            })
        ).toEqual({ result: "pass" })
        expect(
            v({
                id: "gh-rc-100",
                kind: "review_comment",
                status: "fixed",
                commit: "abc12",
            })
        ).toEqual({ result: "fail", missing: "commit" })
        expect(
            v({
                id: "gh-rc-100",
                kind: "review_comment",
                status: "fixed",
                commit: null,
            })
        ).toEqual({ result: "fail", missing: "commit" })
        // a reply item: needs a later reply in the same thread
        expect(
            v({ id: "gh-rc-101", kind: "review_comment", status: "answered" })
        ).toEqual({ result: "pass" })
        expect(
            v({ id: "gh-rc-102", kind: "review_comment", status: "answered" })
        ).toEqual({ result: "fail", missing: "thread_reply" })
        expect(
            v(
                { id: "gh-rc-555", kind: "review_comment", status: "declined" },
                { reviewComments: undefined }
            )
        ).toEqual({ result: "fail", missing: "thread_reply" })
        // review / issue comment
        expect(
            v({ id: "gh-rv-1", kind: "review", status: "answered" })
        ).toEqual({
            result: "pass",
        })
        expect(
            v({
                id: "gh-ic-1",
                kind: "issue_comment",
                status: "declined",
                url: "https://x/other",
            })
        ).toEqual({ result: "fail", missing: "re_comment" })
        // ci
        expect(
            v({
                id: "ci-unit",
                kind: "ci_failure",
                status: "fixed",
                commit: "abc1234",
                summary: "unit",
            })
        ).toEqual({ result: "pass" })
        expect(
            v({
                id: "ci-e2e",
                kind: "ci_failure",
                status: "fixed",
                commit: "abc1234",
                summary: "e2e",
            })
        ).toEqual({ result: "pending" })
        expect(
            v({
                id: "ci-x",
                kind: "ci_failure",
                status: "fixed",
                commit: "abc1234",
                summary: "gone",
            })
        ).toEqual({ result: "pending" })
        expect(
            v({
                id: "ci-lint",
                kind: "ci_failure",
                status: "fixed",
                commit: "abc1234",
                summary: "lint",
            })
        ).toEqual({ result: "fail", missing: "check" })
        expect(
            v({
                id: "ci-lint",
                kind: "ci_failure",
                status: "declined",
                summary: "lint",
            })
        ).toEqual({ result: "pass" })
        expect(
            verifyItem(
                { ...base, id: "ci-a", kind: "ci_failure", status: "declined" },
                { pr: { author: null } }
            )
        ).toEqual({ result: "fail", missing: "re_comment" })
        expect(
            verifyItem(
                {
                    ...base,
                    id: "ci-a",
                    kind: "ci_failure",
                    status: "fixed",
                    commit: "abcdef0",
                },
                { pr: { commits: [{ oid: "abcdef0" }] } }
            )
        ).toEqual({ result: "pending" })
    })

    test("ci fix: every check with that name must pass (names are not unique)", () => {
        const item = {
            id: "ci-test-abcdef1",
            kind: "ci_failure",
            status: "fixed",
            commit: "abcdef0",
            summary: "test",
        }
        const pr = (rollup) => ({
            commits: [{ oid: "abcdef0" }],
            statusCheckRollup: rollup,
        })
        const ok = { name: "test", status: "COMPLETED", conclusion: "SUCCESS" }
        const bad = { name: "test", status: "COMPLETED", conclusion: "FAILURE" }
        const run = { name: "test", status: "IN_PROGRESS", conclusion: null }
        expect(verifyItem(item, { pr: pr([ok, bad]) })).toEqual({
            result: "fail",
            missing: "check",
        })
        expect(verifyItem(item, { pr: pr([bad, ok]) })).toEqual({
            result: "fail",
            missing: "check",
        })
        expect(verifyItem(item, { pr: pr([ok, run]) })).toEqual({
            result: "pending",
        })
        expect(verifyItem(item, { pr: pr([ok, { ...ok }]) })).toEqual({
            result: "pass",
        })
    })
})

// ---------------------------------------------------------------------------

describe("discovery and claims", () => {
    test("the Ready for PR flag clears once every deliverable has its PR", async () => {
        const { gh, watcher } = await setup({
            deliverables: [deliv(REPO), deliv(REPO2)],
        })
        await store.updateTask(
            1,
            { flags: { now: true, now_reason: "Ready for PR" } },
            { actor: "me" }
        )
        gh.lists[REPO] = [listPr()]
        gh.prs[`${REPO}#812`] = fullPr()
        await watcher.pollTask(1)
        // REPO2 still has no PR: the ask stands
        let task = await getTask()
        expect(task.status).toBe("pr_open")
        expect(task.flags.now_reason).toBe("Ready for PR")
        // the second PR appears: done
        const url2 = `https://github.com/${ORG}/${REPO2}/pull/9`
        gh.lists[REPO2] = [
            listPr({
                number: 9,
                url: url2,
                headRepository: { name: REPO2, owner: ORG },
            }),
        ]
        gh.prs[`${REPO2}#9`] = fullPr({ number: 9, url: url2 })
        await watcher.pollTask(1)
        task = await getTask()
        expect(task.deliverables.every((d) => d.disposition === "pr")).toBe(
            true
        )
        expect(task.flags.now).toBe(false)
    })

    test("claiming keeps an unrelated Now flag", async () => {
        const { gh, watcher } = await setup()
        await store.updateTask(
            1,
            { flags: { now: true, now_reason: "Agent needs you" } },
            { actor: "me" }
        )
        gh.lists[REPO] = [listPr()]
        gh.prs[`${REPO}#812`] = fullPr()
        await watcher.pollTask(1)
        expect((await getTask()).flags.now_reason).toBe("Agent needs you")
    })

    test("claims the newest passing candidate and records candidates", async () => {
        const { gh, watcher, asanaService, claims } = await setup()
        const old = listPr({
            number: 700,
            url: `https://github.com/${ORG}/${REPO}/pull/700`,
            createdAt: "2026-11-01T00:00:00Z",
            state: "MERGED",
        })
        const fork = listPr({
            number: 813,
            url: `https://github.com/${ORG}/${REPO}/pull/813`,
            createdAt: "2026-11-07T11:30:00Z",
            isCrossRepository: true,
        })
        const older = listPr({
            number: 811,
            url: `https://github.com/${ORG}/${REPO}/pull/811`,
            createdAt: "2026-11-07T10:30:00Z",
        })
        gh.lists[REPO] = [old, listPr(), fork, older]
        gh.prs[`${REPO}#812`] = fullPr()
        const summary = await watcher.pollTask(1)
        expect(summary.claimed).toEqual([PR_URL])
        expect(summary.errors).toEqual([])

        const task = await getTask()
        expect(task.status).toBe("pr_open")
        expect(task.deliverables[0]).toMatchObject({
            disposition: "pr",
            pr: PR_URL,
            claimed_at: "2026-11-07T12:00:00.000Z",
        })
        expect(task.links).toEqual([
            expect.objectContaining({
                type: "pr",
                url: PR_URL,
                label: "aws-lambda#812",
                added_by: "system",
            }),
        ])
        expect(claims.claimOf(PR_URL).task_id).toBe(1)
        expect(asanaService.comment).toHaveBeenCalledWith(
            "99",
            `PR opened: ${PR_URL}`
        )
        expect(await eventsOf("pr_claimed")).toHaveLength(1)
        // claimed repo: no candidates kept for it
        expect(watcher.candidates(1)).toEqual([])
        const rows = watcher.prs(1)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            task_id: 1,
            repo: REPO,
            number: 812,
            state: "OPEN",
            head_sha: HEAD,
            ci_state: null,
            last_checked_at: "2026-11-07T12:00:00.000Z",
        })
        expect(busEvents.map((e) => e.type)).toContain("pr.updated")
    })

    test("failed candidates are listed with reasons", async () => {
        const { gh, watcher } = await setup({ asana: false })
        gh.lists[REPO] = [
            listPr({ body: "no marker" }),
            listPr({
                number: 700,
                url: `https://github.com/${ORG}/${REPO}/pull/700`,
                createdAt: "2026-11-01T00:00:00Z",
            }),
        ]
        const summary = await watcher.pollTask(1)
        expect(summary.claimed).toEqual([])
        expect(watcher.candidates(1)).toEqual([
            {
                repo: REPO,
                url: PR_URL,
                number: 812,
                reason: "missing_task_marker",
            },
            {
                repo: REPO,
                url: `https://github.com/${ORG}/${REPO}/pull/700`,
                number: 700,
                reason: "created_before_start",
            },
        ])
        expect((await getTask()).status).toBe("ready_for_pr")
        expect(watcher.candidates(99)).toEqual([])
    })

    test("a PR claimed by another task is a candidate", async () => {
        const { gh, watcher, claims } = await setup()
        claims.claim({
            url: PR_URL,
            task_id: 5,
            repo: REPO,
            number: 812,
            branch: "t1-fix",
        })
        gh.lists[REPO] = [listPr()]
        await watcher.pollTask(1)
        expect(watcher.candidates(1)[0].reason).toBe("claimed_by_other_task")
    })

    test("claim race: the insert loses to another task", async () => {
        const { gh, watcher, claims } = await setup()
        gh.lists[REPO] = [listPr()]
        const realClaim = claims.claim
        // another task inserts the claim between the check and our insert
        claims.claim = (args) => {
            realClaim({ ...args, task_id: 9 })
            return realClaim(args)
        }
        await watcher.pollTask(1)
        claims.claim = realClaim
        expect(watcher.candidates(1)).toEqual([
            expect.objectContaining({ reason: "claimed_by_other_task" }),
        ])
    })

    test("claim(): validation and manual claims", async () => {
        const { gh, watcher, claims } = await setup({
            deliverables: [
                deliv(REPO),
                deliv(REPO2, { disposition: "no_change" }),
            ],
        })
        expect(await watcher.claim(1, "nope")).toEqual({
            ok: false,
            reason: "invalid_url",
        })
        expect(
            await watcher.claim(1, "https://github.com/other/aws-lambda/pull/1")
        ).toEqual({ ok: false, reason: "foreign_repo" })
        expect(
            await watcher.claim(1, `https://github.com/${ORG}/web/pull/1`)
        ).toEqual({ ok: false, reason: "no_deliverable" })
        expect(await watcher.claim(1, PR2_URL)).toEqual({
            ok: false,
            reason: "deliverable_no_change",
        })
        // gh failure
        expect(await watcher.claim(1, PR_URL)).toMatchObject({
            ok: false,
            reason: "pr_unavailable",
        })
        // agent claim failing the checks becomes a candidate
        gh.prs[`${REPO}#812`] = fullPr({ body: "missing" })
        expect(await watcher.claim(1, PR_URL)).toEqual({
            ok: false,
            reason: "missing_task_marker",
        })
        expect(await watcher.claim(1, PR_URL)).toEqual({
            ok: false,
            reason: "missing_task_marker",
        })
        expect(watcher.candidates(1)).toHaveLength(1)
        // manual claim bypasses checks 1-3
        const res = await watcher.claim(1, `${PR_URL}/files`, { manual: true })
        expect(res.ok).toBe(true)
        expect(res.deliverable).toMatchObject({ pr: PR_URL, disposition: "pr" })
        expect(claims.claimOf(PR_URL).manual).toBe(true)
        expect(watcher.candidates(1)).toEqual([])
        const ev = await eventsOf("pr_claimed")
        expect(ev[0].actor).toBe("me")
        expect(ev[0].data.manual).toBe(true)
        expect((await getTask()).status).toBe("pr_open")
        // idempotent
        expect(await watcher.claim(1, PR_URL)).toMatchObject({
            ok: true,
            existing: true,
        })
        // another PR for the same deliverable
        expect(
            await watcher.claim(1, `https://github.com/${ORG}/${REPO}/pull/9`)
        ).toEqual({ ok: false, reason: "deliverable_has_pr" })
        // claimed by another task
        claims.claim({
            url: `https://github.com/${ORG}/${REPO}/pull/10`,
            task_id: 3,
            repo: REPO,
            number: 10,
            branch: "b",
        })
        expect(
            await watcher.claim(1, `https://github.com/${ORG}/${REPO}/pull/10`)
        ).toEqual({ ok: false, reason: "claimed_by_other_task" })
    })

    test("agent claim passing the checks", async () => {
        const { gh, watcher } = await setup()
        gh.prs[`${REPO}#812`] = fullPr()
        const res = await watcher.claim("1", PR_URL, { actor: "agent:t1-fix" })
        expect(res.ok).toBe(true)
        expect((await eventsOf("pr_claimed"))[0].actor).toBe("agent:t1-fix")
    })
})

// ---------------------------------------------------------------------------

async function claimedSetup(extra = {}) {
    const ctx = await setup({
        status: "pr_open",
        deliverables: [
            deliv(REPO, {
                disposition: "pr",
                pr: PR_URL,
                claimed_at: "2026-11-07T11:00:00.000Z",
            }),
        ],
        ...extra,
    })
    ctx.claims.claim({
        url: PR_URL,
        task_id: 1,
        repo: REPO,
        number: 812,
        branch: "t1-fix",
    })
    return ctx
}

describe("feedback rounds", () => {
    test("new items: classification, round 1 delivery, status and flags", async () => {
        const { gh, watcher, workerService, notifier, feedbackPrompt } =
            await claimedSetup()
        gh.prs[`${REPO}#812`] = fullPr({
            reviews: [
                {
                    id: 50,
                    author: { login: "ann" },
                    state: "APPROVED",
                    body: "",
                    submittedAt: "2026-11-07T11:40:00Z",
                },
            ],
            comments: [
                {
                    id: 60,
                    author: { login: "x[bot]", type: "Bot" },
                    body: "coverage",
                    createdAt: "2026-11-07T11:50:00Z",
                },
            ],
            statusCheckRollup: [
                {
                    name: "unit",
                    status: "COMPLETED",
                    conclusion: "FAILURE",
                    detailsUrl: "run1",
                },
            ],
        })
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        const summary = await watcher.pollTask(1)
        expect(summary).toMatchObject({
            new_items: 4,
            actionable: 2,
            delivered_round: 1,
            errors: [],
        })
        const items = await feedback()
        expect(items["gh-rc-1001"]).toMatchObject({
            round: 1,
            status: "open",
            actionable: true,
        })
        expect(items["gh-rv-50"].status).toBe("no_action")
        expect(items["gh-ic-60"].status).toBe("no_action")
        expect(items[ciId("unit")]).toMatchObject({
            status: "open",
            url: "run1",
        })
        const task = await getTask()
        expect(task.status).toBe("pr_feedback")
        expect(task.flags).toMatchObject({
            now: true,
            now_reason: "PR feedback: 2 new item(s)",
        })
        expect(notifier.notify).toHaveBeenCalledWith({
            title: "T-1: PR feedback: 2 new item(s)",
            body: "Fix upload retry",
        })
        expect(workerService.deliver).toHaveBeenCalledTimes(1)
        expect(workerService.deliver).toHaveBeenCalledWith(
            1,
            `feedback ${PR_URL} r1 t1-fix gh-rc-1001,${ciId("unit")}`,
            { reason: "pr_feedback", dedupeKey: "round-aws-lambda-812-1" }
        )
        expect(feedbackPrompt.mock.calls[0][0].task.id).toBe(1)
        expect(await eventsOf("feedback_round_delivered")).toHaveLength(1)
        const row = watcher.prs(1)[0]
        expect(row).toMatchObject({
            ci_state: "failure",
            last_comment_at: "2026-11-07T11:50:00Z",
            last_review_at: "2026-11-07T11:40:00Z",
        })
        expect(busEvents.map((e) => e.type)).toEqual(
            expect.arrayContaining(["feedback.updated", "pr.updated"])
        )

        // second poll with no changes: nothing new, nothing re-delivered
        const again = await watcher.pollTask(1)
        expect(again.new_items).toBe(0)
        expect(workerService.deliver).toHaveBeenCalledTimes(1)
    })

    test("queued round is delivered after roundResolved", async () => {
        const { gh, watcher, workerService } = await claimedSetup()
        gh.prs[`${REPO}#812`] = fullPr()
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        await watcher.pollTask(1)
        expect(workerService.deliver).toHaveBeenCalledTimes(1)

        // new comments while round 1 is open: queued round 2
        gh.rcs[`${REPO}#812`] = [rc(1001), rc(1002)]
        await watcher.pollTask(1)
        gh.rcs[`${REPO}#812`] = [rc(1001), rc(1002), rc(1003)]
        await watcher.pollTask(1)
        let items = await feedback()
        expect(items["gh-rc-1002"].round).toBe(2)
        expect(items["gh-rc-1003"].round).toBe(2)
        expect(workerService.deliver).toHaveBeenCalledTimes(1)

        // agent resolves round 1
        await resolve("gh-rc-1001", {
            status: "answered",
            reply_url: "r",
        })
        const res = await watcher.roundResolved(1)
        expect(res).toEqual({
            status: "pr_feedback",
            delivered_round: 2,
            errors: [],
        })
        expect(workerService.deliver).toHaveBeenCalledTimes(2)
        expect(workerService.deliver.mock.calls[1][2]).toEqual({
            reason: "pr_feedback",
            dedupeKey: "round-aws-lambda-812-2",
        })
        // agent resolves round 2 -> pr_open, now flag cleared
        await resolve("gh-rc-1002", { status: "answered", reply_url: "r" })
        await resolve("gh-rc-1003", { status: "answered", reply_url: "r" })
        const done = await watcher.roundResolved(1)
        expect(done.status).toBe("pr_open")
        const task = await getTask()
        expect(task.flags.now).toBe(false)
        items = await feedback()
        expect(items["gh-rc-1003"].status).toBe("answered")
    })

    test("settle keeps unrelated Now flags", async () => {
        const { watcher } = await claimedSetup({ status: "pr_feedback" })
        await store.updateTask(
            1,
            { flags: { now: true, now_reason: "Ready for PR" } },
            { actor: "me" }
        )
        const res = await watcher.roundResolved(1)
        expect(res.status).toBe("pr_open")
        expect((await getTask()).flags.now_reason).toBe("Ready for PR")
    })

    test("no_action-only batch starts a round that later actionable items join", async () => {
        const { gh, watcher, workerService } = await claimedSetup()
        gh.prs[`${REPO}#812`] = fullPr({
            comments: [{ id: 70, author: { login: "ann" }, body: "thanks!" }],
        })
        await watcher.pollTask(1)
        expect(workerService.deliver).not.toHaveBeenCalled()
        expect((await feedback())["gh-ic-70"]).toMatchObject({
            round: 1,
            status: "no_action",
        })
        expect((await getTask()).status).toBe("pr_open")
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        await watcher.pollTask(1)
        expect((await feedback())["gh-rc-1001"].round).toBe(1)
        expect(workerService.deliver).toHaveBeenCalledTimes(1)
    })

    test.each([
        ["failed with error", { status: "failed", error: "socket" }, "socket"],
        ["uncertain", { status: "uncertain" }, "delivery uncertain"],
        ["no result", undefined, "delivery unknown"],
        ["throws", new Error("herdr down"), "herdr down"],
    ])(
        "delivery %s: flagged, round not delivered, no resend",
        async (_name, result, message) => {
            const { gh, watcher, workerService, notifier } =
                await claimedSetup()
            if (result instanceof Error)
                workerService.deliver.mockRejectedValueOnce(result)
            else workerService.deliver.mockResolvedValueOnce(result)
            gh.prs[`${REPO}#812`] = fullPr()
            gh.rcs[`${REPO}#812`] = [rc(1001)]
            const s1 = await watcher.pollTask(1)
            expect(s1.delivered_round).toBeNull()
            expect(s1.delivery).toBe("failed")
            expect(s1.errors).toEqual([])
            let task = await getTask()
            expect(task.flags).toMatchObject({
                error: `Feedback prompt not delivered: ${message}`,
                now: true,
                now_reason: "Feedback prompt not delivered",
            })
            expect(task.status).toBe("pr_feedback")
            expect(notifier.notify).toHaveBeenLastCalledWith({
                title: "T-1: feedback prompt not delivered",
                body: message,
            })
            expect(await eventsOf("feedback_round_delivered")).toHaveLength(0)
            expect(await eventsOf("feedback_round_failed")).toHaveLength(1)
            // no automatic resend; the error is not cleared by the poll
            await watcher.pollTask(1)
            expect(workerService.deliver).toHaveBeenCalledTimes(1)
            task = await getTask()
            expect(task.flags.error).toBe(
                `Feedback prompt not delivered: ${message}`
            )
            // new items queue behind the failed round
            gh.rcs[`${REPO}#812`] = [rc(1001), rc(1002)]
            await watcher.pollTask(1)
            expect((await feedback())["gh-rc-1002"].round).toBe(2)
            expect(workerService.deliver).toHaveBeenCalledTimes(1)
            // Leo retried via Address feedback, the agent resolved round 1
            await resolve("gh-rc-1001", { status: "answered", reply_url: "r" })
            const res = await watcher.roundResolved(1)
            expect(res.delivered_round).toBe(2)
        }
    )

    test("blocked round is sealed: new items start a new round (real outbox)", async () => {
        const outbox = createOutboxRepo(db, { clock })
        const sent = []
        let agent = "blocked"
        const deliver = jest.fn(async (taskId, text, { reason, dedupeKey }) => {
            outbox.enqueue({
                task_id: taskId,
                text,
                reason,
                dedupe_key: dedupeKey,
            })
            if (agent === "blocked") return { status: "blocked" }
            for (const row of outbox.pending(taskId)) {
                sent.push({ key: row.dedupe_key, text: row.text })
                outbox.markSent(row.id)
            }
            return { status: "sent" }
        })
        const { gh, watcher } = await claimedSetup({
            opts: { workerService: { deliver } },
        })
        gh.prs[`${REPO}#812`] = fullPr()
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        const s1 = await watcher.pollTask(1)
        expect(s1.delivery).toBe("blocked")
        expect(await eventsOf("feedback_round_sealed")).toHaveLength(1)

        // new feedback while the round-1 prompt sits in the outbox
        gh.rcs[`${REPO}#812`] = [rc(1001), rc(1002)]
        await watcher.pollTask(1)
        let items = await feedback()
        expect(items["gh-rc-1001"].round).toBe(1)
        expect(items["gh-rc-1002"].round).toBe(2)
        // the retry targets round 1 only (same key), seal not duplicated
        expect(deliver.mock.calls.map((c) => c[2].dedupeKey)).toEqual([
            "round-aws-lambda-812-1",
            "round-aws-lambda-812-1",
        ])
        expect(await eventsOf("feedback_round_sealed")).toHaveLength(1)

        // the agent unblocks: round 1 goes out with its original items
        agent = "idle"
        const s3 = await watcher.pollTask(1)
        expect(s3.delivered_round).toBe(1)
        expect(sent).toHaveLength(1)
        expect(sent[0].key).toBe("round-aws-lambda-812-1")
        expect(sent[0].text).toContain("gh-rc-1001")
        expect(sent[0].text).not.toContain("gh-rc-1002")
        const delivered = await eventsOf("feedback_round_delivered")
        expect(delivered.map((e) => e.data)).toEqual([
            { round: 1, items: ["gh-rc-1001"] },
        ])

        // round 2 waits for round 1, then is delivered with its own key
        await resolve("gh-rc-1001", { status: "answered", reply_url: "r" })
        const res = await watcher.roundResolved(1)
        expect(res.delivered_round).toBe(2)
        expect(sent).toHaveLength(2)
        expect(sent[1].key).toBe("round-aws-lambda-812-2")
        expect(sent[1].text).toContain("gh-rc-1002")
        items = await feedback()
        expect(items["gh-rc-1002"].status).toBe("open")
    })

    test("reopening an item into a sealed (blocked) round uses its own key", async () => {
        const { gh, watcher, workerService } = await claimedSetup()
        workerService.deliver.mockResolvedValue({ status: "blocked" })
        gh.prs[`${REPO}#812`] = fullPr({
            comments: [{ id: 70, author: { login: "ann" }, body: "LGTM" }],
        })
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        await watcher.pollTask(1)
        await watcher.reopenItem(1, "gh-ic-70")
        expect(workerService.deliver.mock.calls[1][2].dedupeKey).toMatch(
            /^reopen-aws-lambda-812-gh-ic-70-\d+$/
        )
    })

    test("reopening an item on a closed PR sends the worker nothing", async () => {
        const { gh, watcher, workerService } = await claimedSetup()
        workerService.dropQueued = jest.fn(async () => [])
        workerService.deliver.mockResolvedValue({ status: "blocked" })
        gh.prs[`${REPO}#812`] = fullPr({
            comments: [{ id: 70, author: { login: "ann" }, body: "LGTM" }],
        })
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        await watcher.pollTask(1) // round 1 sealed (agent blocked)
        gh.prs[`${REPO}#812`] = fullPr({
            state: "CLOSED",
            closedAt: "2026-11-07T13:00:00Z",
            comments: [{ id: 70, author: { login: "ann" }, body: "LGTM" }],
        })
        await watcher.pollTask(1)
        expect(workerService.dropQueued).toHaveBeenCalledTimes(1)
        const calls = workerService.deliver.mock.calls.length
        const r = await watcher.reopenItem(1, "gh-ic-70")
        expect(r.item.status).toBe("open")
        expect(workerService.deliver).toHaveBeenCalledTimes(calls)
    })

    test("blocked agent: flagged, retried next poll with the same key", async () => {
        const { gh, watcher, workerService } = await claimedSetup()
        workerService.deliver.mockResolvedValue({ status: "blocked" })
        gh.prs[`${REPO}#812`] = fullPr()
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        const s1 = await watcher.pollTask(1)
        expect(s1.delivery).toBe("blocked")
        expect(s1.delivered_round).toBeNull()
        expect((await getTask()).flags.now_reason).toBe(
            "Agent blocked — feedback waiting"
        )
        expect(await eventsOf("feedback_round_delivered")).toHaveLength(0)
        expect(await eventsOf("feedback_round_failed")).toHaveLength(0)
        workerService.deliver.mockResolvedValue({ status: "queued" })
        const s2 = await watcher.pollTask(1)
        expect(s2.delivered_round).toBe(1)
        expect(
            workerService.deliver.mock.calls.map((c) => c[2].dedupeKey)
        ).toEqual(["round-aws-lambda-812-1", "round-aws-lambda-812-1"])
    })

    test("addressFeedback: oldest round only, sealed first, later comments start a new round", async () => {
        const { gh, watcher, workerService } = await claimedSetup()
        workerService.deliver.mockResolvedValue({ status: "blocked" })
        gh.prs[`${REPO}#812`] = fullPr()
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        await watcher.pollTask(1) // round 1 blocked: sealed, not delivered
        workerService.deliver.mockClear()
        workerService.deliver.mockResolvedValue({ status: "queued" })
        // Leo clicks Address feedback: round 1 (the oldest) goes out
        const r = await watcher.addressFeedback(1)
        expect(r).toMatchObject({
            round: 1,
            resent: false,
            delivery: { status: "queued" },
        })
        expect(workerService.deliver.mock.calls[0][2].dedupeKey).toBe(
            "round-aws-lambda-812-1"
        )
        // new comments now land in round 2 and wait for round 1
        gh.rcs[`${REPO}#812`] = [rc(1001), rc(1002)]
        await watcher.pollTask(1)
        expect((await feedback())["gh-rc-1002"].round).toBe(2)
        expect(workerService.deliver).toHaveBeenCalledTimes(1)
        // a second click re-sends round 1 under a fresh key
        clock.set("2026-11-07T13:00:00.000Z")
        const again = await watcher.addressFeedback(1)
        expect(again).toMatchObject({ round: 1, resent: true })
        expect(workerService.deliver.mock.calls[1][2].dedupeKey).toMatch(
            /^manual-aws-lambda-812-1-\d+$/
        )
        expect(workerService.deliver.mock.calls[1][1]).toContain("gh-rc-1001")
        expect(workerService.deliver.mock.calls[1][1]).not.toContain(
            "gh-rc-1002"
        )
        expect(await eventsOf("feedback_round_resent")).toHaveLength(1)
    })

    test("addressFeedback: nothing open is a 409; failed / unwired report it", async () => {
        const { watcher, workerService, gh } = await claimedSetup()
        await expect(watcher.addressFeedback(1)).rejects.toMatchObject({
            code: "no_open_feedback",
            status: 409,
        })
        gh.prs[`${REPO}#812`] = fullPr()
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        workerService.deliver.mockResolvedValue({ status: "blocked" })
        await watcher.pollTask(1)
        workerService.deliver.mockResolvedValue({
            status: "failed",
            error: "pane gone",
        })
        const r = await watcher.addressFeedback(1)
        expect(r.delivery).toEqual({ status: "failed", error: "pane gone" })
    })

    test("multi-PR round: failure wins over blocked", async () => {
        const { gh, watcher, workerService, claims } = await setup({
            status: "pr_open",
            deliverables: [
                deliv(REPO, {
                    disposition: "pr",
                    pr: PR_URL,
                    claimed_at: "2026-11-07T11:00:00.000Z",
                }),
                deliv(REPO2, {
                    disposition: "pr",
                    pr: PR2_URL,
                    claimed_at: "2026-11-07T11:00:00.000Z",
                }),
            ],
        })
        claims.claim({
            url: PR2_URL,
            task_id: 1,
            repo: REPO2,
            number: 44,
            branch: "t1-fix",
        })
        workerService.deliver
            .mockResolvedValueOnce({ status: "blocked" })
            .mockResolvedValueOnce({ status: "failed", message: "gone" })
        gh.prs[`${REPO}#812`] = fullPr()
        gh.prs[`${REPO2}#44`] = fullPr({ url: PR2_URL, number: 44 })
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        gh.rcs[`${REPO2}#44`] = [
            rc(2001, { html_url: `${PR2_URL}#discussion_r2001` }),
        ]
        const s = await watcher.pollTask(1)
        expect(s.delivery).toBe("failed")
        expect(
            workerService.deliver.mock.calls.map((c) => c[2].dedupeKey)
        ).toEqual(["round-aws-lambda-812-1", "round-infrastructure-44-1"])
        expect((await getTask()).flags.error).toBe(
            "Feedback prompt not delivered: gone"
        )
    })

    test("a PR merged with open feedback no longer holds the task in pr_feedback", async () => {
        const { gh, watcher, claims } = await setup({
            status: "pr_open",
            deliverables: [
                deliv(REPO, {
                    disposition: "pr",
                    pr: PR_URL,
                    claimed_at: "2026-11-07T11:00:00.000Z",
                }),
                deliv(REPO2, {
                    disposition: "pr",
                    pr: PR2_URL,
                    claimed_at: "2026-11-07T11:00:00.000Z",
                }),
            ],
        })
        claims.claim({
            url: PR2_URL,
            task_id: 1,
            repo: REPO2,
            number: 44,
            branch: "t1-fix",
        })
        gh.prs[`${REPO}#812`] = fullPr()
        gh.prs[`${REPO2}#44`] = fullPr({ url: PR2_URL, number: 44 })
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        await watcher.pollTask(1)
        let task = await getTask()
        expect(task.status).toBe("pr_feedback")
        expect(task.flags.now).toBe(true)

        // REPO merges with gh-rc-1001 still open; REPO2 stays open, no feedback
        gh.prs[`${REPO}#812`] = fullPr({
            state: "MERGED",
            mergedAt: "2026-11-07T12:00:00Z",
        })
        const s = await watcher.pollTask(1)
        expect(s.close_out).toBe(false)
        task = await getTask()
        expect(task.status).toBe("pr_open")
        expect(task.flags.now).toBe(false)
        // the merged PR's leftover stays on record
        expect((await feedback())["gh-rc-1001"].status).toBe("open")
    })

    test("delivery not wired", async () => {
        const { gh, watcher } = await claimedSetup({
            opts: { workerService: null },
        })
        gh.prs[`${REPO}#812`] = fullPr()
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        const s = await watcher.pollTask(1)
        expect(s.errors).toEqual(["feedback delivery not wired"])
    })

    test("merged / closed PRs do not create new items", async () => {
        const { gh, watcher } = await claimedSetup()
        gh.prs[`${REPO}#812`] = fullPr({
            state: "CLOSED",
            closedAt: "2026-11-07T11:59:00Z",
        })
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        const s = await watcher.pollTask(1)
        expect(s.new_items).toBe(0)
    })
})

// ---------------------------------------------------------------------------

describe("verification", () => {
    async function withRound(extraPr = {}) {
        const ctx = await claimedSetup()
        ctx.gh.prs[`${REPO}#812`] = fullPr(extraPr)
        ctx.gh.rcs[`${REPO}#812`] = [rc(1001)]
        await ctx.watcher.pollTask(1)
        return ctx
    }

    test("pass: commit on the PR + reply in the thread", async () => {
        const { gh, watcher } = await withRound()
        await resolve("gh-rc-1001", {
            status: "fixed",
            commit: "abc1234",
            reply_url: "r",
        })
        gh.prs[`${REPO}#812`] = fullPr({
            commits: [{ oid: "abc1234def" }],
        })
        gh.rcs[`${REPO}#812`] = [
            rc(1001),
            rc(1002, {
                in_reply_to_id: 1001,
                user: { login: "leo", type: "User" },
                created_at: "2026-11-07T12:30:00Z",
            }),
        ]
        const s = await watcher.pollTask(1)
        expect(s.verified).toBe(1)
        const items = await feedback()
        expect(items["gh-rc-1001"]).toMatchObject({
            status: "fixed",
            verified: true,
        })
        // the agent's own thread reply is recorded as no_action
        expect(items["gh-rc-1002"].status).toBe("no_action")
        expect((await getTask()).status).toBe("pr_open")
        // verified items are not re-verified
        const s2 = await watcher.pollTask(1)
        expect(s2.verified).toBe(0)
    })

    test("an item resolved while GitHub is read waits for the next poll", async () => {
        const { gh, watcher } = await withRound()
        // the agent resolves the item while getPr is in flight; the PR data
        // fetched predates its reply
        gh.prs[`${REPO}#812`] = async () => {
            await resolve("gh-rc-1001", { status: "answered", reply_url: "r" })
            return fullPr()
        }
        const s1 = await watcher.pollTask(1)
        expect(s1.reopened).toBe(0)
        expect((await feedback())["gh-rc-1001"]).toMatchObject({
            status: "answered",
            verify_failures: 0,
            verified: false,
        })
        expect(await eventsOf("feedback_verify_failed")).toHaveLength(0)

        // next poll sees the reply and verifies it
        gh.prs[`${REPO}#812`] = fullPr()
        gh.rcs[`${REPO}#812`] = [
            rc(1001),
            rc(1002, {
                in_reply_to_id: 1001,
                user: { login: "leo", type: "User" },
                created_at: "2026-11-07T12:30:00Z",
            }),
        ]
        const s2 = await watcher.pollTask(1)
        expect(s2.verified).toBe(1)
    })

    test.each([
        ["under the task lock", false],
        ["without withTaskLock", true],
    ])(
        "a verification result is dropped when the item changed during the GitHub reads (%s)",
        async (_label, lockless) => {
            const ctx = await claimedSetup(
                lockless
                    ? { opts: { store: { ...store, withTaskLock: undefined } } }
                    : {}
            )
            ctx.gh.prs[`${REPO}#812`] = fullPr()
            ctx.gh.rcs[`${REPO}#812`] = [rc(1001)]
            await ctx.watcher.pollTask(1)
            await resolve("gh-rc-1001", { status: "answered", reply_url: "r" })
            // resolved before the snapshot, then rewritten mid-fetch
            ctx.gh.prs[`${REPO}#812`] = async () => {
                await resolve("gh-rc-1001", {
                    status: "answered",
                    reply_url: "r2",
                })
                return fullPr()
            }
            const s = await ctx.watcher.pollTask(1)
            expect(s.reopened).toBe(0)
            expect((await feedback())["gh-rc-1001"]).toMatchObject({
                status: "answered",
                reply_url: "r2",
                verify_failures: 0,
            })
            expect(await eventsOf("feedback_verify_failed")).toHaveLength(0)
        }
    )

    test("fail once reopens + re-prompts; twice flags without a prompt", async () => {
        const { watcher, workerService, notifier } = await withRound()
        expect(workerService.deliver).toHaveBeenCalledTimes(1)
        await resolve("gh-rc-1001", { status: "answered", reply_url: "r" })
        await watcher.roundResolved(1)
        expect((await getTask()).status).toBe("pr_open")

        const s1 = await watcher.pollTask(1)
        expect(s1.reopened).toBe(1)
        let item = (await feedback())["gh-rc-1001"]
        expect(item).toMatchObject({ status: "open", verify_failures: 1 })
        expect(workerService.deliver).toHaveBeenCalledTimes(2)
        expect(workerService.deliver.mock.calls[1][2].dedupeKey).toBe(
            "reverify-aws-lambda-812-gh-rc-1001"
        )
        let task = await getTask()
        expect(task.status).toBe("pr_feedback")
        expect(task.flags.now_reason).toMatch(/verification failed, reopened/)
        const ev = await eventsOf("feedback_verify_failed")
        expect(ev[0].data).toMatchObject({
            item: "gh-rc-1001",
            missing: "thread_reply",
            failures: 1,
        })

        await resolve("gh-rc-1001", { status: "answered", reply_url: "r" })
        // cc_feedback normally moves the resolved round back to pr_open
        await store.updateTask(1, { status: "pr_open" }, { actor: "me" })
        const s2 = await watcher.pollTask(1)
        expect(s2.flagged).toBe(1)
        // reopened feedback: pr_feedback again (Address feedback offered),
        // still no automatic re-prompt
        expect((await getTask()).status).toBe("pr_feedback")
        item = (await feedback())["gh-rc-1001"]
        expect(item).toMatchObject({ status: "open", verify_failures: 2 })
        expect(workerService.deliver).toHaveBeenCalledTimes(2)
        task = await getTask()
        expect(task.flags.now_reason).toBe(
            "PR feedback: verification failed twice (gh-rc-1001)"
        )
        expect(notifier.notify).toHaveBeenLastCalledWith({
            title: "T-1: feedback verification failed twice",
            body: "gh-rc-1001",
        })
    })

    test.each([
        ["merged", { state: "MERGED", mergedAt: "2026-11-07T13:00:00Z" }],
        ["closed", { state: "CLOSED", closedAt: "2026-11-07T13:00:00Z" }],
    ])(
        "a %s PR never reopens or re-prompts unverified feedback",
        async (how, prState) => {
            const { gh, watcher, workerService, notifier } = await withRound()
            workerService.dropQueued = jest.fn(async () => [])
            expect(workerService.deliver).toHaveBeenCalledTimes(1)
            // resolved without the thread reply the verification needs
            await resolve("gh-rc-1001", { status: "answered", reply_url: "r" })
            gh.prs[`${REPO}#812`] = fullPr(prState)
            const s1 = await watcher.pollTask(1)
            expect(s1.reopened).toBe(0)
            expect(s1.flagged).toBe(0)
            expect(workerService.deliver).toHaveBeenCalledTimes(1)
            expect((await feedback())["gh-rc-1001"]).toMatchObject({
                status: "answered",
                verified: false,
                verify_failures: 0,
            })
            expect(await eventsOf("feedback_verify_failed")).toHaveLength(0)
            const ev = await eventsOf("feedback_unverified_at_close")
            expect(ev).toHaveLength(1)
            expect(ev[0].data).toEqual({
                url: PR_URL,
                pr: how,
                items: [{ item: "gh-rc-1001", missing: "thread_reply" }],
            })
            expect(notifier.notify).toHaveBeenCalledWith({
                title: `T-1: PR ${how} with unverified feedback`,
                body: "gh-rc-1001",
            })
            // queued feedback prompts of this PR are dropped from the outbox
            expect(workerService.dropQueued).toHaveBeenCalledWith(
                1,
                expect.any(Function),
                { pr: PR_URL, status: how }
            )
            const match = workerService.dropQueued.mock.calls[0][1]
            expect(match("round-aws-lambda-812-1")).toBe(true)
            expect(match("manual-aws-lambda-812-2-1731000000000")).toBe(true)
            expect(match("reverify-aws-lambda-812-gh-rc-1001")).toBe(true)
            expect(match("reopen-aws-lambda-812-gh-ic-70-1731000000000")).toBe(
                true
            )
            expect(match("reopen-aws-lambda-8120-gh-ic-70-1731000000000")).toBe(
                false
            )
            expect(match("round-aws-lambda-8120-1")).toBe(false)
            expect(match("round-aws-lambda-812-5-2")).toBe(false)
            expect(match("sched-4")).toBe(false)
        }
    )

    test("a queued round is not delivered once its PR merged", async () => {
        const ctx = await claimedSetup()
        const { gh, watcher, workerService } = ctx
        // the agent is blocked: round 1 stays queued (not attempted)
        workerService.deliver.mockImplementation(async () => ({
            status: "blocked",
        }))
        gh.prs[`${REPO}#812`] = fullPr()
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        await watcher.pollTask(1)
        const calls = workerService.deliver.mock.calls.length
        expect(calls).toBeGreaterThan(0)
        workerService.deliver.mockImplementation(async () => ({
            status: "sent",
        }))
        gh.prs[`${REPO}#812`] = fullPr({
            state: "MERGED",
            mergedAt: "2026-11-07T13:00:00Z",
        })
        const s = await watcher.pollTask(1)
        expect(s.merged).toEqual([PR_URL])
        expect(s.delivered_round).toBeNull()
        expect(workerService.deliver).toHaveBeenCalledTimes(calls)
        await expect(watcher.addressFeedback(1)).rejects.toMatchObject({
            code: "no_open_feedback",
        })
        expect(workerService.deliver).toHaveBeenCalledTimes(calls)
    })

    test("ci fix waits for the check on the new head", async () => {
        const failing = {
            statusCheckRollup: [
                { name: "unit", status: "COMPLETED", conclusion: "FAILURE" },
            ],
        }
        const { gh, watcher } = await claimedSetup()
        gh.prs[`${REPO}#812`] = fullPr(failing)
        await watcher.pollTask(1)
        await resolve(ciId("unit"), { status: "fixed", commit: "fff0001" })
        gh.prs[`${REPO}#812`] = fullPr({
            headRefOid: "fff0001aaaa",
            commits: [{ oid: "fff0001aaaa" }],
            statusCheckRollup: [
                { name: "unit", status: "IN_PROGRESS", conclusion: null },
            ],
        })
        const s1 = await watcher.pollTask(1)
        expect(s1.verified).toBe(0)
        expect(s1.reopened).toBe(0)
        gh.prs[`${REPO}#812`] = fullPr({
            headRefOid: "fff0001aaaa",
            commits: [{ oid: "fff0001aaaa" }],
            statusCheckRollup: [
                { name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
            ],
        })
        const s2 = await watcher.pollTask(1)
        expect(s2.verified).toBe(1)
        expect(watcher.prs(1)[0]).toMatchObject({
            ci_state: "success",
            head_sha: "fff0001aaaa",
        })
    })
})

// ---------------------------------------------------------------------------

describe("merge, close and close-out", () => {
    test("merge records merged_at, comments on Asana and enqueues close-out once", async () => {
        const { gh, watcher, asanaService, jobRunner } = await claimedSetup()
        gh.prs[`${REPO}#812`] = fullPr({
            state: "MERGED",
            mergedAt: "2026-11-07T11:58:00Z",
            closedAt: "2026-11-07T11:58:00Z",
        })
        const s = await watcher.pollTask(1)
        expect(s.merged).toEqual([PR_URL])
        expect(s.close_out).toBe(true)
        const task = await getTask()
        expect(task.deliverables[0].merged_at).toBe("2026-11-07T11:58:00.000Z")
        expect(asanaService.comment).toHaveBeenCalledWith(
            "99",
            `Merged: ${PR_URL}`
        )
        expect(jobRunner.enqueue).toHaveBeenCalledWith(
            "close_out",
            {},
            { task_id: 1 }
        )
        expect(await eventsOf("pr_merged")).toHaveLength(1)
        expect(await eventsOf("close_out_requested")).toHaveLength(1)
        expect(watcher.prs(1)[0]).toMatchObject({
            state: "MERGED",
            closed_at: null,
        })
        // a close_out job is pending: enqueueCloseOut dedupes
        const jobs = []
        jobRunner.list.mockImplementation(({ status }) =>
            jobs.filter((j) => status.includes(j.status))
        )
        jobs.push({ id: "j1", type: "close_out", status: "running" })
        const s2 = await watcher.pollTask(1)
        expect(s2.close_out).toBe(true)
        expect(jobRunner.enqueue).toHaveBeenCalledTimes(1)
        expect(await eventsOf("close_out_requested")).toHaveLength(1)
        // the job failed (e.g. SOC2 record missing): the next poll retries
        jobs[0].status = "failed"
        await watcher.pollTask(1)
        expect(jobRunner.enqueue).toHaveBeenCalledTimes(2)
        expect(await eventsOf("close_out_requested")).toHaveLength(2)
    })

    test("an existing close-out job is reused (no event)", async () => {
        const { gh, watcher, jobRunner } = await claimedSetup({ asana: false })
        jobRunner.list.mockReturnValue([{ id: "old", type: "close_out" }])
        gh.prs[`${REPO}#812`] = fullPr({
            state: "MERGED",
            mergedAt: null,
        })
        const s = await watcher.pollTask(1)
        expect(s.close_out).toBe(true)
        expect(jobRunner.enqueue).not.toHaveBeenCalled()
        expect(await eventsOf("close_out_requested")).toHaveLength(0)
        expect((await getTask()).deliverables[0].merged_at).toBe(
            "2026-11-07T12:00:00.000Z"
        )
    })

    test("closed without merge flags Now once and keeps the status", async () => {
        const { gh, watcher, notifier } = await claimedSetup()
        gh.prs[`${REPO}#812`] = fullPr({
            state: "CLOSED",
            closedAt: "2026-11-07T11:59:00Z",
        })
        const s = await watcher.pollTask(1)
        expect(s.closed).toEqual([PR_URL])
        const task = await getTask()
        expect(task.status).toBe("pr_open")
        expect(task.flags).toMatchObject({
            now: true,
            now_reason: "PR closed without merge",
        })
        expect(notifier.notify).toHaveBeenCalledWith({
            title: "T-1: PR closed without merge",
            body: "aws-lambda#812",
        })
        const s2 = await watcher.pollTask(1)
        expect(s2.closed).toEqual([])
        expect(notifier.notify).toHaveBeenCalledTimes(1)
        // reopened: closed_at clears
        gh.prs[`${REPO}#812`] = fullPr()
        await watcher.pollTask(1)
        expect(watcher.prs(1)[0].closed_at).toBeNull()
    })

    test("claiming an already-closed PR still surfaces the closure once", async () => {
        const { gh, watcher, notifier } = await setup()
        const closed = {
            state: "CLOSED",
            closedAt: "2026-11-07T11:59:00Z",
        }
        gh.lists[REPO] = [listPr(closed)]
        gh.prs[`${REPO}#812`] = fullPr(closed)
        // discovery claims it (closed_at not recorded at claim time) and the
        // same poll's PR pass reports the closure
        const s1 = await watcher.pollTask(1)
        expect(s1.claimed).toEqual([PR_URL])
        expect(s1.closed).toEqual([PR_URL])
        const task = await getTask()
        expect(task.status).toBe("pr_open")
        expect(task.flags).toMatchObject({
            now: true,
            now_reason: "PR closed without merge",
        })
        expect(notifier.notify).toHaveBeenCalledTimes(1)
        expect(watcher.prs(1)[0].closed_at).toBe("2026-11-07T11:59:00Z")
        const s2 = await watcher.pollTask(1)
        expect(s2.closed).toEqual([])
        expect(notifier.notify).toHaveBeenCalledTimes(1)
    })

    test("manual claim of a closed PR: first poll flags, second does not", async () => {
        const { gh, watcher, notifier } = await setup()
        gh.prs[`${REPO}#812`] = fullPr({
            state: "CLOSED",
            closedAt: "2026-11-07T11:59:00Z",
            body: "no marker",
        })
        expect((await watcher.claim(1, PR_URL, { manual: true })).ok).toBe(true)
        expect(watcher.prs(1)[0]).toMatchObject({
            state: "CLOSED",
            closed_at: null,
        })
        const s1 = await watcher.pollTask(1)
        expect(s1.closed).toEqual([PR_URL])
        expect((await getTask()).flags.now_reason).toBe(
            "PR closed without merge"
        )
        expect(notifier.notify).toHaveBeenCalledTimes(1)
        const s2 = await watcher.pollTask(1)
        expect(s2.closed).toEqual([])
        expect(notifier.notify).toHaveBeenCalledTimes(1)
    })

    test("multi-repo: one merged + pending stays open until no_change", async () => {
        const { gh, watcher, jobRunner } = await setup({
            status: "pr_open",
            deliverables: [
                deliv(REPO, {
                    disposition: "pr",
                    pr: PR_URL,
                    claimed_at: "2026-11-07T11:00:00.000Z",
                    merged_at: "2026-11-07T11:30:00.000Z",
                }),
                deliv(REPO2),
            ],
        })
        const s = await watcher.pollTask(1)
        expect(s.close_out).toBe(false)
        expect(gh.listPrsByHead).toHaveBeenCalledWith(REPO2, "t1-fix")
        expect(gh.getPr).not.toHaveBeenCalled()

        await expect(watcher.setNoChange(1, "nope")).rejects.toMatchObject({
            status: 404,
        })
        // a claimed PR is never overwritten by a (stale) No change click
        await expect(watcher.setNoChange(1, REPO)).rejects.toMatchObject({
            status: 409,
            code: "invalid_state",
        })
        expect((await getTask()).deliverables[0]).toMatchObject({
            disposition: "pr",
            pr: PR_URL,
        })
        expect(await eventsOf("deliverable_no_change")).toHaveLength(0)
        const res = await watcher.setNoChange(1, REPO2)
        expect(res.task.deliverables[1].disposition).toBe("no_change")
        expect(await eventsOf("deliverable_no_change")).toHaveLength(1)
        // idempotent
        await watcher.setNoChange(1, REPO2)
        // background poll closes it
        await clock.advance(0)
        await watcher.pollTask(1)
        expect(jobRunner.enqueue).toHaveBeenCalledTimes(1)
    })

    test("a stale No change after discovery claimed the PR is rejected and close-out waits for the merge", async () => {
        const { gh, watcher, jobRunner } = await setup({
            status: "pr_open",
            deliverables: [deliv(REPO)],
        })
        // discovery claims the open PR while the UI still offers No change
        gh.lists[REPO] = [listPr()]
        gh.prs[`${REPO}#812`] = fullPr()
        await watcher.pollTask(1)
        expect((await getTask()).deliverables[0].disposition).toBe("pr")

        await expect(watcher.setNoChange(1, REPO)).rejects.toMatchObject({
            status: 409,
        })
        const d = (await getTask()).deliverables[0]
        expect(d).toMatchObject({ disposition: "pr", pr: PR_URL })
        expect(d.merged_at || null).toBeNull()
        const s = await watcher.pollTask(1)
        expect(s.close_out).toBe(false)
        expect(jobRunner.enqueue).not.toHaveBeenCalled()
    })

    test("background poll failure after no_change is logged", async () => {
        const log = { warn: jest.fn(), debug() {}, info() {}, error() {} }
        const { watcher } = await setup({
            status: "pr_open",
            deliverables: [deliv(REPO2)],
            opts: { log },
        })
        await watcher.setNoChange(1, REPO2)
        const spy = jest
            .spyOn(store, "getTask")
            .mockRejectedValue(new Error("disk"))
        await clock.advance(0)
        await new Promise((r) => setTimeout(r, 20))
        spy.mockRestore()
        // pollTaskInner turns getTask errors into a summary; no warn needed
        expect(log.warn).not.toHaveBeenCalledWith(
            expect.anything(),
            "poll after no_change"
        )
    })

    test("no deliverables never closes", async () => {
        const { watcher, jobRunner } = await setup({
            status: "pr_open",
            deliverables: [],
        })
        await watcher.pollTask(1)
        expect(jobRunner.enqueue).not.toHaveBeenCalled()
    })
})

// ---------------------------------------------------------------------------

describe("review tasks and PRs from other branches", () => {
    test("isWatched: PR statuses, or review with a claimed PR (merged too)", () => {
        expect(isWatched(null)).toBe(false)
        expect(isWatched({ status: "pr_open", deliverables: [] })).toBe(true)
        const live = deliv(REPO, { disposition: "pr", pr: PR_URL })
        expect(isWatched({ status: "review", deliverables: [live] })).toBe(true)
        // merged: still watched, so a failed close-out is retried
        expect(
            isWatched({
                status: "review",
                deliverables: [{ ...live, merged_at: "2026-11-08T00:00:00Z" }],
            })
        ).toBe(true)
        expect(
            isWatched({ status: "review", deliverables: [deliv(REPO)] })
        ).toBe(false)
        expect(isWatched({ status: "review" })).toBe(false)
        expect(isWatched({ status: "active", deliverables: [live] })).toBe(
            false
        )
    })

    test("manually claiming an already merged PR from another branch makes the task closable", async () => {
        const { gh, watcher, asanaService } = await setup({
            status: "review",
            deliverables: [deliv(REPO)],
        })
        gh.prs[`${REPO}#812`] = fullPr({
            headRefName: "fix/other-branch",
            state: "MERGED",
            mergedAt: "2026-11-08T19:00:00Z",
        })
        const res = await watcher.claim(1, PR_URL, { manual: true })
        expect(res.ok).toBe(true)
        const task = await getTask()
        expect(task.status).toBe("review")
        expect(task.deliverables[0]).toMatchObject({
            disposition: "pr",
            pr: PR_URL,
            merged_at: "2026-11-08T19:00:00.000Z",
        })
        expect(openDeliverables(task)).toEqual([])
        expect(await eventsOf("pr_merged")).toHaveLength(1)
        expect(asanaService.comment).toHaveBeenCalledWith(
            "99",
            `Merged: ${PR_URL}`
        )
        // the next poll closes it out (done on merge)
        const s = await watcher.pollTask(1)
        expect(s.skipped).toBeUndefined()
        expect(s.close_out).toBe(true)
    })

    test("a close-out that fails after the merge is retried on the next poll", async () => {
        const { gh, watcher, jobRunner } = await setup({
            status: "review",
            deliverables: [deliv(REPO)],
        })
        gh.prs[`${REPO}#812`] = fullPr({
            state: "MERGED",
            mergedAt: "2026-11-08T19:00:00Z",
        })
        await watcher.claim(1, PR_URL, { manual: true })
        jobRunner.enqueue.mockImplementationOnce(() => {
            throw new Error("queue down")
        })
        const s1 = await watcher.pollTask(1)
        expect(s1.close_out).toBe(false)
        expect((await getTask()).status).toBe("review")
        // still watched: the next poll queues the close-out
        const s2 = await watcher.pollTask(1)
        expect(s2.skipped).toBeUndefined()
        expect(s2.close_out).toBe(true)
        expect(jobRunner.enqueue).toHaveBeenCalledTimes(2)
    })

    test("merged state without a timestamp uses the claim time", async () => {
        const { gh, watcher } = await setup({
            status: "review",
            deliverables: [deliv(REPO)],
        })
        gh.prs[`${REPO}#812`] = fullPr({ state: "MERGED", mergedAt: null })
        await watcher.claim(1, PR_URL, { manual: true })
        expect((await getTask()).deliverables[0].merged_at).toEqual(
            expect.any(String)
        )
    })

    test("a review task with an open claimed PR is polled and closes out on merge", async () => {
        const { gh, watcher, jobRunner, asanaService } = await setup({
            status: "review",
            deliverables: [deliv(REPO)],
        })
        gh.prs[`${REPO}#812`] = fullPr()
        await watcher.claim(1, PR_URL, { manual: true })
        expect(asanaService.comment).toHaveBeenCalledWith(
            "99",
            `PR opened: ${PR_URL}`
        )
        expect((await getTask()).deliverables[0].merged_at).toBeNull()
        const s1 = await watcher.pollTask(1)
        expect(s1.skipped).toBeUndefined()
        expect(s1.close_out).toBe(false)
        // merged later: recorded, and the task closes out
        gh.prs[`${REPO}#812`] = fullPr({
            state: "MERGED",
            mergedAt: "2026-11-08T20:00:00Z",
        })
        const s2 = await watcher.pollTask(1)
        expect(s2.merged).toEqual([PR_URL])
        expect(s2.close_out).toBe(true)
        expect(jobRunner.enqueue).toHaveBeenCalled()
    })

    test("new feedback moves a review task to pr_feedback; resolving it settles to pr_open", async () => {
        const { gh, watcher } = await setup({
            status: "review",
            deliverables: [deliv(REPO)],
        })
        gh.prs[`${REPO}#812`] = fullPr()
        await watcher.claim(1, PR_URL, { manual: true })
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        await watcher.pollTask(1)
        let task = await getTask()
        expect(task.status).toBe("pr_feedback")
        expect(task.flags.now_reason).toBe("PR feedback: 1 new item(s)")

        await resolve("gh-rc-1001", { status: "fixed", commit: "abc1234" })
        await watcher.roundResolved(1)
        task = await getTask()
        expect(task.status).toBe("pr_open")
        expect(task.flags).toMatchObject({ now: false, now_reason: null })
        const ev = await eventsOf("feedback_addressed")
        expect(ev).toHaveLength(1)
        expect(ev[0].data).toEqual({ items: 1 })
        // settled once: nothing to clear on the next poll
        await watcher.roundResolved(1)
        expect(await eventsOf("feedback_addressed")).toHaveLength(1)
    })

    test("resolved feedback clears its Now flag whatever the status", async () => {
        const { gh, watcher } = await setup({
            status: "review",
            deliverables: [deliv(REPO)],
        })
        gh.prs[`${REPO}#812`] = fullPr()
        await watcher.claim(1, PR_URL, { manual: true })
        await store.appendFeedback(
            1,
            {
                id: "gh-rc-1001",
                pr: PR_URL,
                round: 1,
                kind: "review_comment",
                url: `${PR_URL}#discussion_r1001`,
                actionable: true,
                status: "answered",
                at: "2026-11-08T12:00:00.000Z",
                verified: false,
                verify_failures: 0,
            },
            "system"
        )
        await store.updateTask(
            1,
            { flags: { now: true, now_reason: "PR feedback: 1 new item(s)" } },
            { actor: "system" }
        )
        await watcher.roundResolved(1)
        const task = await getTask()
        expect(task.status).toBe("review")
        expect(task.flags).toMatchObject({ now: false, now_reason: null })
        expect(await eventsOf("feedback_addressed")).toHaveLength(1)
    })

    test("another Now flag stays when feedback settles", async () => {
        const { watcher } = await claimedSetup()
        await store.updateTask(
            1,
            { flags: { now: true, now_reason: "Ready for review" } },
            { actor: "system" }
        )
        await watcher.roundResolved(1)
        expect((await getTask()).flags.now_reason).toBe("Ready for review")
        expect(await eventsOf("feedback_addressed")).toHaveLength(0)
    })

    test("pollAll includes review tasks; ones without a claimed PR are skipped", async () => {
        const { watcher } = await setup({
            status: "review",
            deliverables: [deliv(REPO)],
        })
        const spy = jest.spyOn(store, "query")
        const r = await watcher.pollAll()
        expect(spy.mock.calls[0][0].status).toEqual([
            "ready_for_pr",
            "pr_open",
            "pr_feedback",
            "review",
        ])
        expect(r.results[0].skipped).toBe("status review")
        spy.mockRestore()
    })
})

describe("reopenItem", () => {
    test("errors and reopen of a no_action item in a delivered round", async () => {
        const { gh, watcher, workerService } = await claimedSetup()
        gh.prs[`${REPO}#812`] = fullPr({
            comments: [{ id: 70, author: { login: "ann" }, body: "LGTM" }],
        })
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        await watcher.pollTask(1)
        expect(workerService.deliver).toHaveBeenCalledTimes(1)

        await expect(watcher.reopenItem(1, "nope")).rejects.toMatchObject({
            status: 404,
        })
        await expect(watcher.reopenItem(1, "gh-rc-1001")).rejects.toMatchObject(
            { status: 409, code: "invalid_state" }
        )

        await resolve("gh-rc-1001", { status: "answered", reply_url: "r" })
        await watcher.roundResolved(1)
        expect((await getTask()).status).toBe("pr_open")

        const res = await watcher.reopenItem(1, "gh-ic-70")
        expect(res.item).toMatchObject({
            status: "open",
            actionable: true,
            round: 1,
        })
        expect(workerService.deliver).toHaveBeenCalledTimes(2)
        expect(workerService.deliver.mock.calls[1][2].dedupeKey).toMatch(
            /^reopen-aws-lambda-812-gh-ic-70-\d+$/
        )
        expect((await getTask()).status).toBe("pr_feedback")
        expect(await eventsOf("feedback_reopened")).toHaveLength(1)
    })

    test("reopen in an undelivered round goes through the queue", async () => {
        const { gh, watcher, workerService } = await claimedSetup()
        gh.prs[`${REPO}#812`] = fullPr({
            comments: [{ id: 70, author: { login: "ann" }, body: "LGTM" }],
        })
        await watcher.pollTask(1)
        await watcher.reopenItem(1, "gh-ic-70")
        expect(workerService.deliver).toHaveBeenCalledTimes(1)
        expect(workerService.deliver.mock.calls[0][2].dedupeKey).toBe(
            "round-aws-lambda-812-1"
        )
    })

    test("reopen on a task outside PR states records only", async () => {
        const { watcher, workerService } = await setup({ status: "active" })
        await store.appendFeedback(1, {
            id: "gh-ic-1",
            pr: PR_URL,
            round: 1,
            kind: "issue_comment",
            url: "u",
            actionable: false,
            status: "no_action",
        })
        const res = await watcher.reopenItem(1, "gh-ic-1")
        expect(res.item.status).toBe("open")
        expect(workerService.deliver).not.toHaveBeenCalled()
    })
})

// ---------------------------------------------------------------------------

describe("PR closed and reopened (real outbox)", () => {
    /**
     * workerService over the real outbox repo, mirroring deliver(): an
     * existing key returns its row status (sent / cancelled / ...);
     * agent "busy" leaves the row queued, "blocked" reports blocked,
     * "idle" flushes every pending row. dropQueued cancels pending rows.
     */
    function outboxWorker() {
        const outbox = createOutboxRepo(db, { clock })
        const w = {
            agent: "busy",
            sent: [],
            outbox,
            deliver: jest.fn(async (taskId, text, { reason, dedupeKey }) => {
                const row = outbox.enqueue({
                    task_id: taskId,
                    text,
                    reason,
                    dedupe_key: dedupeKey,
                })
                if (row.status !== "pending")
                    return { status: row.status, duplicate: true }
                if (w.agent === "busy") return { status: "queued" }
                if (w.agent === "blocked") return { status: "blocked" }
                for (const r of outbox.pending(taskId)) {
                    w.sent.push(r.dedupe_key)
                    outbox.markSent(r.id)
                }
                return { status: "sent" }
            }),
            dropQueued: jest.fn(async (taskId, match) => {
                const ids = []
                for (const r of outbox.pending(taskId))
                    if (match(r.dedupe_key || "") && outbox.cancel(r.id))
                        ids.push(r.id)
                return ids
            }),
        }
        return w
    }

    const closedPr = () =>
        fullPr({ state: "CLOSED", closedAt: "2026-11-07T12:00:00Z" })

    test("a queued round cancelled by the close is sent again on reopen", async () => {
        const w = outboxWorker()
        const { gh, watcher } = await claimedSetup({
            opts: { workerService: w },
        })
        gh.prs[`${REPO}#812`] = fullPr()
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        const s1 = await watcher.pollTask(1)
        expect(s1.delivered_round).toBe(1)
        expect((await getTask()).status).toBe("pr_feedback")

        // closed while the prompt waits for the busy agent: it is cancelled
        gh.prs[`${REPO}#812`] = closedPr()
        await watcher.pollTask(1)
        expect(w.outbox.pending(1)).toHaveLength(0)
        expect((await getTask()).status).toBe("pr_open")

        // reopened (GitHub may keep the old closedAt): fresh key, pr_feedback
        gh.prs[`${REPO}#812`] = fullPr({
            state: "OPEN",
            closedAt: "2026-11-07T12:00:00Z",
        })
        const s3 = await watcher.pollTask(1)
        expect(s3.reopened_prs).toEqual([PR_URL])
        expect(s3.delivery).toBeUndefined()
        const pending = w.outbox.pending(1)
        expect(pending).toHaveLength(1)
        expect(pending[0].dedupe_key).toMatch(/^resume-aws-lambda-812-1-\d+$/)
        expect(pending[0].text).toContain("gh-rc-1001")
        const task = await getTask()
        expect(task.status).toBe("pr_feedback")
        expect(task.flags.error || null).toBeNull()
        expect(await eventsOf("pr_reopened")).toHaveLength(1)

        // later polls neither resend nor hit the cancelled round key
        w.agent = "idle"
        const s4 = await watcher.pollTask(1)
        expect(s4.delivery).toBeUndefined()
        expect(s4.reopened_prs).toEqual([])
        expect(w.deliver).toHaveBeenCalledTimes(2)
        expect(await eventsOf("pr_reopened")).toHaveLength(1)
        // a later close drops the resume prompt too
        gh.prs[`${REPO}#812`] = closedPr()
        await watcher.pollTask(1)
        expect(w.outbox.pending(1)).toHaveLength(0)
    })

    test("a blocked round cancelled by the close is sent on reopen", async () => {
        const w = outboxWorker()
        w.agent = "blocked"
        const { gh, watcher } = await claimedSetup({
            opts: { workerService: w },
        })
        gh.prs[`${REPO}#812`] = fullPr()
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        const s1 = await watcher.pollTask(1)
        expect(s1.delivery).toBe("blocked")
        expect(await eventsOf("feedback_round_delivered")).toHaveLength(0)

        gh.prs[`${REPO}#812`] = closedPr()
        await watcher.pollTask(1)
        expect(w.outbox.pending(1)).toHaveLength(0)

        w.agent = "idle"
        gh.prs[`${REPO}#812`] = fullPr()
        await watcher.pollTask(1)
        expect(w.sent).toHaveLength(1)
        expect(w.sent[0]).toMatch(/^resume-aws-lambda-812-1-\d+$/)
        expect((await getTask()).status).toBe("pr_feedback")
        const delivered = await eventsOf("feedback_round_delivered")
        expect(delivered.map((e) => e.data)).toEqual([
            { round: 1, items: ["gh-rc-1001"], via: "pr_reopened" },
        ])

        // the dead round-1 key is never retried
        await watcher.pollTask(1)
        expect(w.deliver.mock.calls.map((c) => c[2].dedupeKey)).toEqual([
            "round-aws-lambda-812-1",
            expect.stringMatching(/^resume-aws-lambda-812-1-\d+$/),
        ])
        expect((await getTask()).flags.error || null).toBeNull()
    })

    test("reopen: failed resend is recorded; nothing open just logs the reopen", async () => {
        const w = outboxWorker()
        const { gh, watcher, notifier } = await claimedSetup({
            opts: { workerService: w },
        })
        gh.prs[`${REPO}#812`] = fullPr()
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        await watcher.pollTask(1)
        gh.prs[`${REPO}#812`] = closedPr()
        await watcher.pollTask(1)
        w.deliver.mockResolvedValueOnce({
            status: "failed",
            error: "pane gone",
        })
        gh.prs[`${REPO}#812`] = fullPr()
        const s = await watcher.pollTask(1)
        expect(s.delivery).toBe("failed")
        const failed = await eventsOf("feedback_round_failed")
        expect(failed.map((e) => e.data)).toEqual([
            { round: 1, items: ["gh-rc-1001"], error: "pane gone" },
        ])
        expect(notifier.notify).toHaveBeenCalled()

        // resolved (with its thread reply) meanwhile, closed and reopened
        // again: verified, no prompt
        await resolve("gh-rc-1001", { status: "answered", reply_url: "r" })
        gh.rcs[`${REPO}#812`] = [
            rc(1001),
            rc(1002, {
                in_reply_to_id: 1001,
                user: { login: "leo", type: "User" },
                created_at: "2026-11-07T12:30:00Z",
            }),
        ]
        gh.prs[`${REPO}#812`] = closedPr()
        await watcher.pollTask(1)
        const calls = w.deliver.mock.calls.length
        gh.prs[`${REPO}#812`] = fullPr()
        const s2 = await watcher.pollTask(1)
        expect(s2.reopened_prs).toEqual([PR_URL])
        expect(w.deliver.mock.calls.length).toBe(calls)
        expect(await eventsOf("pr_reopened")).toHaveLength(2)
    })

    test("reopen: an item verification reopens gets only its reverify prompt", async () => {
        const w = outboxWorker()
        w.agent = "idle"
        const { gh, watcher } = await claimedSetup({
            opts: { workerService: w },
        })
        gh.prs[`${REPO}#812`] = fullPr()
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        await watcher.pollTask(1)
        // answered without the thread reply, then closed and reopened
        await resolve("gh-rc-1001", { status: "answered", reply_url: "r" })
        gh.prs[`${REPO}#812`] = closedPr()
        await watcher.pollTask(1)
        gh.prs[`${REPO}#812`] = fullPr()
        const s = await watcher.pollTask(1)
        expect(s.reopened).toBe(1)
        expect(s.reopened_prs).toEqual([PR_URL])
        expect(w.sent).toEqual([
            "round-aws-lambda-812-1",
            "reverify-aws-lambda-812-gh-rc-1001",
        ])
    })

    test("reopen clears the closed flag only when no other PR is still closed; other reasons stay", async () => {
        const { gh, watcher, claims } = await setup({
            status: "pr_open",
            deliverables: [
                deliv(REPO, {
                    disposition: "pr",
                    pr: PR_URL,
                    claimed_at: "2026-11-07T11:00:00.000Z",
                }),
                deliv(REPO2, {
                    disposition: "pr",
                    pr: PR2_URL,
                    claimed_at: "2026-11-07T11:00:00.000Z",
                }),
            ],
        })
        claims.claim({
            url: PR2_URL,
            task_id: 1,
            repo: REPO2,
            number: 44,
            branch: "t1-fix",
        })
        const pr2 = (over = {}) => fullPr({ url: PR2_URL, number: 44, ...over })
        gh.prs[`${REPO}#812`] = closedPr()
        gh.prs[`${REPO2}#44`] = pr2({
            state: "CLOSED",
            closedAt: "2026-11-07T12:00:00Z",
        })
        await watcher.pollTask(1)
        expect((await getTask()).flags.now_reason).toBe(
            "PR closed without merge"
        )
        // one PR reopens, the other is still closed: flag stays
        gh.prs[`${REPO}#812`] = fullPr()
        await watcher.pollTask(1)
        expect((await getTask()).flags.now_reason).toBe(
            "PR closed without merge"
        )
        // the second reopens too: flag cleared
        gh.prs[`${REPO2}#44`] = pr2()
        await watcher.pollTask(1)
        expect((await getTask()).flags).toMatchObject({
            now: false,
            now_reason: null,
        })
        // an unrelated Now reason survives a close/reopen of a PR
        gh.prs[`${REPO}#812`] = closedPr()
        await watcher.pollTask(1)
        await store.updateTask(
            1,
            { flags: { now: true, now_reason: "Agent needs you" } },
            { actor: "me" }
        )
        gh.prs[`${REPO}#812`] = fullPr()
        await watcher.pollTask(1)
        expect((await getTask()).flags.now_reason).toBe("Agent needs you")
    })

    test("reopen without delivery wired only records the reopen", async () => {
        const { gh, watcher } = await claimedSetup({
            opts: { workerService: null },
        })
        gh.prs[`${REPO}#812`] = fullPr()
        gh.rcs[`${REPO}#812`] = [rc(1001)]
        await watcher.pollTask(1)
        gh.prs[`${REPO}#812`] = closedPr()
        await watcher.pollTask(1)
        expect((await getTask()).flags).toMatchObject({
            now: true,
            now_reason: "PR closed without merge",
        })
        gh.prs[`${REPO}#812`] = fullPr()
        const s = await watcher.pollTask(1)
        expect(s.reopened_prs).toEqual([PR_URL])
        expect((await getTask()).flags.now_reason).not.toBe(
            "PR closed without merge"
        )
        expect(await eventsOf("feedback_round_delivered")).toHaveLength(0)
        expect(await eventsOf("feedback_round_failed")).toHaveLength(0)
    })
})

describe("errors, scheduling and pollAll", () => {
    test("skips other statuses and unknown tasks", async () => {
        const { watcher } = await setup({ status: "active" })
        expect((await watcher.pollTask(1)).skipped).toBe("status active")
        const missing = await watcher.pollTask(42)
        expect(missing.error).toMatch(/not found/)
    })

    test("gh errors are recorded per task and cleared on success", async () => {
        const { gh, watcher } = await setup()
        gh.listError = new Error("gh offline")
        const s = await watcher.pollTask(1)
        expect(s.errors).toEqual(["aws-lambda: gh offline"])
        expect((await getTask()).flags.error).toBe(
            "PR watcher: aws-lambda: gh offline"
        )
        // same error again: no extra write
        await watcher.pollTask(1)
        gh.listError = null
        await watcher.pollTask(1)
        expect((await getTask()).flags.error).toBeNull()
    })

    test("a failing PR fetch does not stop the task poll", async () => {
        const { watcher } = await claimedSetup()
        const s = await watcher.pollTask(1)
        expect(s.errors).toEqual([`${PR_URL}: no pr aws-lambda#812`])
    })

    test("bad PR url on a deliverable", async () => {
        const { watcher } = await setup({
            status: "pr_open",
            deliverables: [
                deliv(REPO, {
                    disposition: "pr",
                    pr: "not-a-url",
                    claimed_at: "2026-11-07T11:00:00.000Z",
                }),
            ],
        })
        const s = await watcher.pollTask(1)
        expect(s.errors[0]).toMatch(/bad PR url/)
    })

    test("unexpected failures are caught and stored", async () => {
        const { watcher } = await claimedSetup()
        const spy = jest
            .spyOn(store, "listEvents")
            .mockRejectedValue(new Error("boom"))
        const real = store.listFeedback
        jest.spyOn(store, "listFeedback").mockImplementation(real)
        const s = await watcher.pollTask(1)
        spy.mockRestore()
        expect(s.error).toBe("boom")
        expect((await getTask()).flags.error).toBe("PR watcher: boom")
    })

    test("setError failure is only logged", async () => {
        const log = { warn: jest.fn(), debug() {}, info() {}, error() {} }
        const { gh, watcher } = await setup({ opts: { log } })
        gh.listError = new Error("x")
        jest.spyOn(store, "withTaskLock").mockRejectedValue(new Error("locked"))
        await watcher.pollTask(1)
        store.withTaskLock.mockRestore()
        expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ err: "locked" }),
            "cannot record PR error"
        )
    })

    test("side-channel failures (asana, notifier, bus) are swallowed", async () => {
        const log = { warn: jest.fn(), debug() {}, info() {}, error() {} }
        const { gh, watcher } = await claimedSetup({
            opts: {
                log,
                asanaService: {
                    comment: jest.fn().mockRejectedValue(new Error("asana")),
                },
                notifier: {
                    notify: jest.fn().mockRejectedValue(new Error("osa")),
                },
                bus: {
                    emit: () => {
                        throw new Error("bus")
                    },
                },
            },
        })
        gh.prs[`${REPO}#812`] = fullPr({
            state: "CLOSED",
            closedAt: "2026-11-07T11:59:00Z",
        })
        await watcher.pollTask(1)
        gh.prs[`${REPO}#812`] = fullPr({
            state: "MERGED",
            mergedAt: "2026-11-07T11:59:30Z",
        })
        await watcher.pollTask(1)
        const msgs = log.warn.mock.calls.map((c) => c[1])
        expect(msgs).toEqual(
            expect.arrayContaining([
                "asana comment failed",
                "notification failed",
                "bus listener failed",
            ])
        )
    })

    test("optional deps absent", async () => {
        const { gh, watcher } = await claimedSetup({
            asana: false,
            opts: { asanaService: null, notifier: null, bus: null },
        })
        gh.prs[`${REPO}#812`] = fullPr({
            state: "CLOSED",
            closedAt: "2026-11-07T11:59:00Z",
        })
        const s = await watcher.pollTask(1)
        expect(s.closed).toEqual([PR_URL])
    })

    test("concurrent pollTask calls coalesce", async () => {
        const { gh, watcher } = await setup()
        const a = watcher.pollTask(1)
        const b = watcher.pollTask("1")
        expect(a).toBe(b)
        await a
        expect(gh.listPrsByHead).toHaveBeenCalledTimes(1)
    })

    test("pollAll polls PR-state tasks and never overlaps", async () => {
        const { gh, watcher } = await setup()
        await store.createTask({ title: "other", status: "active" }, "me")
        const a = watcher.pollAll()
        expect(watcher.pollAll()).toBe(a)
        const res = await a
        expect(res.polled).toBe(1)
        expect(res.errors).toBe(0)
        expect(gh.listPrsByHead).toHaveBeenCalledTimes(1)
        gh.listError = new Error("x")
        expect((await watcher.pollAll()).errors).toBe(1)
    })

    test("pollAll survives query and poll failures", async () => {
        const { watcher } = await setup()
        const spy = jest.spyOn(store, "query").mockImplementation(() => {
            throw new Error("db")
        })
        expect(await watcher.pollAll()).toMatchObject({
            polled: 0,
            errors: 1,
            error: "db",
        })
        spy.mockReturnValue({})
        expect((await watcher.pollAll()).polled).toBe(0)
        spy.mockReturnValue({ tasks: [{ id: 1 }] })
        const real = store.getTask
        jest.spyOn(store, "getTask").mockImplementation(async () => {
            throw new Error("gone")
        })
        const r = await watcher.pollAll()
        expect(r.errors).toBe(1)
        store.getTask.mockImplementation(real)
        spy.mockRestore()
    })

    test("pollAll counts a rejected pollTask", async () => {
        const { watcher } = await setup()
        // A watcher whose store.getTask throws synchronously inside serial
        const brokenStore = {
            ...store,
            query: () => ({ tasks: [{ id: 1 }] }),
            getTask: () => Promise.resolve({ task: null }),
        }
        const w = createPrWatcher({
            store: brokenStore,
            gh: {},
            claims: {},
            db,
            clock,
            org: ORG,
        })
        const r = await w.pollAll()
        expect(r.errors).toBe(1)
        expect(r.results[0].task_id).toBe(1)
        expect(watcher).toBeTruthy()
    })

    test("stop() waits for the poll in progress and skips the remaining tasks", async () => {
        const { gh, watcher } = await setup()
        // a second polled task
        await store.createTask(
            {
                title: "Other",
                kind: "agent_task",
                status: "ready_for_pr",
                branch: "t2-other",
                slug: "zz99",
                deliverables: [deliv(REPO)],
            },
            "me"
        )
        let release
        const gate = new Promise((r) => (release = r))
        gh.listPrsByHead.mockImplementationOnce(async () => {
            await gate
            return []
        })
        const cycle = watcher.pollAll()
        await new Promise((r) => setImmediate(r))
        let stopped = false
        const stopping = watcher.stop().then(() => (stopped = true))
        await new Promise((r) => setImmediate(r))
        expect(stopped).toBe(false) // still waiting on the slow gh call
        release()
        await stopping
        const r = await cycle
        expect(stopped).toBe(true)
        expect(r.results).toHaveLength(1) // the second task was not started
        expect(gh.listPrsByHead).toHaveBeenCalledTimes(1)
        // a queued claim is drained too
        watcher.start()
        const claimP = watcher.claim(1, "not a url")
        await watcher.stop()
        expect(await claimP).toEqual({ ok: false, reason: "invalid_url" })
    })

    test("start/stop timer re-reads github.poll_minutes each cycle", async () => {
        const { gh, watcher, settingsRepo } = await setup({
            opts: { startDelayMs: 1000, pollMinutes: 15 },
        })
        watcher.start()
        watcher.start() // no-op
        await clock.advance(1000)
        expect(gh.listPrsByHead).toHaveBeenCalledTimes(1)
        settingsRepo.set("github.poll_minutes", 2)
        // the next delay was computed before the change: 15 min
        await clock.advance(15 * 60000)
        expect(gh.listPrsByHead).toHaveBeenCalledTimes(2)
        await clock.advance(2 * 60000)
        expect(gh.listPrsByHead).toHaveBeenCalledTimes(3)
        settingsRepo.set("github.poll_minutes", "junk")
        await clock.advance(2 * 60000)
        expect(gh.listPrsByHead).toHaveBeenCalledTimes(4)
        await clock.advance(14 * 60000)
        expect(gh.listPrsByHead).toHaveBeenCalledTimes(4)
        watcher.stop()
        await clock.advance(60 * 60000)
        expect(gh.listPrsByHead).toHaveBeenCalledTimes(4)
        watcher.stop()
    })

    test("timer without settings and with a broken settings repo", async () => {
        const log = { warn: jest.fn(), debug() {}, info() {}, error() {} }
        const { gh, watcher } = await setup({
            opts: {
                settingsRepo: {
                    get: () => {
                        throw new Error("bad")
                    },
                },
                log,
                pollMinutes: 1,
                startDelayMs: 0,
            },
        })
        watcher.start()
        await clock.advance(0)
        await clock.advance(60000)
        expect(gh.listPrsByHead).toHaveBeenCalledTimes(2)
        expect(log.warn).toHaveBeenCalledWith(
            { err: "bad" },
            "poll_minutes setting unreadable"
        )
        watcher.stop()

        const w2 = (
            await setup({ opts: { settingsRepo: null, pollMinutes: 1 } })
        ).watcher
        w2.start()
        await clock.advance(5000 + 60000)
        w2.stop()
    })

    test("a throwing cycle keeps the timer alive", async () => {
        const log = { warn: jest.fn(), debug() {}, info() {}, error() {} }
        const { watcher } = await setup({
            opts: { log, startDelayMs: 10, pollMinutes: 1 },
        })
        const spy = jest.spyOn(store, "query").mockImplementation(() => {
            throw new Error("q")
        })
        watcher.start()
        await clock.advance(10)
        await clock.advance(60000)
        expect(spy).toHaveBeenCalledTimes(2)
        spy.mockRestore()
        watcher.stop()
    })
})
