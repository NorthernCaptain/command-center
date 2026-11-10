/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { createFakeClock } from "../../util/clock.js"
import { AppError } from "../../util/errors.js"
import { MANAGED_MARKER } from "./asanaNotes.js"
import {
    createAsanaService,
    creationMarker,
    parseAsanaTaskGid,
    SECTION_CACHE_MS,
} from "./asanaService.js"

const CONFIG = {
    projectGid: "1111111111111111",
    assigneeGid: "222222222222222",
}
const STATUS_FIELD = {
    gid: "900",
    options: {
        initial: "901",
        in_progress: "902",
        code_review: "903",
        released: "904",
        cancelled: "905",
    },
}
const WITH_STATUS = { ...CONFIG, statusField: STATUS_FIELD }
const SECTIONS = [
    { gid: "s-back", name: "Backlog" },
    { gid: "s-oct", name: "Oct 26 - Nov 1" },
    { gid: "1300", name: "Nov 2 - Nov 8" },
]

/** Fake Asana client recording calls; `handlers` map "METHOD path" -> fn. */
function fakeClient(handlers = {}) {
    const calls = []
    const lists = []
    return {
        calls,
        lists,
        request: jest.fn(async (method, path, opts = {}) => {
            calls.push({ method, path, ...opts })
            const h = handlers[`${method} ${path}`]
            return typeof h === "function" ? h(opts) : h
        }),
        list: jest.fn(async (path, opts) => {
            lists.push({ path, ...opts })
            return handlers[`LIST ${path}`] ?? SECTIONS
        }),
    }
}

function task(overrides = {}) {
    return {
        id: 123,
        title: "Fix upload retry",
        status: "active",
        updated_at: "2026-11-07T10:00:00Z",
        source: {
            type: "slack",
            url: "https://acme.slack.com/archives/C1/p1",
            text: null,
        },
        repos: [{ name: "aws-lambda", role: "main" }],
        deliverables: [
            {
                repo: "aws-lambda",
                branch: "t123-fix",
                role: "work",
                pr: "https://github.com/acme/aws-lambda/pull/812",
            },
        ],
        links: [],
        asana: {
            gid: null,
            url: null,
            section_gid: null,
            no_section: false,
            attachments: [],
        },
        ...overrides,
    }
}

const PROSE = {
    summary: "Uploads fail.",
    context: "Ron asked.",
    acceptance: ["Retries"],
    approach: "Backoff.",
}

// Local noon on Nov 7 2026 regardless of the machine timezone.
const localClock = () =>
    createFakeClock(new Date(2026, 10, 7, 12).toISOString())

describe("resolveSprintSection", () => {
    test("picks the current section and caches the list for 24h", async () => {
        const clock = localClock()
        const client = fakeClient()
        const svc = createAsanaService({
            githubOrg: "acme",
            client,
            config: CONFIG,
            clock,
        })
        await expect(svc.resolveSprintSection()).resolves.toEqual({
            gid: "1300",
            name: "Nov 2 - Nov 8",
        })
        expect(client.lists[0]).toEqual({
            path: "/projects/1111111111111111/sections",
            query: { opt_fields: "name" },
        })
        await svc.resolveSprintSection(new Date(2026, 9, 30, 9))
        expect(client.list).toHaveBeenCalledTimes(1)
        await clock.advance(SECTION_CACHE_MS - 1)
        await svc.resolveSprintSection()
        expect(client.list).toHaveBeenCalledTimes(1)
        await clock.advance(1)
        await svc.resolveSprintSection()
        expect(client.list).toHaveBeenCalledTimes(2)
    })

    test("explicit date and no match", async () => {
        const svc = createAsanaService({
            githubOrg: "acme",
            client: fakeClient(),
            config: CONFIG,
            clock: localClock(),
        })
        expect(
            (await svc.resolveSprintSection(new Date(2026, 9, 30, 9))).gid
        ).toBe("s-oct")
        expect(await svc.resolveSprintSection(new Date(2026, 5, 1))).toBeNull()
    })

    test("a miss on a cached list refetches once (this week's section appeared)", async () => {
        const clock = localClock() // Sat Nov 7
        let sections = [{ gid: "old", name: "Oct 26 - Oct 30" }]
        const client = fakeClient()
        client.list.mockImplementation(async () => sections)
        const svc = createAsanaService({
            githubOrg: "acme",
            client,
            config: CONFIG,
            clock,
        })
        // fresh fetch + miss: no second fetch
        expect(await svc.resolveSprintSection()).toBeNull()
        expect(client.list).toHaveBeenCalledTimes(1)
        // Monday: the cached list misses -> refetch finds the new section
        sections = [...sections, { gid: "new", name: "Nov 9 - Nov 13" }]
        expect(
            await svc.resolveSprintSection(new Date(2026, 10, 9, 9))
        ).toEqual({ gid: "new", name: "Nov 9 - Nov 13" })
        expect(client.list).toHaveBeenCalledTimes(2)
        // still a miss after refetch -> null, one refetch per call
        expect(await svc.resolveSprintSection(new Date(2026, 5, 1))).toBeNull()
        expect(client.list).toHaveBeenCalledTimes(3)
    })

    test("invalid project gid", async () => {
        const svc = createAsanaService({
            githubOrg: "acme",
            client: fakeClient(),
            config: { projectGid: "../x" },
        })
        await expect(svc.resolveSprintSection()).rejects.toMatchObject({
            code: "validation",
        })
    })
})

