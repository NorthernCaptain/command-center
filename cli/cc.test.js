/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import fs from "node:fs"
import {
    createOpenUrl,
    formatBrief,
    formatTask,
    isBootstrapUrl,
    parseArgs,
    run,
    USAGE,
} from "./cc.js"

const config = {
    configDir: "/fake/cfg",
    listeners: { local: { host: "127.0.0.1", port: 7788 } },
}

function sink() {
    const s = { text: "" }
    s.write = (c) => {
        s.text += c
        return true
    }
    return s
}

function response(status, body, raw) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: "Status " + status,
        text: async () => (raw !== undefined ? raw : JSON.stringify(body)),
    }
}

/** Fake fetch answering by "METHOD path". */
function fakeFetch(routes) {
    const calls = []
    const fetch = async (url, init) => {
        const u = new URL(url)
        const key = `${init.method} ${u.pathname}`
        calls.push({ url, key, init, body: init.body && JSON.parse(init.body) })
        const handler = routes[key]
        if (!handler) return response(404, { error: "not_found" })
        return typeof handler === "function" ? handler(u, init) : handler
    }
    fetch.calls = calls
    return fetch
}

const TASK = {
    id: 12,
    title: "Talk to Ron",
    status: "waiting",
    due_at: "2026-11-08T10:00:00Z",
    flags: { now: true },
}

async function cc(argv, routes = {}, extra = {}) {
    const stdout = sink()
    const stderr = sink()
    const fetch = fakeFetch(routes)
    const readFile = extra.readFile || (async () => "tok123\n")
    const opened = []
    const code = await run(argv, {
        fetch,
        readFile,
        openUrl: async (u) => opened.push(u),
        stdout,
        stderr,
        config,
        ...extra.deps,
    })
    return { code, out: stdout.text, err: stderr.text, fetch, opened }
}

describe("parseArgs", () => {
    test("commands, args and flags", () => {
        expect(parseArgs([])).toEqual({ command: "help", args: [], flags: {} })
        expect(parseArgs(["add", "fix", "bug"])).toEqual({
            command: "add",
            args: ["fix", "bug"],
            flags: {},
        })
        expect(
            parseArgs(["ls", "--status", "ready,waiting", "--limit=5"])
        ).toEqual({
            command: "ls",
            args: [],
            flags: { status: "ready,waiting", limit: "5" },
        })
        expect(parseArgs(["ls", "--all"]).flags).toEqual({ all: true })
        expect(parseArgs(["ls", "--all", "--x", "y"]).flags).toEqual({
            all: true,
            x: "y",
        })
        expect(parseArgs(["add", "--", "--literal", "x"])).toEqual({
            command: "add",
            args: ["--literal", "x"],
            flags: {},
            dash: 0,
        })
        expect(parseArgs(["decision", "1", "a", "--", "b"]).dash).toBe(2)
        expect(parseArgs(["-h"]).command).toBe("help")
        expect(parseArgs(["add", "--help"])).toMatchObject({
            command: "add",
            flags: { help: true },
        })
        expect(parseArgs(["add", "-x"]).args).toEqual(["-x"])
    })
})

describe("formatTask", () => {
    test("formats status, due and now", () => {
        expect(formatTask(TASK)).toBe(
            "T-12   [waiting]      Talk to Ron  (due 2026-11-08T10:00:00Z)  *now*"
        )
        expect(formatTask({ id: 3, title: "x", status: "inbox" })).toBe(
            "T-3    [inbox]        x"
        )
    })
})

