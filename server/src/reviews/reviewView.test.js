/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    computeStats,
    inTab,
    listView,
    matches,
    groupOf,
    prRow,
    settled,
    settledKey,
    weekStart,
} from "./reviewView.js"

const NOW = Date.parse("2026-11-14T12:00:00Z")
const DAY = 86400000
const iso = (msAgo) => new Date(NOW - msAgo).toISOString()

const pr = (over = {}) => ({
    repo: "mobile",
    number: 417,
    url: "u",
    title: "Fix the login flow",
    author: "dev1",
    author_bot: false,
    is_draft: false,
    base: "main",
    default_branch: "main",
    state: "OPEN",
    created_at: iso(3 * DAY),
    updated_at: iso(DAY),
    decision: null,
    decided_at: null,
    attempts: 0,
    needs_review: "new",
    first_review_at: null,
    ...over,
})

describe("prRow", () => {
    test("eligibility, auto flag and the run", () => {
        const row = prRow(
            pr({ is_draft: true }),
            { id: 3, status: "failed", workspace_id: "w1", error: "no report" },
            { auto_review: true }
        )
        expect(row).toMatchObject({
            eligible: false,
            ineligible_reason: "draft",
            tracked_auto: true,
            run: {
                id: 3,
                status: "failed",
                error: "no report",
                agent_open: true,
                verdict: null,
            },
        })
        expect(prRow(pr(), null, null)).toMatchObject({
            eligible: true,
            tracked_auto: false,
            run: null,
        })
        expect(
            prRow(pr({ state: "MERGED" }), { id: 1 }, null).run.agent_open
        ).toBe(false)
    })
})

describe("groupOf", () => {
    test("merged, closed and other sections", () => {
        expect(groupOf(pr({ state: "MERGED", needs_review: null }), NOW)).toBe(
            "merged"
        )
        expect(
            groupOf(
                pr({
                    state: "CLOSED",
                    decision: "changes_requested",
                    needs_review: null,
                }),
                NOW
            )
        ).toBe("closed")
        expect(groupOf(pr({ is_draft: true, tracked: true }), NOW)).toBe(
            "other"
        )
    })
})

describe("settled re-reviews", () => {
    test("a finished unchanged re-review of this very state: Rejected, not New", () => {
        const state = {
            tracked: true,
            decision: "changes_requested",
            needs_review: "re_review",
            trigger_key: "re_review:sha1:2026-11-06T05:42:49Z",
        }
        const keys = new Set([settledKey("mobile", 417, state.trigger_key)])
        // the latest run is a cancelled retry: the settlement stays
        const retry = {
            id: 6,
            status: "cancelled",
            trigger_key: state.trigger_key,
        }
        const row = prRow(
            pr(state),
            retry,
            { track: true, auto_review: true },
            keys
        )
        expect(row).toMatchObject({ needs_review: null, settled: true })
        expect(row.run.trigger_key).toBe(state.trigger_key)
        expect(inTab(row, "new", NOW)).toBe(false)
        expect(inTab(row, "rejected", NOW)).toBe(true)
        expect(settled(pr(state), keys)).toBe(true)
        // a newer answer (another key), no keys, a first review: not settled
        expect(
            settled(pr({ ...state, trigger_key: "re_review:sha1:later" }), keys)
        ).toBe(false)
        expect(settled(pr(state), null)).toBe(false)
        expect(settled(pr(state), new Set())).toBe(false)
        expect(settled(pr({ ...state, needs_review: null }), keys)).toBe(false)
        expect(
            settled(pr({ ...state, needs_review: "new", decision: null }), keys)
        ).toBe(false)
        expect(prRow(pr(state), null, null).settled).toBe(false)
        // not counted as waiting
        const stats = (k) =>
            computeStats({
                prs: [pr(state)],
                decisions: [],
                repos: [{ name: "mobile", track: true }],
                settledKeys: k,
                nowMs: NOW,
            })
        expect(stats(keys).waiting).toBe(0)
        expect(stats(null).waiting).toBe(1)
        // listView passes the keys to every row
        const v = listView({
            prs: [pr(state)],
            runs: new Map(),
            repos: [{ name: "mobile", track: true }],
            settledKeys: keys,
            tab: "rejected",
            nowMs: NOW,
        })
        expect(v.prs.map((r) => r.number)).toEqual([417])
    })
})