describe("createForTask", () => {
    test("a failed move to the section keeps the task, flagged no_section", async () => {
        const client = fakeClient({
            "POST /tasks": { gid: "556", permalink_url: "u" },
            "POST /sections/1300/addTask": () => {
                throw new Error("Asana 403")
            },
            "POST /attachments": {},
        })
        const log = { info: jest.fn(), warn: jest.fn() }
        const svc = createAsanaService({
            githubOrg: "acme",
            client,
            config: CONFIG,
            clock: localClock(),
            log,
            timeZone: "UTC",
        })
        const out = await svc.createForTask(task(), PROSE)
        expect(out).toMatchObject({
            gid: "556",
            section_gid: null,
            no_section: true,
        })
        expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ gid: "556", err: "Asana 403" }),
            "asana task created but not moved to the sprint section"
        )
    })

    test("creates in the sprint section with description, block and attachments", async () => {
        const client = fakeClient({
            "POST /tasks": {
                gid: "555",
                permalink_url: "https://app.asana.com/0/0/555",
            },
            "POST /attachments": { gid: "att" },
            "POST /sections/1300/addTask": {},
        })
        const log = { info: jest.fn(), warn: jest.fn() }
        const svc = createAsanaService({
            githubOrg: "acme",
            client,
            config: CONFIG,
            clock: localClock(),
            publicBaseUrl: "https://mac.tail.ts.net:8443/",
            log,
            timeZone: "UTC",
        })
        const out = await svc.createForTask(task(), PROSE)
        expect(out).toEqual({
            gid: "555",
            url: "https://app.asana.com/0/0/555",
            section_gid: "1300",
            no_section: false,
            attachments: [
                "https://mac.tail.ts.net:8443/t/123",
                "https://github.com/acme/aws-lambda/tree/t123-fix",
                "https://github.com/acme/aws-lambda/pull/812",
            ],
        })
        const create = client.calls[0]
        expect(create.method).toBe("POST")
        expect(create.path).toBe("/tasks")
        expect(create.query).toEqual({ opt_fields: "gid,permalink_url" })
        // Asana requires projects on create; the section is set after
        expect(create.body).toMatchObject({
            name: "Fix upload retry",
            assignee: "222222222222222",
            projects: ["1111111111111111"],
        })
        expect(create.body.memberships).toBeUndefined()
        expect(client.calls[1]).toMatchObject({
            method: "POST",
            path: "/sections/1300/addTask",
            body: { task: "555" },
        })
        const notes = create.body.html_notes
        expect(
            notes.startsWith("<body><strong>Summary</strong>\nUploads fail.")
        ).toBe(true)
        expect(notes).toContain(
            'Source: <a href="https://acme.slack.com/archives/C1/p1">'
        )
        expect(notes).toContain(MANAGED_MARKER)
        expect(notes).toContain("https://mac.tail.ts.net:8443/t/123")
        expect(notes).toContain("· updated 2026-11-07 10:00</em>")
        expect(notes.endsWith("</em></body>")).toBe(true)

        const attach = client.calls.slice(2) // after create + addTask
        expect(attach.map((c) => c.path)).toEqual([
            "/attachments",
            "/attachments",
            "/attachments",
        ])
        expect(attach[0].form).toEqual({
            parent: "555",
            resource_subtype: "external",
            url: "https://mac.tail.ts.net:8443/t/123",
            name: "Command Center T-123",
        })
        expect(attach[1].form.name).toBe("aws-lambda @ t123-fix")
        expect(attach[2].form.name).toBe("PR aws-lambda#812")
        expect(log.info).toHaveBeenCalled()
    })

    test("no section, no assignee, no public url, failing attachment", async () => {
        const client = fakeClient({
            "LIST /projects/1/sections": [{ gid: "b", name: "Backlog" }],
            "POST /tasks": { gid: 777 },
            "POST /attachments": (opts) => {
                if (opts.form.url.includes("/pull/"))
                    throw new AppError("asana_error", "boom")
                return { gid: "ok" }
            },
        })
        const log = { warn: jest.fn() }
        const svc = createAsanaService({
            githubOrg: "acme",
            client,
            config: { projectGid: "1" },
            clock: localClock(),
            log,
        })
        const t = task({
            links: [
                {
                    id: "b",
                    type: "branch",
                    url: "https://gitlab.example/b",
                    label: "lbl",
                },
            ],
        })
        const out = await svc.createForTask(t)
        expect(out).toEqual({
            gid: "777",
            url: null,
            section_gid: null,
            no_section: true,
            attachments: [
                "https://github.com/acme/aws-lambda/tree/t123-fix",
                "https://gitlab.example/b",
            ],
        })
        const body = client.calls[0].body
        expect(body.memberships).toBeUndefined()
        expect(body.assignee).toBeUndefined()
        expect(body.projects).toEqual(["1"])
        expect(body.html_notes).not.toContain("Artifact:")
        expect(
            client.calls.find((c) => c.form?.url === "https://gitlab.example/b")
                .form.name
        ).toBe("lbl")
        expect(log.warn).toHaveBeenCalledTimes(1)
    })

    test("skips attachments already tracked", async () => {
        const client = fakeClient({ "POST /tasks": { gid: "1" } })
        const svc = createAsanaService({
            githubOrg: "acme",
            client,
            config: CONFIG,
            clock: localClock(),
        })
        const t = task({
            asana: {
                attachments: [
                    "https://github.com/acme/aws-lambda/tree/t123-fix",
                    "https://github.com/acme/aws-lambda/pull/812",
                ],
            },
        })
        const out = await svc.createForTask(t, PROSE)
        expect(
            client.calls.filter((c) => c.path === "/attachments")
        ).toHaveLength(0)
        expect(out.attachments).toHaveLength(2)
    })

    test("propagates task creation errors", async () => {
        const client = fakeClient({
            "POST /tasks": () => {
                throw new AppError("asana_error", "nope")
            },
        })
        const svc = createAsanaService({
            githubOrg: "acme",
            client,
            config: CONFIG,
            clock: localClock(),
        })
        await expect(svc.createForTask(task(), PROSE)).rejects.toThrow("nope")
    })
})

