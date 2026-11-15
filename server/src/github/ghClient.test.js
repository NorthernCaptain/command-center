/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import {
    createGhClient,
    defaultExec,
    normalizeCheck,
    normalizePr,
} from "./ghClient.js"

const RAW_PR = {
    number: 812,
    url: "https://github.com/acme/aws-lambda/pull/812",
    headRefName: "t1-fix",
    headRepository: {
        name: "aws-lambda",
        nameWithOwner: "acme/aws-lambda",
    },
    headRepositoryOwner: { login: "acme" },
    isCrossRepository: false,
    createdAt: "2026-11-07T12:00:00Z",
    body: "Command-Center-Task: T-1",
    state: "OPEN",
    mergedAt: null,
    closedAt: null,
    headRefOid: "abcdef1234567",
    author: { login: "leo", is_bot: false },
}

function fakeExec(routes) {
    return jest.fn(async (file, args) => {
        const key = args.slice(0, 2).join(" ")
        const path = args[0] === "api" ? args[1] : null
        for (const [match, value] of routes) {
            if (
                (typeof match === "string" &&
                    (key === match || path === match)) ||
                (match instanceof RegExp && match.test(path || key))
            )
                return typeof value === "function" ? value(args) : value
        }
        throw new Error(`unexpected ${file} ${args.join(" ")}`)
    })
}

describe("normalize", () => {
    test("normalizePr falls back on nameWithOwner and owner shapes", () => {
        const a = normalizePr({
            ...RAW_PR,
            headRepositoryOwner: undefined,
            body: undefined,
            author: undefined,
        })
        expect(a.headRepository).toEqual({
            name: "aws-lambda",
            owner: "acme",
        })
        expect(a.body).toBe("")
        expect(a.author).toEqual({ login: null, is_bot: false })
        expect(
            normalizePr({
                headRepository: { name: "x", owner: { login: "o" } },
            }).headRepository.owner
        ).toBe("o")
        expect(
            normalizePr({ headRepository: { name: "x", owner: "o2" } })
                .headRepository.owner
        ).toBe("o2")
        const empty = normalizePr({})
        expect(empty.headRepository).toEqual({ name: null, owner: null })
        expect(empty.state).toBeNull()
    })

    test("normalizeCheck handles CheckRun and StatusContext", () => {
        expect(
            normalizeCheck({
                __typename: "CheckRun",
                name: "unit",
                status: "COMPLETED",
                conclusion: "FAILURE",
                detailsUrl: "u",
                workflowName: "ci",
            })
        ).toEqual({
            name: "unit",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "u",
            workflowName: "ci",
        })
        expect(normalizeCheck({})).toEqual({
            name: "check",
            status: null,
            conclusion: null,
            detailsUrl: null,
            workflowName: null,
        })
        expect(
            normalizeCheck({
                __typename: "StatusContext",
                context: "ci/x",
                state: "ERROR",
                targetUrl: "t",
            })
        ).toMatchObject({
            name: "ci/x",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "t",
        })
        expect(
            normalizeCheck({ __typename: "StatusContext", state: "PENDING" })
        ).toMatchObject({
            name: "status",
            status: "IN_PROGRESS",
            conclusion: null,
            detailsUrl: null,
        })
        expect(
            normalizeCheck({ __typename: "StatusContext", state: "success" })
                .conclusion
        ).toBe("SUCCESS")
    })
})

