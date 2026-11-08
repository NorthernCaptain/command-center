/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { createAsanaClient, ASANA_BASE_URL } from "./asanaClient.js"

const TOKEN = "1/12345:supersecret"

function response(status, body, statusText = "") {
    const text =
        body === undefined
            ? ""
            : typeof body === "string"
              ? body
              : JSON.stringify(body)
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        text: async () => text,
    }
}

function fakeFetch(...responses) {
    const calls = []
    const fn = jest.fn(async (url, init) => {
        calls.push({ url: new URL(url), init })
        const next = responses.shift()
        if (next instanceof Error) throw next
        return next ?? response(200, { data: null })
    })
    fn.calls = calls
    return fn
}

describe("createAsanaClient.request", () => {
    test("GET with query unwraps data and sends auth headers", async () => {
        const fetch = fakeFetch(
            response(200, { data: { gid: "1", name: "x" } })
        )
        const log = { debug: jest.fn() }
        const client = createAsanaClient({ fetch, token: TOKEN, log })
        const data = await client.request("GET", "/tasks/1", {
            query: {
                opt_fields: ["name", "notes"],
                skip: undefined,
                nul: null,
                n: 5,
            },
        })
        expect(data).toEqual({ gid: "1", name: "x" })
        const { url, init } = fetch.calls[0]
        expect(url.origin + url.pathname).toBe(`${ASANA_BASE_URL}/tasks/1`)
        expect(url.searchParams.get("opt_fields")).toBe("name,notes")
        expect(url.searchParams.get("n")).toBe("5")
        expect(url.searchParams.has("skip")).toBe(false)
        expect(url.searchParams.has("nul")).toBe(false)
        expect(init.method).toBe("GET")
        expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
        expect(init.headers.Accept).toBe("application/json")
        expect(init.body).toBeUndefined()
        expect(init.signal).toBeDefined()
        expect(JSON.stringify(log.debug.mock.calls)).not.toContain(
            "supersecret"
        )
    })

    test("JSON body is wrapped in {data}", async () => {
        const fetch = fakeFetch(response(201, { data: { gid: "9" } }))
        const client = createAsanaClient({
            fetch,
            token: TOKEN,
            baseUrl: "https://example.test/api/",
            timeoutMs: 0,
        })
        await client.request("POST", "tasks", { body: { name: "T" } })
        const { url, init } = fetch.calls[0]
        expect(url.toString()).toBe("https://example.test/api/tasks")
        expect(init.headers["Content-Type"]).toBe("application/json")
        expect(JSON.parse(init.body)).toEqual({ data: { name: "T" } })
        expect(init.signal).toBeUndefined()
    })

    test("form is sent as multipart FormData without a content type", async () => {
        const fetch = fakeFetch(response(200, { data: { gid: "a" } }))
        const client = createAsanaClient({ fetch, token: TOKEN })
        await client.request("POST", "/attachments", {
            form: {
                parent: "1",
                resource_subtype: "external",
                url: "https://x",
                n: 3,
                skip: null,
            },
        })
        const { init } = fetch.calls[0]
        expect(init.body).toBeInstanceOf(FormData)
        expect(init.body.get("parent")).toBe("1")
        expect(init.body.get("resource_subtype")).toBe("external")
        expect(init.body.get("url")).toBe("https://x")
        expect(init.body.get("n")).toBe("3")
        expect(init.body.has("skip")).toBe(false)
        expect(init.headers["Content-Type"]).toBeUndefined()
    })

    test("accepts a ready FormData", async () => {
        const fetch = fakeFetch(response(200, { data: {} }))
        const client = createAsanaClient({ fetch, token: TOKEN })
        const fd = new FormData()
        fd.append("a", "b")
        await client.request("POST", "/attachments", { form: fd })
        expect(fetch.calls[0].init.body).toBe(fd)
    })

    test("token may be an async function, resolved once", async () => {
        const fetch = fakeFetch(
            response(200, { data: 1 }),
            response(200, { data: 2 })
        )
        const token = jest.fn(async () => TOKEN)
        const client = createAsanaClient({ fetch, token })
        expect(await client.request("GET", "/a")).toBe(1)
        expect(await client.request("GET", "/b")).toBe(2)
        expect(token).toHaveBeenCalledTimes(1)
    })

    test("missing token -> asana_not_configured", async () => {
        const fetch = fakeFetch()
        const client = createAsanaClient({ fetch, token: async () => null })
        await expect(client.request("GET", "/a")).rejects.toMatchObject({
            code: "asana_not_configured",
            status: 503,
        })
        expect(fetch).not.toHaveBeenCalled()
    })

    test("Asana errors are mapped and the token is scrubbed", async () => {
        const fetch = fakeFetch(
            response(400, {
                errors: [
                    { message: "name: Missing input" },
                    { message: `bad ${TOKEN}` },
                    {},
                ],
            })
        )
        const client = createAsanaClient({ fetch, token: TOKEN })
        const err = await client
            .request("POST", "/tasks", { body: {} })
            .catch((e) => e)
        expect(err.code).toBe("asana_error")
        expect(err.status).toBe(502)
        expect(err.details).toEqual({
            status: 400,
            method: "POST",
            path: "/tasks",
        })
        expect(err.message).toContain("name: Missing input")
        expect(err.message).toContain("(400)")
        expect(err.message).not.toContain("supersecret")
    })

    test("error without a JSON body uses the HTTP status", async () => {
        const fetch = fakeFetch(
            response(503, "<html>down</html>", "Service Unavailable"),
            response(404, undefined)
        )
        const client = createAsanaClient({ fetch, token: TOKEN })
        const err = await client.request("GET", "/x").catch((e) => e)
        expect(err.message).toContain("HTTP 503 Service Unavailable")
        const err2 = await client.request("GET", "/y").catch((e) => e)
        expect(err2.message).toContain("HTTP 404")
        expect(err2.details.status).toBe(404)
    })

    test("network failure -> asana_error", async () => {
        const fetch = fakeFetch(new Error(`connect ECONNREFUSED ${TOKEN}`))
        const log = { warn: jest.fn() }
        const client = createAsanaClient({ fetch, token: TOKEN, log })
        const err = await client.request("GET", "/x").catch((e) => e)
        expect(err.code).toBe("asana_error")
        expect(err.message).toContain("ECONNREFUSED")
        expect(err.message).not.toContain("supersecret")
        expect(log.warn).toHaveBeenCalled()
    })

    test("invalid JSON on success -> asana_error", async () => {
        const fetch = fakeFetch(response(200, "not json"))
        const client = createAsanaClient({ fetch, token: TOKEN })
        await expect(client.request("GET", "/x")).rejects.toMatchObject({
            code: "asana_error",
            message: "Asana returned invalid JSON",
        })
    })

    test("empty success body -> undefined data", async () => {
        const fetch = fakeFetch(response(204, undefined))
        const client = createAsanaClient({ fetch, token: TOKEN })
        await expect(client.request("DELETE", "/x")).resolves.toBeUndefined()
    })
})