describe("syncTracking", () => {
    test("replaces the managed block, keeps teammate text, adds missing attachments", async () => {
        const existing =
            "<body>Teammate text<hr/><h2>Command Center</h2><strong>Status:</strong> old</body>"
        const client = fakeClient({
            "GET /tasks/555": { html_notes: existing },
            "PUT /tasks/555": {},
            "POST /attachments": {},
        })
        const svc = createAsanaService({
            githubOrg: "acme",
            client,
            config: CONFIG,
            clock: localClock(),
            publicBaseUrl: "https://h",
            timeZone: "UTC",
        })
        const t = task({
            status: "pr_open",
            asana: { gid: "555", attachments: ["https://h/t/123"] },
        })
        const { attachments, failed } = await svc.syncTracking(t)
        expect(failed).toEqual([])
        expect(client.calls[0]).toMatchObject({
            method: "GET",
            path: "/tasks/555",
            query: {
                opt_fields:
                    "html_notes,custom_fields.gid,custom_fields.enum_value.gid",
            },
        })
        const put = client.calls[1]
        expect(put.method).toBe("PUT")
        expect(
            put.body.html_notes.startsWith(
                `<body>Teammate text${MANAGED_MARKER}`
            )
        ).toBe(true)
        expect(put.body.html_notes).toContain(" · pr_open · updated ")
        expect(attachments).toEqual([
            "https://h/t/123",
            "https://github.com/acme/aws-lambda/tree/t123-fix",
            "https://github.com/acme/aws-lambda/pull/812",
        ])
    })

    test("no PUT when the block is unchanged", async () => {
        const svc0 = createAsanaService({
            githubOrg: "acme",
            client: fakeClient(),
            config: CONFIG,
            timeZone: "UTC",
        })
        const t = task({
            deliverables: [],
            asana: { gid: "9", attachments: [] },
        })
        // Build what the service would write, then feed it back.
        const client1 = fakeClient({
            "GET /tasks/9": { html_notes: "<body>X</body>" },
            "PUT /tasks/9": {},
        })
        const svc1 = createAsanaService({
            githubOrg: "acme",
            client: client1,
            config: CONFIG,
            timeZone: "UTC",
        })
        await svc1.syncTracking(t)
        const written = client1.calls[1].body.html_notes
        const client2 = fakeClient({ "GET /tasks/9": { html_notes: written } })
        const svc2 = createAsanaService({
            githubOrg: "acme",
            client: client2,
            config: CONFIG,
            timeZone: "UTC",
        })
        await expect(svc2.syncTracking(t)).resolves.toEqual({
            attachments: [],
            failed: [],
        })
        expect(client2.calls.map((c) => c.method)).toEqual(["GET"])
        expect(svc0.artifactUrlFor(t)).toBeNull()
    })

    test("reports attachments that failed, keeps the ones that worked", async () => {
        let n = 0
        const client = fakeClient({
            "GET /tasks/555": { html_notes: "<body></body>" },
            "PUT /tasks/555": {},
            "POST /attachments": () => {
                if (++n === 1) throw new Error("asana 500")
                return {}
            },
        })
        const svc = createAsanaService({
            githubOrg: "acme",
            client,
            config: CONFIG,
            timeZone: "UTC",
        })
        const res = await svc.syncTracking(
            task({ asana: { gid: "555", attachments: [] } })
        )
        expect(res).toEqual({
            attachments: ["https://github.com/acme/aws-lambda/pull/812"],
            failed: ["https://github.com/acme/aws-lambda/tree/t123-fix"],
        })
    })

    test("requires an Asana gid", async () => {
        const svc = createAsanaService({
            githubOrg: "acme",
            client: fakeClient(),
            config: CONFIG,
        })
        await expect(svc.syncTracking(task())).rejects.toMatchObject({
            code: "validation",
        })
        await expect(svc.syncTracking({})).rejects.toMatchObject({
            code: "validation",
        })
    })
})