describe("tabs and search", () => {
    test("inTab", () => {
        // rows carry tracked (prRow); New: only what waits for Leo
        const t = (over) => pr({ tracked: true, ...over })
        expect(inTab(t(), "new", NOW)).toBe(true)
        expect(inTab(t({ is_draft: true }), "new", NOW)).toBe(false)
        expect(inTab(t({ state: "CLOSED" }), "new", NOW)).toBe(false)
        expect(inTab(t({ needs_review: null }), "new", NOW)).toBe(false)
        // untracked repo: hidden
        expect(inTab(t({ tracked: false }), "new", NOW)).toBe(false)
        // in the review pipeline: Queued, not New
        for (const status of ["queued", "running", "reported"]) {
            const row = t({ run: { status } })
            expect(inTab(row, "new", NOW)).toBe(false)
            expect(inTab(row, "queued", NOW)).toBe(true)
        }
        // a failed automatic review waits for Leo again
        const failed = t({ run: { status: "failed" } })
        expect(inTab(failed, "new", NOW)).toBe(true)
        expect(inTab(failed, "queued", NOW)).toBe(false)
        expect(inTab(t(), "queued", NOW)).toBe(false)
        const rejected = pr({
            decision: "changes_requested",
            state: "MERGED",
            needs_review: null,
        })
        expect(inTab(rejected, "rejected", NOW)).toBe(true)
        // answered (re-review) or in the queue: not Rejected
        const cr = { decision: "changes_requested", needs_review: null }
        expect(
            inTab(t({ ...cr, needs_review: "re_review" }), "rejected", NOW)
        ).toBe(false)
        expect(
            inTab(t({ ...cr, run: { status: "queued" } }), "rejected", NOW)
        ).toBe(false)
        expect(
            inTab(t({ ...cr, run: { status: "done" } }), "rejected", NOW)
        ).toBe(true)
        const fresh = pr({ decision: "approved", decided_at: iso(6 * DAY) })
        const old = pr({ decision: "approved", decided_at: iso(8 * DAY) })
        expect(inTab(fresh, "approved", NOW)).toBe(true)
        expect(inTab(old, "approved", NOW)).toBe(false)
        expect(inTab(old, "all", NOW)).toBe(true)
    })

    test("matches: number or text", () => {
        const row = pr()
        expect(matches(row, "")).toBe(true)
        expect(matches(row, "417")).toBe(true)
        expect(matches(row, "#417")).toBe(true)
        expect(matches(row, "#41")).toBe(false)
        expect(matches(row, "LOGIN")).toBe(true)
        expect(matches(row, "dev1")).toBe(true)
        expect(matches(row, "mobile")).toBe(true)
        expect(matches(row, "upload")).toBe(false)
        expect(matches({ number: 1, title: null }, "x")).toBe(false)
    })

    test("listView filters, counts and sorts", () => {
        const prs = [
            pr({ number: 1, created_at: iso(DAY) }),
            pr({ number: 2, created_at: iso(5 * DAY) }),
            pr({
                number: 3,
                needs_review: null,
                decision: "approved",
                decided_at: iso(DAY),
            }),
            pr({
                number: 4,
                needs_review: null,
                decision: "changes_requested",
                decided_at: iso(2 * DAY),
            }),
            pr({
                number: 5,
                needs_review: null,
                decision: "changes_requested",
                decided_at: iso(1 * DAY),
                repo: "api",
            }),
        ]
        prs.push(
            pr({ number: 6, created_at: iso(2 * DAY) }),
            pr({ number: 7, repo: "api" }) // untracked: hidden from New
        )
        const runs = new Map([
            ["mobile#1", { id: 9, status: "queued", queued_at: iso(1000) }],
            ["mobile#6", { id: 8, status: "running", queued_at: iso(5000) }],
        ])
        const repos = [{ name: "mobile", track: true, auto_review: true }]
        const v = listView({ prs, runs, repos, tab: "new", nowMs: NOW })
        expect(v.prs.map((r) => r.number)).toEqual([2]) // oldest first
        expect(v.counts).toEqual({
            new: 1,
            queued: 2,
            rejected: 2,
            approved: 1,
            all: 7,
        })
        const q = listView({ prs, runs, repos, tab: "queued", nowMs: NOW })
        // newest PR first (#1 opened a day ago, #6 two days ago)
        expect(q.prs.map((r) => r.number)).toEqual([1, 6])
        expect(q.prs[0].run).toMatchObject({ id: 9, status: "queued" })
        // All: by status section, newest first inside each
        const all = listView({ prs, runs, repos, tab: "all", nowMs: NOW })
        expect(all.prs.map((r) => [r.group, r.number])).toEqual([
            ["queued", 1],
            ["queued", 6],
            ["new", 2],
            ["rejected", 5],
            ["rejected", 4],
            ["approved", 3],
            ["other", 7],
        ])
        const rej = listView({ prs, runs, repos, tab: "rejected", nowMs: NOW })
        expect(rej.prs.map((r) => r.number)).toEqual([5, 4]) // newest first
        expect(rej.prs[0].tracked_auto).toBe(false)
        const found = listView({
            prs,
            runs,
            repos,
            tab: "all",
            q: "#4",
            nowMs: NOW,
        })
        expect(found.prs.map((r) => r.number)).toEqual([4])
        expect(found.counts).toEqual({
            new: 0,
            queued: 0,
            rejected: 1,
            approved: 0,
            all: 1,
        })
        expect(listView({ prs, runs, repos, nowMs: NOW }).prs).toHaveLength(1)
    })
})

