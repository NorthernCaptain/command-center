/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    CLOSED_PRS_QUERY,
    OPEN_PRS_QUERY,
    classifyPr,
    commentsBeforeQuery,
    isBotAuthor,
    normalizeNode,
    olderCommentsNeeded,
    prsByNumberQuery,
    stackedBase,
} from "./prScan.js"

const ME = "leok"
const user = (login) => ({ __typename: "User", login })

/** A GraphQL PR node (PR_FIELDS shape). */
export function prNode(over = {}) {
    return {
        number: 417,
        url: "https://github.com/acme/mobile/pull/417",
        title: "Fix the login flow",
        isDraft: false,
        baseRefName: "main",
        headRefOid: "bbb2222",
        createdAt: "2026-11-10T10:00:00Z",
        updatedAt: "2026-11-12T10:00:00Z",
        mergedAt: null,
        closedAt: null,
        state: "OPEN",
        additions: 10,
        deletions: 2,
        changedFiles: 3,
        mergeable: "MERGEABLE",
        reviewDecision: null,
        author: user("dev1"),
        reviews: { nodes: [] },
        commits: {
            nodes: [
                {
                    commit: {
                        oid: "bbb2222",
                        committedDate: "2026-11-12T09:00:00Z",
                        statusCheckRollup: { state: "SUCCESS" },
                    },
                },
            ],
        },
        comments: { nodes: [] },
        activity: { nodes: [] },
        ...over,
    }
}

const review = (
    login,
    state,
    at,
    commit = "aaa1111",
    id = `${login}-${at}`
) => ({
    id,
    author: user(login),
    state,
    submittedAt: at,
    commit: { oid: commit },
})

const classify = (over, opts = {}) =>
    classifyPr(normalizeNode(prNode(over)), { me: ME, ...opts })

describe("queries", () => {
    test("open, closed and by-number queries carry the PR fields", () => {
        expect(OPEN_PRS_QUERY).toContain("states: OPEN")
        expect(CLOSED_PRS_QUERY).toContain("states: [MERGED, CLOSED]")
        const q = prsByNumberQuery([417, "12", 0, "x", -3])
        expect(q).toContain("p417: pullRequest(number: 417)")
        expect(q).toContain("p12: pullRequest(number: 12)")
        expect(q).not.toContain("p0:")
        expect(q).toContain("comments(last: 100)")
        expect(q).not.toContain("authorActivity")
        // with the author: its own reviews (thread replies) by filter
        const withAuthor = prsByNumberQuery([{ number: 5, author: "dev1" }])
        expect(withAuthor).toContain(
            'authorActivity: reviews(last: 50, author: "dev1")'
        )
        expect(prsByNumberQuery([{ number: 0, author: "x" }])).not.toContain(
            "pullRequest("
        )
        expect(commentsBeforeQuery(417)).toContain("pullRequest(number: 417) {")
        expect(commentsBeforeQuery(417)).toContain(
            "comments(last: 100, before: $before)"
        )
    })
})