describe("comment / complete / getTask", () => {
    test("comment posts a story", async () => {
        const client = fakeClient({ "POST /tasks/5/stories": { gid: "st" } })
        const svc = createAsanaService({
            githubOrg: "acme",
            client,
            config: CONFIG,
        })
        await expect(svc.comment("5", "Done: PR merged")).resolves.toEqual({
            gid: "st",
        })
        expect(client.calls[0].body).toEqual({ text: "Done: PR merged" })
    })

    test("commentHtml posts a rich-text story", async () => {
        const client = fakeClient({ "POST /tasks/5/stories": { gid: "st" } })
        const svc = createAsanaService({
            githubOrg: "acme",
            client,
            config: CONFIG,
        })
        await svc.commentHtml("5", "<body>ok</body>")
        expect(client.calls[0].body).toEqual({ html_text: "<body>ok</body>" })
        await expect(svc.commentHtml("../x", "t")).rejects.toThrow()
    })

    test("complete sets completed", async () => {
        const client = fakeClient({ "PUT /tasks/5": { completed: true } })
        const svc = createAsanaService({
            githubOrg: "acme",
            client,
            config: CONFIG,
        })
        await svc.complete("5")
        expect(client.calls[0]).toMatchObject({
            method: "PUT",
            body: { completed: true },
        })
    })

    test("getTask normalizes fields", async () => {
        const client = fakeClient({
            "GET /tasks/5": {
                name: "N",
                notes: "x",
                permalink_url: "u",
                completed: 1,
            },
            "GET /tasks/6": null,
        })
        const svc = createAsanaService({
            githubOrg: "acme",
            client,
            config: CONFIG,
        })
        await expect(svc.getTask("5")).resolves.toEqual({
            gid: "5",
            name: "N",
            notes: "x",
            permalink_url: "u",
            completed: true,
        })
        expect(client.calls[0].query).toEqual({
            opt_fields: "name,notes,permalink_url,completed",
        })
        await expect(svc.getTask("6")).resolves.toEqual({
            gid: "6",
            name: null,
            notes: "",
            permalink_url: null,
            completed: false,
        })
    })

    test("rejects non-numeric gids", async () => {
        const svc = createAsanaService({
            githubOrg: "acme",
            client: fakeClient(),
            config: CONFIG,
        })
        await expect(svc.comment("../x", "t")).rejects.toMatchObject({
            code: "validation",
        })
        await expect(svc.complete(5)).rejects.toMatchObject({
            code: "validation",
        })
        await expect(svc.getTask("")).rejects.toMatchObject({
            code: "validation",
        })
    })
})