describe("run", () => {
    test("help and unknown command", async () => {
        const h = await cc(["help"])
        expect(h.code).toBe(0)
        expect(h.out).toBe(USAGE)
        const u = await cc(["frobnicate"])
        expect(u.code).toBe(2)
        expect(u.err).toMatch(/unknown command: frobnicate/)
    })

    test("--help on a subcommand shows usage and sends nothing", async () => {
        const r = await cc(["done", "12", "--help"])
        expect(r.code).toBe(0)
        expect(r.out).toBe(USAGE)
        expect(r.fetch.calls).toHaveLength(0)
    })

    test("missing token file", async () => {
        const r = await cc(
            ["ls"],
            {},
            {
                readFile: async () => {
                    const e = new Error("nope")
                    e.code = "ENOENT"
                    throw e
                },
            }
        )
        expect(r.code).toBe(1)
        expect(r.err).toMatch(/cannot read token in \/fake\/cfg \(ENOENT\)/)
        const r2 = await cc(
            ["ls"],
            {},
            {
                readFile: async () => {
                    throw new Error("weird")
                },
            }
        )
        expect(r2.err).toMatch(/\(weird\)/)
    })

    test("add posts text with bearer token", async () => {
        const r = await cc(["add", "fix", "the", "bug"], {
            "POST /api/tasks": response(201, { task: { ...TASK, flags: {} } }),
        })
        expect(r.code).toBe(0)
        const call = r.fetch.calls[0]
        expect(call.url).toBe("http://127.0.0.1:7788/api/tasks")
        expect(call.init.headers).toEqual({
            Authorization: "Bearer tok123",
            "Content-Type": "application/json",
        })
        // no source_type: the server classifies URLs in the text
        expect(call.body).toEqual({ text: "fix the bug" })
        expect(r.out).toMatch(/^T-12 /)
        expect((await cc(["add"])).code).toBe(2)
    })

    test("ls with filters, totals and empty", async () => {
        const r = await cc(
            ["ls", "--status", "waiting", "--q", "ron", "--limit", "1"],
            {
                "GET /api/tasks": response(200, { tasks: [TASK], total: 3 }),
            }
        )
        expect(r.fetch.calls[0].url).toBe(
            "http://127.0.0.1:7788/api/tasks?status=waiting&q=ron&limit=1"
        )
        expect(r.fetch.calls[0].init.body).toBeUndefined()
        expect(r.out).toMatch(/Talk to Ron[^\n]*\n\(1 of 3 shown\)\n$/)
        const e = await cc(["ls"], {
            "GET /api/tasks": response(200, { tasks: [], total: 0 }),
        })
        expect(e.fetch.calls[0].url).toBe("http://127.0.0.1:7788/api/tasks")
        expect(e.out).toBe("no tasks\n")
    })

    test("show prints the artifact", async () => {
        const r = await cc(["show", "T-12"], {
            "GET /api/tasks/12": response(200, {
                task: TASK,
                artifact: { content: "# T-12 — Talk to Ron" },
            }),
        })
        expect(r.code).toBe(0)
        expect(r.out).toContain("\n# T-12 — Talk to Ron\n")
        const noArt = await cc(["show", "12"], {
            "GET /api/tasks/12": response(200, { task: TASK }),
        })
        expect(noArt.out.split("\n")).toHaveLength(2)
        const bad = await cc(["show", "abc"])
        expect(bad.code).toBe(2)
        expect(bad.err).toMatch(/invalid task id: abc/)
        expect((await cc(["show"])).err).toMatch(/\(missing\)/)
    })

    test("done patches status", async () => {
        const r = await cc(["done", "12"], {
            "PATCH /api/tasks/12": response(200, {
                task: { ...TASK, status: "done", flags: {} },
            }),
        })
        expect(r.fetch.calls[0].body).toEqual({ patch: { status: "done" } })
        expect(r.out).toMatch(/\[done\]/)
        expect(r.out).not.toMatch(/close-out/)
    })

    test("done on an Asana-linked task reports the close-out", async () => {
        const started = await cc(["done", "12"], {
            "PATCH /api/tasks/12": response(202, {
                task: TASK,
                job: { id: "j7" },
                close_out: "started",
            }),
        })
        expect(started.code).toBe(0)
        expect(started.out).toMatch(/\nclose-out started \(j7\)\n$/)
        const pending = await cc(["done", "12"], {
            "PATCH /api/tasks/12": response(202, {
                task: TASK,
                close_out: "pending",
            }),
        })
        expect(pending.out).toMatch(/\nclose-out already running\n$/)
    })

    test("add with a Slack link lets the server classify it", async () => {
        const url = "https://acme.slack.com/archives/C1/p1"
        const r = await cc(["add", url], {
            "POST /api/tasks": response(201, { task: TASK }),
        })
        expect(r.fetch.calls[0].body).toEqual({ text: url })
    })

    test("remind sends when + text", async () => {
        const r = await cc(["remind", "tomorrow 9am", "call", "mom"], {
            "POST /api/tasks": response(201, { task: TASK }),
        })
        expect(r.fetch.calls[0].body).toEqual({
            text: "call mom",
            when: "tomorrow 9am",
            kind: "reminder",
            source_type: "manual",
        })
        expect(r.code).toBe(0)
        expect((await cc(["remind", "2h"])).code).toBe(2)
    })

    test("open fetches a bootstrap url and opens it", async () => {
        const r = await cc(["open"], {
            "POST /api/auth/bootstrap-token": response(200, {
                url: "http://127.0.0.1:7788/auth/bootstrap?t=abc",
            }),
        })
        expect(r.opened).toEqual(["http://127.0.0.1:7788/auth/bootstrap?t=abc"])
        expect(r.out).toMatch(/opened/)
    })

    test.each([
        "https://evil.example/auth/bootstrap?t=abc",
        "http://evil.example:7788/auth/bootstrap?t=abc",
        "http://127.0.0.1:7788/auth/bootstrap?t=abc&x=1",
        "http://127.0.0.1:7788/auth/bootstrap?t=ABC",
        "http://127.0.0.1/auth/bootstrap?t=abc",
        "http://127.0.0.1:7788/other?t=abc",
        "-a Calculator",
        "file:///Applications/Calculator.app",
        "http://127.0.0.1:7788/auth/bootstrap?t=abc\nx",
        "",
        42,
        null,
    ])("open refuses a server-returned url %p", async (url) => {
        const r = await cc(["open"], {
            "POST /api/auth/bootstrap-token": response(200, { url }),
        })
        expect(r.code).toBe(1)
        expect(r.opened).toEqual([])
        expect(r.err).toMatch(/unexpected bootstrap URL/)
    })

    test("open refuses an empty response body", async () => {
        const r = await cc(["open"], {
            "POST /api/auth/bootstrap-token": response(200, null, ""),
        })
        expect(r.code).toBe(1)
        expect(r.opened).toEqual([])
    })

    test("isBootstrapUrl accepts localhost too", () => {
        expect(
            isBootstrapUrl("http://localhost:7788/auth/bootstrap?t=0f")
        ).toBe(true)
    })

    test("createOpenUrl runs open -- <url>", async () => {
        const calls = []
        const ok = createOpenUrl((cmd, args, cb) => {
            calls.push([cmd, args])
            cb(null)
        })
        await ok("http://127.0.0.1:7788/auth/bootstrap?t=ab")
        expect(calls).toEqual([
            ["open", ["--", "http://127.0.0.1:7788/auth/bootstrap?t=ab"]],
        ])
        const fail = createOpenUrl((cmd, args, cb) => cb(new Error("no open")))
        await expect(fail("x")).rejects.toThrow("no open")
    })

    test("pair prints the code", async () => {
        const r = await cc(["pair"], {
            "POST /api/pair/code": response(200, {
                code: "123456",
                expires_at: "2026-11-07T12:10:00Z",
            }),
        })
        expect(r.out).toMatch(/Pairing code: 123456\n/)
        expect(r.out).toMatch(/expires 2026-11-07T12:10:00Z/)
    })

    test("reindex", async () => {
        const r = await cc(["reindex"], {
            "POST /api/admin/reindex": response(200, { count: 7 }),
        })
        expect(r.out).toBe("reindexed 7 tasks\n")
    })

    test("API errors and network errors", async () => {
        const e = await cc(["done", "5"], {
            "PATCH /api/tasks/5": response(404, {
                error: "not_found",
                message: "task 5 not found",
            }),
        })
        expect(e.code).toBe(1)
        expect(e.err).toBe("cc: 404 task 5 not found\n")
        const codeOnly = await cc(["done", "5"], {
            "PATCH /api/tasks/5": response(409, { error: "stale_revision" }),
        })
        expect(codeOnly.err).toBe("cc: 409 stale_revision\n")
        const plain = await cc(["done", "5"], {
            "PATCH /api/tasks/5": response(500, null, "<html>oops"),
        })
        expect(plain.err).toBe("cc: 500 <html>oops\n")
        const empty = await cc(["done", "5"], {
            "PATCH /api/tasks/5": response(502, null, ""),
        })
        expect(empty.err).toBe("cc: 502 Status 502\n")
        const down = await cc(
            ["ls"],
            {},
            {
                deps: {
                    fetch: async () => {
                        throw new Error("ECONNREFUSED")
                    },
                },
            }
        )
        expect(down.code).toBe(1)
        expect(down.err).toMatch(
            /cannot reach http:\/\/127\.0\.0\.1:7788: ECONNREFUSED/
        )
    })

    test("cc.js is executable with a node shebang", () => {
        const file = new URL("./cc.js", import.meta.url)
        expect(
            fs.readFileSync(file, "utf8").startsWith("#!/usr/bin/env node\n")
        ).toBe(true)
    })
})

