/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Thin Asana REST client: auth header, {data} envelope, JSON or multipart
// bodies, offset pagination and error mapping. The token never appears in
// logs or error messages.

import { AppError } from "../../util/errors.js"

export const ASANA_BASE_URL = "https://app.asana.com/api/1.0"

/**
 * @param {{ fetch?: typeof fetch, token: string | (() => string|null|Promise<string|null>),
 *           baseUrl?: string, log?: object, timeoutMs?: number }} deps
 */
export function createAsanaClient({
    fetch: fetchImpl = globalThis.fetch,
    token,
    baseUrl = ASANA_BASE_URL,
    log,
    timeoutMs = 30000,
} = {}) {
    const base = baseUrl.replace(/\/+$/, "")
    let cachedToken = null

    async function getToken() {
        if (cachedToken) return cachedToken
        const value = typeof token === "function" ? await token() : token
        if (!value) {
            throw new AppError(
                "asana_not_configured",
                "Asana token is not configured",
                { status: 503 }
            )
        }
        cachedToken = value
        return value
    }

    function scrub(text, secret) {
        const s = String(text ?? "")
        return secret ? s.split(secret).join("***") : s
    }

    function buildUrl(path, query) {
        const url = new URL(base + (path.startsWith("/") ? path : `/${path}`))
        for (const [k, v] of Object.entries(query || {})) {
            if (v === undefined || v === null) continue
            url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v))
        }
        return url
    }

    function buildForm(form) {
        if (form instanceof FormData) return form
        const fd = new FormData()
        for (const [k, v] of Object.entries(form)) {
            if (v === undefined || v === null) continue
            fd.append(
                k,
                typeof v === "string" || v instanceof Blob ? v : String(v)
            )
        }
        return fd
    }

    /** Low level: returns the whole parsed JSON ({ data, next_page, ... }). */
    async function raw(method, path, { query, body, form } = {}) {
        const secret = await getToken()
        const url = buildUrl(path, query)
        const headers = {
            Authorization: `Bearer ${secret}`,
            Accept: "application/json",
        }
        const init = { method, headers }
        if (form) {
            init.body = buildForm(form) // fetch sets the multipart boundary
        } else if (body !== undefined) {
            headers["Content-Type"] = "application/json"
            init.body = JSON.stringify({ data: body })
        }
        if (timeoutMs && typeof AbortSignal?.timeout === "function") {
            init.signal = AbortSignal.timeout(timeoutMs)
        }

        let res
        try {
            res = await fetchImpl(url.toString(), init)
        } catch (err) {
            log?.warn?.({ method, path: url.pathname }, "asana request failed")
            throw new AppError(
                "asana_error",
                `Asana request failed: ${scrub(err?.message, secret)}`,
                { status: 502, details: { status: null, method, path } }
            )
        }

        const text = await res.text()
        let json = null
        if (text) {
            try {
                json = JSON.parse(text)
            } catch {
                json = null
            }
        }
        log?.debug?.(
            { method, path: url.pathname, status: res.status },
            "asana request"
        )

        if (!res.ok) {
            const messages = Array.isArray(json?.errors)
                ? json.errors.map((e) => e?.message).filter(Boolean)
                : []
            const msg = messages.length
                ? messages.join("; ")
                : `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`
            throw new AppError(
                "asana_error",
                `Asana ${method} ${path} failed (${res.status}): ${scrub(msg, secret)}`,
                { status: 502, details: { status: res.status, method, path } }
            )
        }
        if (text && json === null) {
            throw new AppError("asana_error", "Asana returned invalid JSON", {
                status: 502,
                details: { status: res.status, method, path },
            })
        }
        return json ?? {}
    }

    /** Request and unwrap the {data} envelope. */
    async function request(method, path, opts = {}) {
        const json = await raw(method, path, opts)
        return json.data
    }

    /**
     * GET a list endpoint and follow `next_page.offset` until exhausted.
     * @returns {Promise<object[]>}
     */
    async function list(
        path,
        { query = {}, pageSize = 100, maxPages = 50 } = {}
    ) {
        const items = []
        let offset
        for (let page = 0; page < maxPages; page++) {
            const json = await raw("GET", path, {
                query: { ...query, limit: pageSize, offset },
            })
            if (Array.isArray(json.data)) items.push(...json.data)
            offset = json.next_page?.offset
            if (!offset) return items
        }
        log?.warn?.({ path, maxPages }, "asana pagination stopped at maxPages")
        return items
    }

    return { request, list, raw }
}