describe("stats", () => {
    test("weekStart is the Monday (UTC)", () => {
        expect(weekStart(Date.parse("2026-11-14T12:00:00Z"))).toBe("2026-11-09")
        expect(weekStart(Date.parse("2026-11-09T00:00:00Z"))).toBe("2026-11-09")
        expect(weekStart(Date.parse("2026-11-08T23:59:00Z"))).toBe("2026-11-02")
    })

    test("counts, attempts, weekly, times, waiting, authors", () => {
        const prs = [
            pr({
                number: 1,
                decision: "approved",
                decided_at: iso(DAY),
                attempts: 1,
                needs_review: null,
                created_at: iso(3 * DAY),
                first_review_at: iso(3 * DAY - 2 * 3600000),
            }),
            pr({
                number: 2,
                decision: "approved",
                decided_at: iso(2 * DAY),
                attempts: 2,
                needs_review: null,
                created_at: iso(4 * DAY),
                first_review_at: iso(4 * DAY - 6 * 3600000),
            }),
            pr({
                number: 3,
                decision: "approved",
                decided_at: iso(3 * DAY),
                attempts: 5,
                needs_review: null,
                created_at: iso(5 * DAY),
                first_review_at: iso(5 * DAY - 10 * 3600000),
            }),
            // outside the window
            pr({
                number: 4,
                decision: "approved",
                decided_at: iso(40 * DAY),
                attempts: 3,
                first_review_at: iso(40 * DAY),
                needs_review: null,
            }),
            pr({ number: 5, attempts: 0 }), // waiting
            pr({ number: 6 }), // waiting, but queued
            pr({ number: 7, is_draft: true }),
            pr({
                number: 8,
                decision: "approved",
                decided_at: iso(DAY),
                attempts: 0,
                needs_review: null,
            }),
        ]
        const decisions = [
            { state: "APPROVED", submitted_at: iso(DAY), author: "dev1" },
            {
                state: "CHANGES_REQUESTED",
                submitted_at: iso(2 * DAY),
                author: "dev2",
            },
            { state: "APPROVED", submitted_at: iso(2 * DAY), author: "dev2" },
            { state: "DISMISSED", submitted_at: iso(2 * DAY), author: "dev2" },
            { state: "APPROVED", submitted_at: iso(20 * DAY), author: null },
            { state: "APPROVED", submitted_at: iso(100 * DAY), author: "dev3" },
        ]
        const runs = [
            { repo: "mobile", number: 6, status: "queued" },
            { repo: "mobile", number: 9, status: "running" },
        ]
        const s = computeStats({ prs, decisions, runs, nowMs: NOW })
        expect(s).toMatchObject({
            window_days: 30,
            approved: 3,
            changes_requested: 1,
            attempts: { 1: 2, 2: 1, 3: 0, "4+": 1 },
            median_first_review_hours: 6,
            avg_attempts_to_approve: 2.3,
            waiting: 1,
            reviewing: 1,
            queued: 1,
        })
        expect(s.weekly).toHaveLength(8)
        expect(s.weekly.at(-1)).toEqual({
            week: "2026-11-09",
            approved: 2,
            changes_requested: 1,
        })
        expect(s.authors).toEqual([
            { author: "dev2", approved: 1, changes_requested: 1 },
            { author: "dev1", approved: 1, changes_requested: 0 },
        ])
    })

    test("empty", () => {
        const s = computeStats({ prs: [], decisions: [], nowMs: NOW })
        expect(s).toMatchObject({
            approved: 0,
            median_first_review_hours: null,
            avg_attempts_to_approve: null,
            waiting: 0,
            reviewing: 0,
            queued: 0,
            authors: [],
        })
        const even = computeStats({
            prs: [
                pr({
                    created_at: iso(DAY),
                    first_review_at: iso(DAY - 3600000),
                }),
                pr({
                    created_at: iso(DAY),
                    first_review_at: iso(DAY - 3 * 3600000),
                }),
                pr({ created_at: null, first_review_at: iso(DAY) }),
            ],
            decisions: [],
            nowMs: NOW,
        })
        expect(even.median_first_review_hours).toBe(2)
    })
})
