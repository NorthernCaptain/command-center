/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    ApiError,
    api,
    createApi,
    errorMessage,
    isTailnetConfigError,
} from "./api.js"
import { mockFetch, reply } from "../../test/helpers.js"

describe("createApi request()", () => {
    it("sends JSON with same-origin credentials", async () => {
        const f = mockFetch({
            "POST /api/tasks": reply(201, { task: { id: 1 } }),
        })
        const res = await api.createTask({ text: "hello" })
        expect(res).toEqual({ task: { id: 1 } })
        const call = f.calls[0]
        expect(call.init.credentials).toBe("same-origin")
        expect(call.init.headers["Content-Type"]).toBe("application/json")
        expect(call.body).toEqual({ text: "hello" })
    })

    it("GET has no body / content-type", async () => {
        const f = mockFetch({ "GET /api/me": { role: "owner" } })
        await api.me()
        expect(f.calls[0].init.body).toBeUndefined()
        expect(f.calls[0].init.headers["Content-Type"]).toBeUndefined()
    })

    it("maps error bodies to ApiError", async () => {
        mockFetch({
            "GET /api/tasks/9": reply(404, {
                error: "not_found",
                message: "task 9 not found",
            }),
        })
        const err = await api.getTask(9).catch((e) => e)
        expect(err).toBeInstanceOf(ApiError)
        expect(err.status).toBe(404)
        expect(err.code).toBe("not_found")
        expect(err.message).toBe("task 9 not found")
        expect(err.isStale).toBe(false)
        expect(err.current).toBeNull()
    })

    it("other 409 conflicts are not stale revisions", async () => {
        mockFetch({
            "PATCH /api/tasks/3": reply(409, {
                error: "deliverables_open",
                message: "T-3 has deliverables that are not merged",
            }),
        })
        const err = await api.patchTask(3, { status: "done" }).catch((e) => e)
        expect(err.status).toBe(409)
        expect(err.isStale).toBe(false)
        expect(err.message).toMatch(/not merged/)
    })

    it("exposes stale_revision current state", async () => {
        mockFetch({
            "PUT /api/tasks/3/artifact": reply(409, {
                error: "stale_revision",
                message: "base_revision does not match current",
                details: { current: { content: "# new", revision: "abc" } },
            }),
        })
        const err = await api.putArtifact(3, "# mine", "old").catch((e) => e)
        expect(err.isStale).toBe(true)
        expect(err.current).toEqual({ content: "# new", revision: "abc" })
    })

    it("falls back to status codes and text bodies", async () => {
        const fetch = jest.fn(async () => ({
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
            text: async () => "",
        }))
        const client = createApi({ fetch })
        const err = await client.board().catch((e) => e)
        expect(err.code).toBe("unavailable")
        expect(err.message).toBe("Service Unavailable")

        const fetch2 = jest.fn(async () => ({
            ok: false,
            status: 418,
            statusText: "",
            text: async () => "teapot",
        }))
        const err2 = await createApi({ fetch: fetch2 })
            .board()
            .catch((e) => e)
        expect(err2.code).toBe("http_error")
        expect(err2.message).toBe("teapot")
    })

    it("returns null for empty success bodies and parses text", async () => {
        const fetch = jest.fn(async () => ({
            ok: true,
            status: 204,
            text: async () => "",
        }))
        expect(await createApi({ fetch }).deleteSchedule(1)).toBeNull()
    })

    it("wraps network errors and rethrows aborts", async () => {
        const client = createApi({
            fetch: async () => {
                throw new TypeError("Failed to fetch")
            },
        })
        const err = await client.me().catch((e) => e)
        expect(err.code).toBe("network_error")
        expect(err.status).toBe(0)

        const abort = new Error("aborted")
        abort.name = "AbortError"
        const client2 = createApi({
            fetch: async () => {
                throw abort
            },
        })
        await expect(client2.me()).rejects.toBe(abort)
    })

    it("passes an abort signal through", async () => {
        const f = mockFetch({ "GET /api/tasks": { tasks: [], total: 0 } })
        const ctrl = new AbortController()
        await api.listTasks({ q: "x" }, { signal: ctrl.signal })
        expect(f.calls[0].init.signal).toBe(ctrl.signal)
    })
})