describe("parseAsanaTaskGid", () => {
    test.each([
        [
            "https://app.asana.com/0/1111111111111111/1213000000000001",
            "1213000000000001",
        ],
        [
            "https://app.asana.com/0/1111111111111111/1213000000000001/f",
            "1213000000000001",
        ],
        [
            "https://app.asana.com/1/33333333333/project/1111111111111111/task/1213000000000002?focus=true",
            "1213000000000002",
        ],
        [
            "https://app.asana.com/1/33333333333/task/1213000000000003",
            "1213000000000003",
        ],
        ["https://app.asana.com/1/33333333333/task/abc", null],
        ["https://app.asana.com/1/33333333333/project/1111111111111111", null],
        ["https://evil.example/0/1/2", null],
        ["not a url", null],
        [null, null],
    ])("%s", (url, gid) => {
        expect(parseAsanaTaskGid(url)).toBe(gid)
    })
})

describe("idempotent creation (marker)", () => {
    const MARK = creationMarker(123, "abc123")
    const svcWith = (client, extra = {}) =>
        createAsanaService({
            githubOrg: "acme",
            client,
            config: CONFIG,
            clock: localClock(),
            publicBaseUrl: "https://mac.tail.ts.net:8443",
            log: { info: jest.fn(), warn: jest.fn() },
            ...extra,
        })
    const existing = (notes) => [
        {
            gid: "888",
            notes,
            permalink_url: "https://app.asana.com/0/0/888",
            memberships: [{ section: null }, { section: { gid: "1300" } }],
        },
    ]

    test("creationMarker", () => {
        expect(MARK).toBe("Command-Center-Task: T-123 abc123")
    })

    test("writes the marker into the managed block", async () => {
        const client = fakeClient({ "POST /tasks": { gid: "1" } })
        await svcWith(client).createForTask(task(), PROSE, { marker: MARK })
        const notes = client.calls[0].body.html_notes
        expect(notes).toMatch(
            /\n<em>Command-Center-Task: T-123 abc123<\/em><\/body>$/
        )
    })

    test("earlier marker found: adopts the task, no POST, no duplicate attachments", async () => {
        const client = fakeClient({
            "LIST /tasks": existing(`Summary\n\nTask: T-123\n${MARK}`),
            "LIST /attachments": [
                { name: "x", view_url: "https://mac.tail.ts.net:8443/t/123" },
                { name: "no url" },
            ],
            "POST /attachments": { gid: "a" },
        })
        const out = await svcWith(client).createForTask(task(), PROSE, {
            marker: creationMarker(123, "new"),
            priorMarkers: [MARK],
            since: "2026-11-07T11:50:00.000Z",
        })
        expect(out).toEqual({
            gid: "888",
            url: "https://app.asana.com/0/0/888",
            section_gid: "1300",
            no_section: false,
            adopted: true,
            attachments: [
                "https://mac.tail.ts.net:8443/t/123",
                "https://github.com/acme/aws-lambda/tree/t123-fix",
                "https://github.com/acme/aws-lambda/pull/812",
            ],
        })
        expect(client.calls.some((c) => c.path === "/tasks")).toBe(false)
        expect(
            client.calls.filter((c) => c.path === "/attachments")
        ).toHaveLength(2)
        const q = client.lists.find((l) => l.path === "/tasks").query
        expect(q).toEqual({
            project: "1111111111111111",
            modified_since: "2026-11-07T11:50:00.000Z",
            opt_fields: "name,notes,permalink_url,memberships.section",
        })
    })

    test("prior marker not found (or only a longer nonce): creates normally", async () => {
        const client = fakeClient({
            "LIST /tasks": existing(`${MARK}9 other task`),
            "POST /tasks": { gid: "1", permalink_url: "p" },
        })
        const out = await svcWith(client).createForTask(task(), PROSE, {
            marker: creationMarker(123, "n2"),
            priorMarkers: [MARK],
        })
        expect(out.gid).toBe("1")
        expect(out.adopted).toBeUndefined()
        expect(
            client.lists.find((l) => l.path === "/tasks").query
        ).not.toHaveProperty("modified_since")
    })

    test("prior lookup failing throws instead of creating blindly", async () => {
        const client = fakeClient({ "POST /tasks": { gid: "1" } })
        client.list.mockImplementation(async (path) => {
            if (path === "/tasks") throw new AppError("asana_error", "down")
            return SECTIONS
        })
        await expect(
            svcWith(client).createForTask(task(), PROSE, {
                marker: "m2",
                priorMarkers: [MARK],
            })
        ).rejects.toThrow("down")
        expect(client.calls).toHaveLength(0)
    })

    test("POST timeout but the task exists: adopted instead of failing", async () => {
        const marker = creationMarker(123, "n1")
        const client = fakeClient({
            "POST /tasks": () => {
                throw new AppError(
                    "asana_error",
                    "Asana request failed: timeout"
                )
            },
            "LIST /tasks": existing(`x ${marker}`),
            "LIST /attachments": [],
            "POST /attachments": { gid: "a" },
        })
        const out = await svcWith(client).createForTask(task(), PROSE, {
            marker,
            since: "2026-11-07T11:50:00.000Z",
        })
        expect(out).toMatchObject({ gid: "888", adopted: true })
    })

    test("POST failure without a match (or a failing lookup) rethrows the POST error", async () => {
        const marker = creationMarker(123, "n1")
        const boom = () => {
            throw new AppError("asana_error", "Asana POST /tasks failed (500)")
        }
        const c1 = fakeClient({ "POST /tasks": boom, "LIST /tasks": [] })
        await expect(
            svcWith(c1).createForTask(task(), PROSE, { marker })
        ).rejects.toThrow(/failed \(500\)/)

        const c2 = fakeClient({ "POST /tasks": boom })
        c2.list.mockImplementation(async (path) => {
            if (path === "/tasks") throw new Error("lookup down")
            return SECTIONS
        })
        await expect(
            svcWith(c2).createForTask(task(), PROSE, { marker })
        ).rejects.toThrow(/failed \(500\)/)

        // no marker: no lookup at all
        const c3 = fakeClient({ "POST /tasks": boom })
        await expect(svcWith(c3).createForTask(task(), PROSE)).rejects.toThrow(
            /500/
        )
        expect(c3.lists.some((l) => l.path === "/tasks")).toBe(false)
    })

    test("adopt: attachment listing failure is tolerated; no section -> no_section", async () => {
        const client = fakeClient({
            "LIST /tasks": [{ gid: 5, notes: MARK }],
            "POST /attachments": { gid: "a" },
        })
        client.list.mockImplementation(async (path) => {
            if (path === "/attachments") throw new Error("nope")
            if (path === "/tasks") return [{ gid: 5, notes: MARK }]
            return SECTIONS
        })
        const out = await svcWith(client).createForTask(task(), PROSE, {
            priorMarkers: [MARK],
        })
        expect(out).toMatchObject({
            gid: "5",
            url: null,
            section_gid: null,
            no_section: true,
            adopted: true,
        })
        expect(await svcWith(client).findByMarker([], null)).toBeNull()
        expect(await svcWith(client).findByMarker(null)).toBeNull()
    })
})