describe("createAsanaClient.list", () => {
    test("follows next_page offsets", async () => {
        const fetch = fakeFetch(
            response(200, {
                data: [{ gid: "1" }],
                next_page: { offset: "abc" },
            }),
            response(200, { data: [{ gid: "2" }], next_page: null })
        )
        const client = createAsanaClient({ fetch, token: TOKEN })
        const items = await client.list("/projects/1/sections", {
            query: { opt_fields: "name" },
            pageSize: 1,
        })
        expect(items).toEqual([{ gid: "1" }, { gid: "2" }])
        expect(fetch.calls[0].url.searchParams.get("limit")).toBe("1")
        expect(fetch.calls[0].url.searchParams.has("offset")).toBe(false)
        expect(fetch.calls[1].url.searchParams.get("offset")).toBe("abc")
        expect(fetch.calls[1].url.searchParams.get("opt_fields")).toBe("name")
    })

    test("stops at maxPages and tolerates non-array data", async () => {
        const fetch = fakeFetch(
            response(200, { data: [{ gid: "1" }], next_page: { offset: "a" } }),
            response(200, { data: null, next_page: { offset: "b" } })
        )
        const log = { warn: jest.fn() }
        const client = createAsanaClient({ fetch, token: TOKEN, log })
        const items = await client.list("/x", { maxPages: 2 })
        expect(items).toEqual([{ gid: "1" }])
        expect(fetch).toHaveBeenCalledTimes(2)
        expect(log.warn).toHaveBeenCalled()
    })

    test("defaults", async () => {
        const fetch = fakeFetch(response(200, { data: [] }))
        const client = createAsanaClient({ fetch, token: TOKEN })
        await expect(client.list("/x")).resolves.toEqual([])
        expect(fetch.calls[0].url.searchParams.get("limit")).toBe("100")
    })
})