describe("olderCommentsNeeded", () => {
    const cr = (at) => ({
        author: user("leok"),
        state: "CHANGES_REQUESTED",
        submittedAt: at,
    })
    const nodeWith = (reviews, comments, page) => ({
        reviews: { nodes: reviews },
        comments: { nodes: comments, pageInfo: page },
    })
    const more = { hasPreviousPage: true, startCursor: "c1" }
    const later = [{ createdAt: "2026-11-12T12:00:00Z" }, null]
    test("only while our change request stands and the page starts after it", () => {
        expect(
            olderCommentsNeeded(
                nodeWith([cr("2026-11-12T10:00:00Z")], later, more),
                "leok"
            )
        ).toBe(true)
        // the page reaches back before our review
        expect(
            olderCommentsNeeded(
                nodeWith(
                    [cr("2026-11-12T10:00:00Z")],
                    [{ createdAt: "2026-11-12T09:00:00Z" }],
                    more
                ),
                "leok"
            )
        ).toBe(false)
        // nothing older, no decision, approved, no page info
        expect(
            olderCommentsNeeded(
                nodeWith([cr("2026-11-12T10:00:00Z")], later, {
                    hasPreviousPage: false,
                }),
                "leok"
            )
        ).toBe(false)
        expect(olderCommentsNeeded(nodeWith([], later, more), "leok")).toBe(
            false
        )
        expect(
            olderCommentsNeeded(
                nodeWith(
                    [
                        {
                            ...cr("2026-11-12T10:00:00Z"),
                            state: "APPROVED",
                        },
                        null,
                    ],
                    later,
                    more
                ),
                "leok"
            )
        ).toBe(false)
        expect(olderCommentsNeeded({}, "leok")).toBe(false)
        expect(
            olderCommentsNeeded(
                nodeWith([cr("2026-11-12T10:00:00Z")], [], more),
                "leok"
            )
        ).toBe(false)
    })
})

describe("isBotAuthor", () => {
    test("GraphQL bots, [bot] logins, configured names, deleted accounts", () => {
        expect(isBotAuthor({ __typename: "Bot", login: "renovate" })).toBe(true)
        expect(isBotAuthor(user("dependabot[bot]"))).toBe(true)
        expect(isBotAuthor(user("ci-helper"), ["CI-Helper"])).toBe(true)
        expect(isBotAuthor(user("dev1"))).toBe(false)
        expect(isBotAuthor(null)).toBe(true)
    })
})

describe("normalizeNode", () => {
    test("flattens the node", () => {
        const pr = normalizeNode(
            prNode({
                reviews: {
                    nodes: [
                        review("leok", "APPROVED", "2026-11-12T11:00:00Z"),
                        null,
                    ],
                },
                comments: {
                    nodes: [
                        {
                            author: user("dev1"),
                            createdAt: "2026-11-12T12:00:00Z",
                        },
                    ],
                },
                // a thread reply is a review of its author
                activity: {
                    nodes: [
                        {
                            author: { __typename: "Bot", login: "lint" },
                            submittedAt: "2026-11-12T12:30:00Z",
                        },
                        null,
                    ],
                },
            })
        )
        expect(pr).toMatchObject({
            number: 417,
            author: "dev1",
            author_bot: false,
            base: "main",
            head_sha: "bbb2222",
            head_committed_at: "2026-11-12T09:00:00Z",
            ci_state: "SUCCESS",
            mergeable: "MERGEABLE",
            changed_files: 3,
        })
        expect(pr.reviews).toEqual([
            {
                id: "leok-2026-11-12T11:00:00Z",
                login: "leok",
                state: "APPROVED",
                submittedAt: "2026-11-12T11:00:00Z",
                commit: "aaa1111",
            },
        ])
        expect(pr.comments).toEqual([
            { login: "dev1", bot: false, createdAt: "2026-11-12T12:00:00Z" },
            { login: "lint", bot: true, createdAt: "2026-11-12T12:30:00Z" },
        ])
    })

    test("missing parts get defaults", () => {
        const pr = normalizeNode({ number: 5, author: null })
        expect(pr).toMatchObject({
            number: 5,
            url: null,
            title: "",
            author: null,
            author_bot: true,
            head_sha: null,
            state: "OPEN",
            ci_state: null,
            reviews: [],
            comments: [],
            review_requests: [],
            review_requested: [],
        })
    })
})