const BRIEF = {
    task: {
        id: 12,
        title: "Fix upload",
        status: "active",
        repos: [{ name: "aws-lambda", role: "main" }],
        branch: "t12-fix-upload",
        slug: "k7q2",
    },
    revision: "abc123",
    artifact: "# T-12 — Fix upload",
    open_comments: [{ id: "c1" }],
    links: [],
    deliverables: [
        {
            repo: "aws-lambda",
            branch: "t12-fix-upload",
            disposition: "pr",
            pr: "https://github.com/o/r/pull/1",
        },
        { repo: "infra", branch: "t12-fix-upload", disposition: "pending" },
    ],
    feedback_open: [
        {
            id: "gh-rc-1",
            kind: "review_comment",
            path: "a.js",
            line: 4,
            url: "https://g/1",
        },
        {
            id: "gh-rc-2",
            kind: "review_comment",
            path: "b.js",
            url: "https://g/2",
        },
        { id: "ci-x", kind: "ci_failure", url: "https://g/3" },
    ],
    asana_url: "https://app.asana.com/0/1/2",
}

describe("worker tool commands", () => {
    const ok =
        (body = { ok: true }) =>
        () =>
            response(200, body)

    test("env: CC_TOKEN, CC_URL and CC_TASK_ID", async () => {
        const readFile = async () => {
            throw new Error("should not read the token file")
        }
        const r = await cc(
            ["task"],
            { "POST /api/agent/cc_get_task": ok(BRIEF) },
            {
                readFile,
                deps: {
                    env: {
                        CC_TOKEN: "envtok",
                        CC_URL: "http://localhost:9999/",
                        CC_TASK_ID: "12",
                    },
                },
            }
        )
        expect(r.code).toBe(0)
        const call = r.fetch.calls[0]
        expect(call.url).toBe("http://localhost:9999/api/agent/cc_get_task")
        expect(call.init.headers).toEqual({
            Authorization: "Bearer envtok",
            "X-CC-Task": "12",
            "Content-Type": "application/json",
        })
        expect(call.body).toEqual({ task_id: 12 })
    })

    test("CC_URL must be loopback", async () => {
        const r = await cc(
            ["task", "1"],
            {},
            {
                deps: { env: { CC_URL: "https://evil.example" } },
            }
        )
        expect(r.code).toBe(1)
        expect(r.err).toMatch(/loopback/)
        expect(r.fetch.calls).toHaveLength(0)
    })

    test("task prints the brief, or JSON", async () => {
        const r = await cc(["task", "12"], {
            "POST /api/agent/cc_get_task": ok(BRIEF),
        })
        expect(r.fetch.calls[0].init.headers["X-CC-Task"]).toBeUndefined()
        expect(r.out).toContain("artifact revision: abc123")
        expect(r.out).toContain("repos: aws-lambda (main)")
        expect(r.out).toContain("branch: t12-fix-upload  slug: k7q2")
        expect(r.out).toContain(
            "deliverable: aws-lambda@t12-fix-upload pr https://github.com/o/r/pull/1"
        )
        expect(r.out).toContain("deliverable: infra@t12-fix-upload pending\n")
        expect(r.out).toContain(
            "feedback open: gh-rc-1  review_comment  a.js:4  https://g/1"
        )
        expect(r.out).toContain("gh-rc-2  review_comment  b.js  https://g/2")
        expect(r.out).toContain("ci-x  ci_failure  https://g/3")
        expect(r.out).toContain("open comments: 1")
        expect(r.out).toContain("asana: https://app.asana.com")
        expect(r.out).toContain("\n# T-12 — Fix upload")
        const j = await cc(["task", "12", "--json"], {
            "POST /api/agent/cc_get_task": ok(BRIEF),
        })
        expect(JSON.parse(j.out)).toEqual(BRIEF)
        expect((await cc(["task"])).code).toBe(2)
    })

    test("formatBrief with a bare task", () => {
        expect(
            formatBrief({
                task: { id: 1, title: "x", status: "inbox" },
                revision: "r",
            })
        ).toBe("T-1    [inbox]        x\nartifact revision: r")
        expect(
            formatBrief({
                task: { id: 1, title: "x", status: "inbox", slug: "ab12" },
                revision: "r",
            })
        ).toContain("branch: -  slug: ab12")
    })

    test("progress", async () => {
        const r = await cc(["progress", "12", "tests", "green"], {
            "POST /api/agent/cc_report": ok({ ok: true, status: "active" }),
        })
        expect(r.code).toBe(0)
        expect(r.fetch.calls[0].body).toEqual({
            task_id: 12,
            status: "progress",
            summary: "tests green",
        })
        expect(r.out).toBe("progress recorded on T-12\n")
        expect((await cc(["progress", "12"])).code).toBe(2)
    })

    test("decision needs -- before the rationale", async () => {
        const r = await cc(
            ["decision", "12", "use", "backoff", "--", "fewer", "retries"],
            {
                "POST /api/agent/cc_log_decision": ok({
                    line: "- 2026-11-07 · agent:x · use backoff · fewer retries",
                }),
            }
        )
        expect(r.code).toBe(0)
        expect(r.fetch.calls[0].body).toEqual({
            task_id: 12,
            decision: "use backoff",
            rationale: "fewer retries",
        })
        expect(r.out).toMatch(/use backoff · fewer retries/)
        expect((await cc(["decision", "12", "use", "backoff"])).code).toBe(2)
        expect((await cc(["decision", "12", "--", "why"])).code).toBe(2)
        expect((await cc(["decision", "12", "what", "--"])).code).toBe(2)
    })

    test("link with flags; rejected links exit 1", async () => {
        const r = await cc(
            [
                "link",
                "12",
                "folder",
                "/tree/infra--b--k7q2",
                "--role",
                "work",
                "--repo",
                "infra",
                "--label",
                "Infra",
                "--branch",
                "feat/x",
            ],
            { "POST /api/agent/cc_add_link": ok({ ok: true }) }
        )
        expect(r.code).toBe(0)
        expect(r.fetch.calls[0].body).toEqual({
            task_id: 12,
            type: "folder",
            url: "/tree/infra--b--k7q2",
            role: "work",
            repo: "infra",
            label: "Infra",
            branch: "feat/x",
        })
        expect(r.out).toBe("linked folder /tree/infra--b--k7q2 to T-12\n")
        const conflict = await cc(
            ["link", "12", "branch", "feat/x", "--repo", "infra"],
            {
                "POST /api/agent/cc_add_link": ok({
                    ok: false,
                    conflict: "used by T-9",
                    suggestion: "t12-x",
                }),
            }
        )
        expect(conflict.code).toBe(1)
        expect(conflict.err).toBe(
            "not linked: used by T-9; suggestion: t12-x\n"
        )
        const claim = await cc(["link", "12", "pr", "https://g/pull/1"], {
            "POST /api/agent/cc_add_link": ok({
                ok: false,
                reason: "no marker",
            }),
        })
        expect(claim.err).toBe("not linked: no marker\n")
        const bare = await cc(["link", "12", "pr", "https://g/pull/1"], {
            "POST /api/agent/cc_add_link": ok({ ok: false }),
        })
        expect(bare.err).toBe("not linked: rejected\n")
        expect((await cc(["link", "12", "pr"])).code).toBe(2)
    })

    test("report", async () => {
        const r = await cc(
            [
                "report",
                "12",
                "ready_for_pr",
                "all",
                "done",
                "--repos",
                "aws-lambda, infra,",
                "--checks",
                "unit ok",
                "--next",
                "PR",
            ],
            {
                "POST /api/agent/cc_report": ok({
                    ok: true,
                    status: "ready_for_pr",
                }),
            }
        )
        expect(r.code).toBe(0)
        expect(r.fetch.calls[0].body).toEqual({
            task_id: 12,
            status: "ready_for_pr",
            summary: "all done",
            work_repos: ["aws-lambda", "infra"],
            checks: "unit ok",
            next_steps: "PR",
        })
        expect(r.out).toBe(
            "T-12 ready_for_pr reported (status: ready_for_pr)\n"
        )
        const mismatch = await cc(
            ["report", "12", "ready_for_pr", "done", "--repos", "a"],
            {
                "POST /api/agent/cc_report": ok({
                    ok: false,
                    mismatch: { reported: ["a"], deliverables: [] },
                }),
            }
        )
        expect(mismatch.code).toBe(1)
        expect(mismatch.err).toMatch(/reported a; deliverables none/)
        const empty = await cc(["report", "12", "ready_for_pr", "done"], {
            "POST /api/agent/cc_report": ok({ ok: false }),
        })
        expect(empty.err).toMatch(/reported ; deliverables none/)
        expect((await cc(["report", "12", "review"])).code).toBe(2)
        const nc = await cc(
            [
                "report",
                "12",
                "review",
                "nothing",
                "needed",
                "--no-change",
                "aws-batch, web-trace",
            ],
            {
                "POST /api/agent/cc_report": ok({ ok: true, status: "review" }),
            }
        )
        expect(nc.code).toBe(0)
        expect(nc.fetch.calls[0].body).toEqual({
            task_id: 12,
            status: "review",
            summary: "nothing needed",
            no_change_repos: ["aws-batch", "web-trace"],
        })
    })

    test("feedback", async () => {
        const r = await cc(
            [
                "feedback",
                "12",
                "gh-rc-1",
                "fixed",
                "--commit",
                "abc1234",
                "--reply",
                "https://g/r",
                "--note",
                "done",
            ],
            {
                "POST /api/agent/cc_feedback": ok({
                    ok: true,
                    round: 2,
                    round_resolved: true,
                }),
            }
        )
        expect(r.fetch.calls[0].body).toEqual({
            task_id: 12,
            item_id: "gh-rc-1",
            status: "fixed",
            commit: "abc1234",
            reply_url: "https://g/r",
            note: "done",
        })
        expect(r.out).toBe("gh-rc-1 fixed (round 2 resolved)\n")
        const open = await cc(["feedback", "12", "ci-x", "fixed"], {
            "POST /api/agent/cc_feedback": ok({
                ok: true,
                round_resolved: false,
            }),
        })
        expect(open.out).toBe("ci-x fixed\n")
        expect((await cc(["feedback", "12", "x"])).code).toBe(2)
    })

    test("schedule", async () => {
        const r = await cc(
            ["schedule", "12", "in 30m", "prompt_agent", "re-check", "CI"],
            {
                "POST /api/agent/cc_schedule": ok({
                    schedule: { fire_at: "2026-11-07T12:30:00.000Z" },
                }),
            }
        )
        expect(r.fetch.calls[0].body).toEqual({
            task_id: 12,
            at: "in 30m",
            action: "prompt_agent",
            prompt: "re-check CI",
        })
        expect(r.out).toBe(
            "scheduled prompt_agent for T-12 at 2026-11-07T12:30:00.000Z\n"
        )
        const surface = await cc(["schedule", "12", "tomorrow", "surface"], {
            "POST /api/agent/cc_schedule": ok({}),
        })
        expect(surface.fetch.calls[0].body).toEqual({
            task_id: 12,
            at: "tomorrow",
            action: "surface",
        })
        expect(surface.out).toMatch(/at undefined/)
        expect((await cc(["schedule", "12", "tomorrow"])).code).toBe(2)
    })

    test("reparent", async () => {
        const r = await cc(["reparent", "T-32", "24"], {
            "POST /api/agent/cc_reparent_task": ok({
                ok: true,
                previous_parent_id: 29,
            }),
        })
        expect(r.fetch.calls[0].body).toEqual({ task_id: 32, parent_id: 24 })
        expect(r.out).toBe("T-32 moved under T-24 (was T-29)\n")
        const fresh = await cc(["reparent", "33", "24"], {
            "POST /api/agent/cc_reparent_task": ok({ ok: true }),
        })
        expect(fresh.out).toBe("T-33 moved under T-24\n")
        const same = await cc(["reparent", "32", "24"], {
            "POST /api/agent/cc_reparent_task": ok({
                ok: true,
                unchanged: true,
            }),
        })
        expect(same.out).toBe("T-32 already under T-24\n")
        expect((await cc(["reparent", "32"])).code).toBe(2)
    })

    test("validation errors show the first issue", async () => {
        const r = await cc(["feedback", "12", "x", "nope"], {
            "POST /api/agent/cc_feedback": () =>
                response(400, {
                    error: "validation",
                    message: "invalid arguments",
                    details: {
                        issues: [
                            { path: ["status"], message: "Invalid option" },
                        ],
                    },
                }),
        })
        expect(r.code).toBe(1)
        expect(r.err).toBe(
            "cc: 400 invalid arguments (status: Invalid option)\n"
        )
        const noPath = await cc(["feedback", "12", "x", "nope"], {
            "POST /api/agent/cc_feedback": () =>
                response(400, {
                    error: "validation",
                    details: { issues: [{ message: "bad" }] },
                }),
        })
        expect(noPath.err).toBe("cc: 400 validation (args: bad)\n")
    })
})