describe("routes", () => {
    let f
    beforeEach(() => {
        f = mockFetch(
            new Proxy(
                {},
                {
                    get: () => ({ ok: true }),
                }
            )
        )
    })

    const cases = [
        [() => api.me(), "GET", "/api/me"],
        [() => api.board(), "GET", "/api/board"],
        [() => api.getTask(5), "GET", "/api/tasks/5"],
        [() => api.getHistory(5), "GET", "/api/tasks/5/history"],
        [() => api.getCommitDiff(5, "abc"), "GET", "/api/tasks/5/history/abc"],
        [
            () => api.setCommentStatus(5, "c_1", "resolved"),
            "PATCH",
            "/api/tasks/5/comments/c_1",
            { status: "resolved" },
        ],
        [() => api.deleteSchedule(7), "DELETE", "/api/schedules/7"],
        [() => api.createAsana(5), "POST", "/api/tasks/5/asana"],
        [() => api.closeOut(5), "POST", "/api/tasks/5/close-out"],
        [() => api.enrich(5), "POST", "/api/tasks/5/enrich"],
        [
            () => api.command("snooze all"),
            "POST",
            "/api/command",
            { text: "snooze all" },
        ],
        [() => api.getJob("j1"), "GET", "/api/jobs/j1"],
        [() => api.cancelJob("j1"), "POST", "/api/jobs/j1/cancel"],
        [() => api.getSettings(), "GET", "/api/settings"],
        [
            () => api.patchSettings({ "center.provider": "codex" }),
            "PATCH",
            "/api/settings",
            { "center.provider": "codex" },
        ],
        [() => api.pairCode(), "POST", "/api/pair/code"],
        [
            () => api.pair({ code: "123456", name: "Phone" }),
            "POST",
            "/api/pair",
            { code: "123456", name: "Phone" },
        ],
        [() => api.listDevices(), "GET", "/api/devices"],
        [() => api.revokeDevice("d1"), "DELETE", "/api/devices/d1"],
        [() => api.healthz(), "GET", "/healthz"],
        [
            () => api.putArtifact(5, "x", "r1"),
            "PUT",
            "/api/tasks/5/artifact",
            { content: "x", base_revision: "r1" },
        ],
        [
            () => api.startTask(5, { kind: "codex" }),
            "POST",
            "/api/tasks/5/start",
            { kind: "codex" },
        ],
        [() => api.startTask(5), "POST", "/api/tasks/5/start", {}],
        [
            () => api.taskAction(5, "send", { text: "hi", quote: "q" }),
            "POST",
            "/api/tasks/5/actions/send",
            { text: "hi", quote: "q" },
        ],
        [
            () => api.taskAction(5, "create-pr"),
            "POST",
            "/api/tasks/5/actions/create-pr",
            {},
        ],
        [() => api.getAgent(5), "GET", "/api/tasks/5/agent"],
        [() => api.pollPrs(5), "POST", "/api/tasks/5/prs/poll"],
        [
            () => api.claimPr(5, "https://gh/pull/1"),
            "POST",
            "/api/tasks/5/prs/claim",
            { url: "https://gh/pull/1" },
        ],
        [
            () => api.setDeliverable(5, "aws-lambda"),
            "POST",
            "/api/tasks/5/deliverables/aws-lambda",
            { disposition: "no_change" },
        ],
        [
            () => api.reopenFeedback(5, "gh-rc-1"),
            "PATCH",
            "/api/tasks/5/feedback/gh-rc-1",
            { status: "open" },
        ],
        [
            () => api.soc2Export({ from: "2026-01-01" }),
            "GET",
            "/api/soc2/export",
        ],
        [() => api.pushKey(), "GET", "/api/push/key"],
        [
            () => api.pushSubscribe({ endpoint: "e", keys: { auth: "a" } }),
            "POST",
            "/api/push/subscribe",
            { endpoint: "e", keys: { auth: "a" } },
        ],
        [
            () => api.pushUnsubscribe("e"),
            "DELETE",
            "/api/push/subscribe",
            { endpoint: "e" },
        ],
        [() => api.getDigest(), "GET", "/api/digest"],
        [() => api.runDigest(), "POST", "/api/digest/run"],
    ]

    it("soc2 export: json query and a url for md downloads", async () => {
        await api.soc2Export({ from: "2026-01-01", to: "2026-02-01" })
        expect(f.calls[0].url).toBe(
            "/api/soc2/export?from=2026-01-01&to=2026-02-01&format=json"
        )
        expect(api.soc2ExportUrl({ from: "2026-01-01" })).toBe(
            "/api/soc2/export?from=2026-01-01&format=md"
        )
        expect(api.soc2ExportUrl()).toBe("/api/soc2/export?format=md")
        expect(
            createApi({ base: "http://x" }).soc2ExportUrl({ format: "json" })
        ).toBe("http://x/api/soc2/export?format=json")
    })

    it.each(cases.map((c) => [c[0], c[1], c[2], c[3] || null]))(
        "%#: calls the right route",
        async (fn, method, path, body) => {
            await fn()
            expect(f.calls[0].method).toBe(method)
            expect(f.calls[0].path).toBe(path)
            if (body) expect(f.calls[0].body).toEqual(body)
        }
    )

    it("patchTask with and without base revision", async () => {
        await api.patchTask(5, { status: "done" }, "r9")
        await api.patchTask(5, { status: "done" })
        expect(f.calls[0].body).toEqual({
            patch: { status: "done" },
            base_revision: "r9",
        })
        expect(f.calls[1].body).toEqual({ patch: { status: "done" } })
    })

    it("patchTask sends free-text snooze for the server to parse", async () => {
        await api.patchTask(5, null, undefined, { snooze: "after lunch" })
        await api.patchTask(5, {}, "r9", { snooze: "3d" })
        expect(f.calls[0].body).toEqual({ snooze: "after lunch" })
        expect(f.calls[1].body).toEqual({ base_revision: "r9", snooze: "3d" })
    })

    it("listTasks builds a query string, skipping empty values", async () => {
        await api.listTasks({
            q: "lambda x",
            status: ["active", "ready"],
            area: "",
            kind: [],
            limit: 20,
            offset: null,
        })
        expect(f.calls[0].url).toBe(
            "/api/tasks?q=lambda%20x&status=active%2Cready&limit=20"
        )
        await api.listTasks()
        expect(f.calls[1].url).toBe("/api/tasks")
    })

    it("addComment only sends present fields", async () => {
        await api.addComment(5, { body: "hi", intent: "chat" })
        await api.addComment(5, {
            body: "why",
            intent: "ask",
            anchor: { exact: "a" },
            parent_id: "c_1",
        })
        expect(f.calls[0].body).toEqual({ body: "hi", intent: "chat" })
        expect(f.calls[1].body).toEqual({
            body: "why",
            intent: "ask",
            anchor: { exact: "a" },
            parent_id: "c_1",
        })
    })

    it("addSchedule defaults to surface", async () => {
        await api.addSchedule(5, { when: "2h", note: "check" })
        await api.addSchedule(5, { fire_at: "2026-11-08T09:00:00Z" })
        await api.addSchedule(5)
        expect(f.calls[0].body).toEqual({
            action: "surface",
            when: "2h",
            note: "check",
        })
        expect(f.calls[1].body).toEqual({
            action: "surface",
            fire_at: "2026-11-08T09:00:00Z",
        })
        expect(f.calls[2].body).toEqual({ action: "surface" })
    })
})