describe("classifyPr", () => {
    test("no review of ours: new", () => {
        const c = classify({
            reviews: {
                nodes: [review("dev2", "APPROVED", "2026-11-11T10:00:00Z")],
            },
        })
        expect(c).toMatchObject({
            decision: null,
            attempts: 0,
            needs_review: "new",
            eligible: true,
            first_review_at: null,
            trigger_key: "new:bbb2222:",
        })
    })

    test("our latest decision wins; comment-only reviews never count", () => {
        const c = classify({
            headRefOid: "ccc3333",
            reviews: {
                nodes: [
                    review(
                        "leok",
                        "CHANGES_REQUESTED",
                        "2026-11-11T10:00:00Z",
                        "aaa1111"
                    ),
                    review(
                        "leok",
                        "COMMENTED",
                        "2026-11-11T11:00:00Z",
                        "aaa1111"
                    ),
                    review(
                        "LeoK",
                        "APPROVED",
                        "2026-11-12T10:00:00Z",
                        "ccc3333"
                    ),
                    review(
                        "leok",
                        "COMMENTED",
                        "2026-11-12T11:00:00Z",
                        "ccc3333"
                    ),
                ],
            },
        })
        expect(c).toMatchObject({
            decision: "approved",
            decided_at: "2026-11-12T10:00:00Z",
            decided_sha: "ccc3333",
            first_review_at: "2026-11-11T10:00:00Z",
            attempts: 2,
            needs_review: null,
            trigger_key: null,
        })
        expect(c.decisions.map((d) => d.state)).toEqual([
            "CHANGES_REQUESTED",
            "APPROVED",
        ])
    })

    test("first review: our earliest review, a comment-only one too", () => {
        const c = classify({
            reviews: {
                nodes: [review("leok", "APPROVED", "2026-11-12T10:00:00Z")],
            },
            firstOwn: { nodes: [{ submittedAt: "2026-11-11T09:00:00Z" }] },
        })
        expect(c).toMatchObject({
            decision: "approved",
            first_review_at: "2026-11-11T09:00:00Z",
        })
        // a comment-only review and no decision yet: still a first review
        expect(
            classify({
                firstOwn: { nodes: [{ submittedAt: "2026-11-11T09:00:00Z" }] },
            }).first_review_at
        ).toBe("2026-11-11T09:00:00Z")
        expect(classify({}).first_review_at).toBeNull()
        expect(
            normalizeNode(prNode({ firstOwn: { nodes: [] } })).first_own_at
        ).toBeNull()
    })

    test("a dismissed review counts as an attempt but not as the decision", () => {
        const c = classify({
            reviews: {
                nodes: [
                    review(
                        "leok",
                        "CHANGES_REQUESTED",
                        "2026-11-11T10:00:00Z",
                        "bbb2222"
                    ),
                    review(
                        "leok",
                        "DISMISSED",
                        "2026-11-11T12:00:00Z",
                        "bbb2222"
                    ),
                ],
            },
        })
        expect(c).toMatchObject({
            decision: "changes_requested",
            attempts: 2,
            needs_review: null,
        })
    })

    test("changes requested + a new head commit: re-review", () => {
        const c = classify({
            reviews: {
                nodes: [
                    review(
                        "leok",
                        "CHANGES_REQUESTED",
                        "2026-11-11T10:00:00Z",
                        "aaa1111"
                    ),
                ],
            },
        })
        expect(c).toMatchObject({
            decision: "changes_requested",
            needs_review: "re_review",
            last_activity_at: "2026-11-12T09:00:00Z",
            trigger_key: "re_review:bbb2222:",
        })
    })

    test("changes requested + a new comment by someone else: re-review", () => {
        const at = "2026-11-12T13:00:00Z"
        const c = classify({
            reviews: {
                nodes: [
                    review(
                        "leok",
                        "CHANGES_REQUESTED",
                        "2026-11-12T10:00:00Z",
                        "bbb2222"
                    ),
                ],
            },
            comments: {
                nodes: [
                    // ours, before the answer
                    { author: user("leok"), createdAt: "2026-11-12T12:00:00Z" },
                    {
                        author: user("dependabot[bot]"),
                        createdAt: "2026-11-12T15:00:00Z",
                    },
                    { author: user("dev1"), createdAt: "2026-11-12T09:30:00Z" },
                ],
            },
            activity: {
                nodes: [{ author: user("dev1"), submittedAt: at }],
            },
        })
        expect(c).toMatchObject({
            needs_review: "re_review",
            last_activity_at: at,
            trigger_key: `re_review:bbb2222:${at}`,
        })
    })

    test("another reviewer's review or comment after ours: no re-review", () => {
        const c = classify({
            reviews: {
                nodes: [
                    review(
                        "leok",
                        "CHANGES_REQUESTED",
                        "2026-11-12T10:00:00Z",
                        "bbb2222"
                    ),
                ],
            },
            comments: {
                nodes: [
                    { author: user("dev2"), createdAt: "2026-11-12T12:00:00Z" },
                ],
            },
            activity: {
                nodes: [
                    {
                        author: user("dev2"),
                        submittedAt: "2026-11-12T13:00:00Z",
                    },
                ],
            },
        })
        expect(c.needs_review).toBeNull()
        // the author (dev1) answering is
        expect(
            classify({
                reviews: {
                    nodes: [
                        review(
                            "leok",
                            "CHANGES_REQUESTED",
                            "2026-11-12T10:00:00Z",
                            "bbb2222"
                        ),
                    ],
                },
                activity: {
                    nodes: [
                        {
                            author: user("Dev1"),
                            submittedAt: "2026-11-12T13:00:00Z",
                        },
                    ],
                },
            }).needs_review
        ).toBe("re_review")
    })

    test("a re-review seen before stands when its answer left the fetched window", () => {
        const decided = review(
            "leok",
            "CHANGES_REQUESTED",
            "2026-11-12T10:00:00Z",
            "bbb2222"
        )
        const prev = {
            needs_review: "re_review",
            decided_at: "2026-11-12T10:00:00Z",
            trigger_key: "re_review:bbb2222:2026-11-12T13:00:00Z",
            last_activity_at: "2026-11-12T13:00:00Z",
        }
        // the author's answer is no longer among the newest comments
        const c = classify({ reviews: { nodes: [decided] } }, { prev })
        expect(c).toMatchObject({
            needs_review: "re_review",
            trigger_key: prev.trigger_key,
            last_activity_at: prev.last_activity_at,
        })
        // a newer decision of ours: the old answer is settled
        expect(
            classify(
                { reviews: { nodes: [decided] } },
                { prev: { ...prev, decided_at: "2026-11-01T00:00:00Z" } }
            ).needs_review
        ).toBeNull()
        // a new head too: the key keeps the answer time (same state, no
        // second run for it)
        expect(
            classify(
                { headRefOid: "ccc3333", reviews: { nodes: [decided] } },
                {
                    prev: {
                        ...prev,
                        trigger_key: "re_review:ccc3333:2026-11-12T13:00:00Z",
                    },
                }
            ).trigger_key
        ).toBe("re_review:ccc3333:2026-11-12T13:00:00Z")
        // nothing seen before: no re-review
        expect(
            classify({ reviews: { nodes: [decided] } }).needs_review
        ).toBeNull()
    })

    test("we replied after the author's answer: no re-review until the author answers again", () => {
        const cr = review(
            "leok",
            "CHANGES_REQUESTED",
            "2026-11-11T18:51:41Z",
            "bbb2222"
        )
        const answer = {
            nodes: [
                { author: user("dev1"), submittedAt: "2026-11-11T21:30:05Z" },
            ],
        }
        // our comment-only review after the answer
        expect(
            classify({
                reviews: { nodes: [cr] },
                authorActivity: answer,
                lastOwn: { nodes: [{ submittedAt: "2026-11-11T22:40:10Z" }] },
            }).needs_review
        ).toBeNull()
        // our conversation comment after the answer
        expect(
            classify({
                reviews: { nodes: [cr] },
                authorActivity: answer,
                comments: {
                    nodes: [
                        {
                            author: user("leok"),
                            createdAt: "2026-11-11T22:00:00Z",
                        },
                    ],
                },
            }).needs_review
        ).toBeNull()
        // the author answers again after that
        expect(
            classify({
                reviews: { nodes: [cr] },
                authorActivity: {
                    nodes: [
                        ...answer.nodes,
                        {
                            author: user("dev1"),
                            submittedAt: "2026-11-11T23:00:00Z",
                        },
                    ],
                },
                lastOwn: { nodes: [{ submittedAt: "2026-11-11T22:40:10Z" }] },
            }).needs_review
        ).toBe("re_review")
        // our reply before the answer does not count
        expect(
            classify({
                reviews: { nodes: [cr] },
                authorActivity: answer,
                lastOwn: { nodes: [{ submittedAt: "2026-11-11T19:00:00Z" }] },
            }).needs_review
        ).toBe("re_review")
    })

    test("approved, new commits and still a requested reviewer: re-review of the head", () => {
        const requests = (...logins) => ({
            reviewRequests: {
                nodes: [
                    ...logins.map((l) => ({ requestedReviewer: user(l) })),
                    // a team request is nobody's login
                    { requestedReviewer: { __typename: "Team" } },
                    null,
                ],
            },
        })
        const approved = (commit) => ({
            reviews: {
                nodes: [
                    review("leok", "APPROVED", "2026-11-11T10:00:00Z", commit),
                ],
            },
            // the author's answers never change the key of this re-review
            comments: {
                nodes: [
                    { author: user("dev1"), createdAt: "2026-11-12T11:00:00Z" },
                ],
            },
        })
        const c = classify({ ...approved("aaa1111"), ...requests("LeoK") })
        expect(c).toMatchObject({
            decision: "approved",
            needs_review: "re_review",
            trigger_key: "re_review:bbb2222:",
        })
        // not requested: the approval stands
        expect(
            classify({ ...approved("aaa1111"), ...requests("dev2") })
                .needs_review
        ).toBeNull()
        expect(classify(approved("aaa1111")).needs_review).toBeNull()
        // requested, but our approval is of the head already
        expect(
            classify({ ...approved("bbb2222"), ...requests("leok") })
                .needs_review
        ).toBeNull()
        // a closed PR needs nothing
        expect(
            classify({
                ...approved("aaa1111"),
                ...requests("leok"),
                state: "CLOSED",
            }).needs_review
        ).toBeNull()
    })

    test("changes requested, then our review asked for again: re-review, keyed by the request", () => {
        const cr = (at = "2026-11-12T10:00:00Z") => ({
            reviews: {
                nodes: [review("leok", "CHANGES_REQUESTED", at, "bbb2222")],
            },
        })
        const asked = (pending, ...events) => ({
            reviewRequests: {
                nodes: pending.map((l) => ({ requestedReviewer: user(l) })),
            },
            reRequests: {
                nodes: [
                    ...events.map(([l, at]) => ({
                        createdAt: at,
                        requestedReviewer: user(l),
                    })),
                    // a team request, an empty node
                    {
                        createdAt: "2026-11-12T12:00:00Z",
                        requestedReviewer: {},
                    },
                    null,
                ],
            },
        })
        // asked again after our change request, no new commit or comment
        const c = classify({
            ...cr(),
            ...asked(
                ["LeoK"],
                ["leok", "2026-11-10T10:00:00Z"],
                ["leok", "2026-11-12T11:00:00Z"],
                ["dev2", "2026-11-12T11:30:00Z"]
            ),
        })
        expect(c).toMatchObject({
            needs_review: "re_review",
            rerequested_at: "2026-11-12T11:00:00Z",
            trigger_key: "re_review:bbb2222:2026-11-12T11:00:00Z",
            last_activity_at: "2026-11-12T11:00:00Z",
        })
        // the request was removed: not pending, no answer due
        const removed = classify({
            ...cr(),
            ...asked([], ["leok", "2026-11-12T11:00:00Z"]),
        })
        expect(removed).toMatchObject({
            needs_review: null,
            rerequested_at: null,
        })
        // ... also once that request was stored in the trigger key
        const prev = {
            decided_at: "2026-11-12T10:00:00Z",
            trigger_key: "re_review:bbb2222:2026-11-12T11:00:00Z",
        }
        expect(
            classify(
                { ...cr(), ...asked([], ["leok", "2026-11-12T11:00:00Z"]) },
                { prev }
            ).needs_review
        ).toBeNull()
        // still pending: the stored request keeps its key
        expect(
            classify(
                {
                    ...cr(),
                    ...asked(["leok"], ["leok", "2026-11-12T11:00:00Z"]),
                },
                { prev }
            ).trigger_key
        ).toBe("re_review:bbb2222:2026-11-12T11:00:00Z")
        // asked before our latest review (that review answered it)
        expect(
            classify({
                ...cr("2026-11-12T12:00:00Z"),
                ...asked(["leok"], ["leok", "2026-11-12T11:00:00Z"]),
            }).needs_review
        ).toBeNull()
        // a closed PR: no answer due
        expect(
            classify({
                ...cr(),
                ...asked(["leok"], ["leok", "2026-11-12T11:00:00Z"]),
                state: "CLOSED",
            }).rerequested_at
        ).toBeNull()
        // never reviewed: a first review, whoever asked
        expect(
            classify(asked(["leok"], ["leok", "2026-11-12T11:00:00Z"]))
        ).toMatchObject({ needs_review: "new", rerequested_at: null })
    })

    test("changes requested, nothing new since: no review needed", () => {
        const c = classify({
            reviews: {
                nodes: [
                    review(
                        "leok",
                        "CHANGES_REQUESTED",
                        "2026-11-12T10:00:00Z",
                        "bbb2222"
                    ),
                ],
            },
            comments: {
                nodes: [
                    { author: user("dev1"), createdAt: "2026-11-12T09:30:00Z" },
                ],
            },
        })
        expect(c.needs_review).toBeNull()
    })

    test("eligibility: draft, bot, other base, closed, merged", () => {
        expect(classify({ isDraft: true })).toMatchObject({
            eligible: false,
            ineligible_reason: "draft",
            needs_review: "new",
        })
        // a bot's PR is reviewed like any other
        expect(
            classify({ author: { __typename: "Bot", login: "renovate" } })
        ).toMatchObject({ eligible: true, ineligible_reason: null })
        // and its author's own replies answer a change request
        expect(
            classify({
                author: { __typename: "Bot", login: "tracebot" },
                reviews: {
                    nodes: [
                        review(
                            "leok",
                            "CHANGES_REQUESTED",
                            "2026-11-12T10:00:00Z",
                            "bbb2222"
                        ),
                    ],
                },
                activity: {
                    nodes: [
                        {
                            author: { __typename: "Bot", login: "tracebot" },
                            submittedAt: "2026-11-12T13:00:00Z",
                        },
                    ],
                },
            }).needs_review
        ).toBe("re_review")
        // a stacked PR (another PR's branch as base) is reviewed too
        expect(
            classify({ baseRefName: "release" }).ineligible_reason
        ).toBeNull()
        expect(stackedBase({ base: "release", default_branch: "main" })).toBe(
            "release"
        )
        expect(stackedBase({ base: "main" })).toBeNull()
        expect(
            stackedBase({ base: "develop", default_branch: "develop" })
        ).toBeNull()
        expect(stackedBase({})).toBeNull()
        expect(
            classify({ baseRefName: "develop" }, { defaultBranch: "develop" })
                .eligible
        ).toBe(true)
        expect(classify({ state: "CLOSED" })).toMatchObject({
            ineligible_reason: "closed",
            needs_review: null,
        })
        expect(classify({ state: "MERGED" }).ineligible_reason).toBe("merged")
    })
})