test("publicBaseUrl may be a getter resolved at use time", async () => {
    const { createAsanaService } = await import("./asanaService.js")
    let url = null
    const svc = createAsanaService({
        githubOrg: "acme",
        client: { request: async () => ({}), list: async () => [] },
        config: { projectGid: "1" },
        publicBaseUrl: () => url,
    })
    expect(svc.artifactUrlFor({ id: 5 })).toBeNull()
    url = "https://mac.ts.net:8443/"
    expect(svc.artifactUrlFor({ id: 5 })).toBe("https://mac.ts.net:8443/t/5")
})

describe("Asana Status custom field", () => {
    const svcWith = (client, config = WITH_STATUS) =>
        createAsanaService({
            githubOrg: "acme",
            client,
            config,
            clock: localClock(),
            publicBaseUrl: "https://h",
            timeZone: "UTC",
        })

    test("a new task gets the Status for its current status", async () => {
        const client = fakeClient({
            "POST /tasks": { gid: "556", permalink_url: "u" },
            "POST /sections/1300/addTask": {},
            "POST /attachments": {},
        })
        await svcWith(client).createForTask(task({ status: "inbox" }), PROSE)
        const post = client.calls.find(
            (c) => c.method === "POST" && c.path === "/tasks"
        )
        expect(post.body.custom_fields).toEqual({ 900: "901" })
        // without the config: no custom_fields
        const plain = fakeClient({
            "POST /tasks": { gid: "557", permalink_url: "u" },
            "POST /sections/1300/addTask": {},
            "POST /attachments": {},
        })
        await svcWith(plain, CONFIG).createForTask(
            task({ status: "inbox" }),
            PROSE
        )
        const post2 = plain.calls.find(
            (c) => c.method === "POST" && c.path === "/tasks"
        )
        expect(post2.body.custom_fields).toBeUndefined()
    })

    test("sync sets the Status when it differs, and only then", async () => {
        const at = (enumGid) => ({
            "GET /tasks/555": {
                html_notes: "<body>x</body>",
                custom_fields: [
                    { gid: "123", enum_value: { gid: "1" } },
                    {
                        gid: "900",
                        enum_value: enumGid ? { gid: enumGid } : null,
                    },
                ],
            },
            "PUT /tasks/555": {},
            "POST /attachments": {},
        })
        const t = (status) =>
            task({ status, asana: { gid: "555", attachments: [] } })

        // active -> In progress (was Initial)
        let client = fakeClient(at("901"))
        await svcWith(client).syncTracking(t("active"))
        let put = client.calls.find((c) => c.method === "PUT")
        expect(put.body.custom_fields).toEqual({ 900: "902" })

        for (const [status, option] of [
            ["ready_for_pr", "903"],
            ["pr_open", "903"],
            ["pr_feedback", "903"],
            ["done", "904"],
            ["cancelled", "905"],
            ["ready", "901"],
        ]) {
            client = fakeClient(at(null))
            await svcWith(client).syncTracking(t(status))
            put = client.calls.find((c) => c.method === "PUT")
            expect(put.body.custom_fields).toEqual({ 900: option })
        }

        // already right: no custom_fields in the PUT
        client = fakeClient(at("902"))
        await svcWith(client).syncTracking(t("active"))
        put = client.calls.find((c) => c.method === "PUT")
        expect(put && put.body.custom_fields).toBeUndefined()

        // waiting / review leave Asana's Status alone
        for (const status of ["waiting", "review"]) {
            client = fakeClient(at("903"))
            await svcWith(client).syncTracking(t(status))
            put = client.calls.find((c) => c.method === "PUT")
            expect(put && put.body.custom_fields).toBeUndefined()
        }

        // field missing on the task: set it
        client = fakeClient({
            "GET /tasks/555": { html_notes: "<body>x</body>" },
            "PUT /tasks/555": {},
            "POST /attachments": {},
        })
        await svcWith(client).syncTracking(t("done"))
        put = client.calls.find((c) => c.method === "PUT")
        expect(put.body.custom_fields).toEqual({ 900: "904" })
    })

    test("no statusField config: Status is never touched", async () => {
        const client = fakeClient({
            "GET /tasks/555": { html_notes: "<body>x</body>" },
            "PUT /tasks/555": {},
            "POST /attachments": {},
        })
        await svcWith(client, {
            ...CONFIG,
            statusField: { gid: "900" },
        }).syncTracking(
            task({ status: "done", asana: { gid: "555", attachments: [] } })
        )
        const put = client.calls.find((c) => c.method === "PUT")
        expect(put && put.body.custom_fields).toBeUndefined()
    })
})