describe("createGhClient", () => {
    test("without an org every call fails with a clear error", async () => {
        const exec = jest.fn()
        const gh = createGhClient({ exec })
        await expect(gh.listPrsByHead("aws-lambda", "b")).rejects.toThrow(
            /set github.org in config.json/
        )
        expect(exec).not.toHaveBeenCalled()
        expect(() => createGhClient()).not.toThrow()
    })

    test("listPrsByHead builds the gh pr list call", async () => {
        const exec = fakeExec([["pr list", JSON.stringify([RAW_PR])]])
        const gh = createGhClient({ exec, org: "acme", ghBin: "ghx" })
        const prs = await gh.listPrsByHead("aws-lambda", "t1-fix")
        expect(prs[0]).toMatchObject({
            number: 812,
            headRepository: { name: "aws-lambda", owner: "acme" },
            author: { login: "leo" },
        })
        const [file, args] = exec.mock.calls[0]
        expect(file).toBe("ghx")
        expect(args).toEqual(
            expect.arrayContaining([
                "--repo",
                "acme/aws-lambda",
                "--head",
                "t1-fix",
                "--state",
                "all",
            ])
        )
        expect(args[args.indexOf("--json") + 1]).toContain(
            "headRepositoryOwner"
        )
    })

    test("listPrsByHead tolerates non-array and {stdout} output", async () => {
        const exec = fakeExec([["pr list", { stdout: "{}" }]])
        const gh = createGhClient({ exec, org: "o" })
        expect(await gh.listPrsByHead("r", "b")).toEqual([])
        const exec2 = fakeExec([["pr list", ""]])
        const gh2 = createGhClient({ exec: exec2, org: "o" })
        expect(await gh2.listPrsByHead("r", "b")).toEqual([])
    })

    test("invalid JSON is an error", async () => {
        const exec = fakeExec([["pr list", "not json"]])
        const gh = createGhClient({ exec, org: "o" })
        await expect(gh.listPrsByHead("r", "b")).rejects.toThrow(
            /pr list: invalid JSON/
        )
    })

    test("getPr merges pr view with REST reviews and comments", async () => {
        const exec = fakeExec([
            [
                "pr view",
                JSON.stringify({
                    ...RAW_PR,
                    reviewDecision: "CHANGES_REQUESTED",
                    statusCheckRollup: [
                        {
                            __typename: "CheckRun",
                            name: "unit",
                            status: "COMPLETED",
                            conclusion: "FAILURE",
                        },
                    ],
                    commits: [
                        {
                            oid: "abc1234",
                            committedDate: "2026-11-07T13:00:00Z",
                        },
                        { oid: "def5678" },
                    ],
                }),
            ],
            [
                /pulls\/812\/reviews/,
                JSON.stringify([
                    [
                        {
                            id: 11,
                            user: { login: "ron", type: "User" },
                            state: "CHANGES_REQUESTED",
                            body: "fix",
                            submitted_at: "2026-11-07T13:00:00Z",
                            html_url: "rv",
                            commit_id: "abc",
                        },
                    ],
                    [{ id: 12 }],
                ]),
            ],
            [
                /issues\/812\/comments/,
                JSON.stringify([
                    [
                        {
                            id: 21,
                            user: { login: "ann", type: "User" },
                            body: "hi",
                            created_at: "2026-11-07T14:00:00Z",
                            html_url: "ic",
                        },
                        { id: 22, user: null },
                    ],
                ]),
            ],
        ])
        const gh = createGhClient({ exec, org: "acme" })
        const pr = await gh.getPr("aws-lambda", 812)
        expect(pr.reviewDecision).toBe("CHANGES_REQUESTED")
        expect(pr.statusCheckRollup[0]).toMatchObject({
            name: "unit",
            conclusion: "FAILURE",
        })
        expect(pr.reviews).toEqual([
            {
                id: 11,
                author: { login: "ron", type: "User" },
                state: "CHANGES_REQUESTED",
                body: "fix",
                submittedAt: "2026-11-07T13:00:00Z",
                url: "rv",
                commitId: "abc",
            },
            {
                id: 12,
                author: { login: null, type: null },
                state: null,
                body: "",
                submittedAt: null,
                url: null,
                commitId: null,
            },
        ])
        expect(pr.comments[0]).toEqual({
            id: 21,
            author: { login: "ann", type: "User" },
            body: "hi",
            createdAt: "2026-11-07T14:00:00Z",
            url: "ic",
        })
        expect(pr.comments[1].author).toEqual({ login: null, type: null })
        expect(pr.commits).toEqual([
            { oid: "abc1234", committedDate: "2026-11-07T13:00:00Z" },
            { oid: "def5678", committedDate: null },
        ])
        const apiCall = exec.mock.calls.find((c) => c[1][0] === "api")
        expect(apiCall[1]).toEqual(
            expect.arrayContaining(["--paginate", "--slurp"])
        )
    })

    test("getPr with minimal view output", async () => {
        const exec = fakeExec([
            ["pr view", JSON.stringify({ number: 1 })],
            [/reviews/, "null"],
            [/comments/, JSON.stringify([{ id: 5 }])],
        ])
        const gh = createGhClient({ exec, org: "o" })
        const pr = await gh.getPr("r", 1)
        expect(pr.statusCheckRollup).toEqual([])
        expect(pr.reviews).toEqual([])
        expect(pr.comments).toHaveLength(1)
        expect(pr.commits).toEqual([])
        expect(pr.reviewDecision).toBeNull()
    })

    test("reviewComments maps the REST shape and passes since", async () => {
        const exec = fakeExec([
            [
                /pulls\/5\/comments/,
                JSON.stringify([
                    [
                        {
                            id: 1,
                            user: { login: "ron", type: "User" },
                            body: "b",
                            path: "a.js",
                            line: 3,
                            original_line: 3,
                            created_at: "t",
                            html_url: "h",
                            in_reply_to_id: null,
                            commit_id: "c",
                        },
                        { id: 2, in_reply_to_id: 1 },
                    ],
                ]),
            ],
        ])
        const gh = createGhClient({ exec, org: "o" })
        const rows = await gh.reviewComments("r", 5, {
            since: "2026-11-07T00:00:00Z",
        })
        expect(rows[0]).toEqual({
            id: 1,
            user: { login: "ron", type: "User" },
            body: "b",
            path: "a.js",
            line: 3,
            original_line: 3,
            created_at: "t",
            html_url: "h",
            in_reply_to_id: null,
            commit_id: "c",
        })
        expect(rows[1]).toMatchObject({
            id: 2,
            path: null,
            line: null,
            in_reply_to_id: 1,
            body: "",
        })
        expect(exec.mock.calls[0][1][1]).toContain(
            "since=2026-11-07T00%3A00%3A00Z"
        )
        await gh.reviewComments("r", 5)
        expect(exec.mock.calls[1][1][1]).not.toContain("since")
    })

    test("commitsSince filters by date", async () => {
        const exec = fakeExec([
            [
                "pr view",
                JSON.stringify({
                    commits: [
                        { oid: "a", committedDate: "2026-11-07T10:00:00Z" },
                        { oid: "b", committedDate: "2026-11-07T14:00:00Z" },
                        { oid: "c" },
                    ],
                }),
            ],
        ])
        const gh = createGhClient({ exec, org: "o" })
        expect(
            (await gh.commitsSince("r", 1, "2026-11-07T12:00:00Z")).map(
                (c) => c.oid
            )
        ).toEqual(["b"])
        expect((await gh.commitsSince("r", 1)).map((c) => c.oid)).toEqual([
            "a",
            "b",
            "c",
        ])
    })

    test("prComment calls gh pr comment", async () => {
        const exec = jest.fn(async () => "https://x/c/1\n")
        const gh = createGhClient({ exec, org: "o" })
        expect(await gh.prComment("r", 3, "hello")).toBe("https://x/c/1")
        expect(exec.mock.calls[0][1]).toEqual([
            "pr",
            "comment",
            "3",
            "--repo",
            "o/r",
            "--body",
            "hello",
        ])
        const exec2 = jest.fn(async () => ({ stdout: "x" }))
        const gh2 = createGhClient({ exec: exec2, org: "o" })
        expect(await gh2.prComment("r", 3, "b")).toEqual({ stdout: "x" })
    })

    test("graphql, login, mergePr and approvePr (PR reviews)", async () => {
        const exec = jest.fn(async (file, args) => {
            if (args[1] === "graphql")
                return JSON.stringify(
                    args.includes("name=broken")
                        ? { errors: [{ message: "Could not resolve" }] }
                        : args.includes("name=empty")
                          ? { errors: [{}] }
                          : { data: { repository: { id: 1 } } }
                )
            if (args[1] === "user") return JSON.stringify({ login: "leok" })
            if (args[1] === "-X")
                return JSON.stringify({ id: 5, state: "APPROVED" })
            return "merged\n"
        })
        const gh = createGhClient({ exec, org: "acme" })
        expect(gh.org).toBe("acme")
        expect(
            await gh.graphql("query { x }", { owner: "acme", name: "mobile" })
        ).toEqual({ repository: { id: 1 } })
        expect(exec).toHaveBeenCalledWith("gh", [
            "api",
            "graphql",
            "-f",
            "query=query { x }",
            "-f",
            "owner=acme",
            "-f",
            "name=mobile",
        ])
        await expect(gh.graphql("q", { name: "broken" })).rejects.toThrow(
            "gh graphql: Could not resolve"
        )
        await expect(gh.graphql("q", { name: "empty" })).rejects.toThrow(
            "gh graphql: error"
        )
        // gh exits 1 on a partial answer but prints the data
        const partial = createGhClient({
            exec: jest.fn(async (file, args) => {
                const err = new Error("Command failed: gh api graphql")
                if (args.includes("name=part"))
                    err.stdout = JSON.stringify({
                        data: { repository: { p1: null, p2: { number: 2 } } },
                        errors: [{ type: "NOT_FOUND" }],
                    })
                if (args.includes("name=nodata"))
                    err.stdout = JSON.stringify({ errors: [{}] })
                throw err
            }),
            org: "acme",
        })
        // any error rejects the answer, unless the caller takes parts
        await expect(partial.graphql("q", { name: "part" })).rejects.toThrow(
            "gh graphql: error"
        )
        expect(
            await partial.graphql("q", { name: "part" }, { partial: true })
        ).toEqual({
            data: { repository: { p1: null, p2: { number: 2 } } },
            errors: [{ type: "NOT_FOUND" }],
        })
        // exit 0 with data and field errors
        const fieldErr = createGhClient({
            exec: jest.fn(async () =>
                JSON.stringify({
                    data: { repository: { p3: { reviews: null } } },
                    errors: [
                        {
                            message: "reviews failed",
                            path: ["repository", "p3", "reviews"],
                        },
                    ],
                })
            ),
            org: "acme",
        })
        await expect(fieldErr.graphql("q")).rejects.toThrow(
            "gh graphql: reviews failed"
        )
        expect(
            (await fieldErr.graphql("q", {}, { partial: true })).errors
        ).toHaveLength(1)
        const empty = createGhClient({
            exec: jest.fn(async () => "{}"),
            org: "acme",
        })
        expect(await empty.graphql("q", {}, { partial: true })).toEqual({
            data: null,
            errors: [],
        })
        await expect(partial.graphql("q", { name: "nodata" })).rejects.toThrow(
            "Command failed"
        )
        await expect(partial.graphql("q", { name: "x" })).rejects.toThrow(
            "Command failed"
        )
        expect(await gh.login()).toBe("leok")
        expect(
            await gh.mergePr("mobile", 7, { method: "merge", headSha: "abc" })
        ).toBe("merged")
        expect(exec).toHaveBeenLastCalledWith("gh", [
            "pr",
            "merge",
            "7",
            "--repo",
            "acme/mobile",
            "--merge",
            "--delete-branch",
            "--match-head-commit",
            "abc",
        ])
        expect(await gh.approvePr("mobile", 7, { headSha: "abc" })).toEqual({
            id: 5,
            state: "APPROVED",
        })
        expect(exec).toHaveBeenLastCalledWith("gh", [
            "api",
            "-X",
            "POST",
            "repos/acme/mobile/pulls/7/reviews",
            "-f",
            "event=APPROVE",
            "-f",
            "commit_id=abc",
        ])
        await gh.approvePr("mobile", 8)
        expect(exec.mock.calls.at(-1)[1]).toEqual([
            "api",
            "-X",
            "POST",
            "repos/acme/mobile/pulls/8/reviews",
            "-f",
            "event=APPROVE",
        ])
        await gh.mergePr("mobile", 8)
        expect(exec.mock.calls.at(-1)[1]).toEqual([
            "pr",
            "merge",
            "8",
            "--repo",
            "acme/mobile",
            "--merge",
            "--delete-branch",
        ])
        const nobody = createGhClient({
            exec: jest.fn(async () => "{}"),
            org: "acme",
        })
        await expect(nobody.login()).rejects.toThrow("no login")
        expect(await nobody.graphql("q")).toBeNull()
        const objOut = createGhClient({
            exec: jest.fn(async () => ({ stdout: "x" })),
            org: "acme",
        })
        expect(await objOut.mergePr("r", 1)).toEqual({ stdout: "x" })
    })

    test("defaultExec runs a real process", async () => {
        const out = await defaultExec(process.execPath, [
            "-e",
            "process.stdout.write('ok')",
        ])
        expect(out).toBe("ok")
    })
})