describe("errorMessage", () => {
    it("maps common errors", () => {
        expect(errorMessage(null)).toBe("Something went wrong")
        expect(errorMessage(new ApiError({ status: 401 }))).toBe(
            "Not signed in"
        )
        expect(errorMessage(new ApiError({ status: 403 }))).toBe(
            "Owner access required"
        )
        expect(
            errorMessage(
                new ApiError({
                    status: 400,
                    code: "validation",
                    message: "bad",
                })
            )
        ).toBe("bad")
        expect(errorMessage(new Error("boom"))).toBe("boom")
        expect(errorMessage("plain")).toBe("plain")
    })
    it("ApiError defaults", () => {
        const e = new ApiError()
        expect(e.code).toBe("error")
        expect(e.message).toBe("error")
        const s = new ApiError({ code: "stale_revision", status: 400 })
        expect(s.isStale).toBe(true)
    })
})

describe("isTailnetConfigError", () => {
    it("matches 421 and 503 API errors only", () => {
        expect(isTailnetConfigError(new ApiError({ status: 421 }))).toBe(true)
        expect(isTailnetConfigError(new ApiError({ status: 503 }))).toBe(true)
        expect(isTailnetConfigError(new ApiError({ status: 500 }))).toBe(false)
        expect(isTailnetConfigError(new Error("x"))).toBe(false)
        expect(isTailnetConfigError(null)).toBe(false)
    })
})
