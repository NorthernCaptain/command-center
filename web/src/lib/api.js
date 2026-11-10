/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// REST client. One function per route in docs/implementation/contracts.md.
// Errors are ApiError instances carrying { status, code, message, details };
// a 409 stale_revision exposes the server's current state as `.current`.

export class ApiError extends Error {
    constructor({ status = 0, code = "error", message = "", details } = {}) {
        super(message || code)
        this.name = "ApiError"
        this.status = status
        this.code = code
        this.details = details
    }

    /** For stale_revision: { content|task, revision } as sent by the server. */
    get current() {
        return (this.details && this.details.current) || null
    }

    /** Only a revision conflict: other 409s (illegal_transition,
     *  deliverables_open, ...) carry a message worth showing as is. */
    get isStale() {
        return this.code === "stale_revision"
    }
}

const STATUS_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    421: "misdirected",
    429: "rate_limited",
    500: "server_error",
    502: "bad_gateway",
    503: "unavailable",
}

function buildQuery(params) {
    if (!params) return ""
    const parts = []
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === "") continue
        const value = Array.isArray(v) ? v.join(",") : String(v)
        if (Array.isArray(v) && v.length === 0) continue
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`)
    }
    return parts.length ? `?${parts.join("&")}` : ""
}

/**
 * Create a client. `fetch` defaults to the global one looked up at call time
 * (so tests can replace globalThis.fetch).
 */
export function createApi({ fetch: fetchImpl, base = "" } = {}) {
    const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args)

    async function request(method, path, body, { signal } = {}) {
        const init = {
            method,
            credentials: "same-origin",
            headers: { Accept: "application/json" },
        }
        if (signal) init.signal = signal
        if (body !== undefined) {
            init.headers["Content-Type"] = "application/json"
            init.body = JSON.stringify(body)
        }
        let res
        try {
            res = await doFetch(base + path, init)
        } catch (err) {
            if (err && err.name === "AbortError") throw err
            throw new ApiError({
                status: 0,
                code: "network_error",
                message: "Can't reach the command center",
                details: { cause: String((err && err.message) || err) },
            })
        }
        const text = await res.text()
        let data = null
        if (text) {
            try {
                data = JSON.parse(text)
            } catch {
                data = { message: text }
            }
        }
        if (!res.ok) {
            throw new ApiError({
                status: res.status,
                code:
                    (data && data.error) ||
                    STATUS_CODES[res.status] ||
                    "http_error",
                message:
                    (data && data.message) ||
                    res.statusText ||
                    `HTTP ${res.status}`,
                details: data ? data.details : undefined,
            })
        }
        return data
    }

    const enc = encodeURIComponent
    const t = (id) => `/api/tasks/${enc(id)}`

    return {
        request,
        me: () => request("GET", "/api/me"),
        board: () => request("GET", "/api/board"),
        listTasks: (params = {}, opts) =>
            request("GET", `/api/tasks${buildQuery(params)}`, undefined, opts),
        createTask: (input) => request("POST", "/api/tasks", input),
        getTask: (id) => request("GET", t(id)),
        /** Known repos (AGENTS.md table) for the repo picker. */
        listRepos: () => request("GET", "/api/repos"),
        /**
         * PATCH a task. `snooze` is free text ("friday 2pm") the server
         * parses: it sets status waiting + snooze_until and schedules the
         * wake-up, or answers 400 when it can't read the text.
         */
        patchTask: (id, patch, baseRevision, { snooze } = {}) => {
            const body = {}
            if (patch && Object.keys(patch).length) body.patch = patch
            if (baseRevision) body.base_revision = baseRevision
            if (snooze) body.snooze = snooze
            return request("PATCH", t(id), body)
        },
        putArtifact: (id, content, baseRevision) =>
            request("PUT", `${t(id)}/artifact`, {
                content,
                base_revision: baseRevision,
            }),
        getHistory: (id) => request("GET", `${t(id)}/history`),
        getCommitDiff: (id, sha) =>
            request("GET", `${t(id)}/history/${enc(sha)}`),
        addComment: (id, { body, intent, anchor, parent_id }) => {
            const payload = { body, intent }
            if (anchor) payload.anchor = anchor
            if (parent_id) payload.parent_id = parent_id
            return request("POST", `${t(id)}/comments`, payload)
        },
        setCommentStatus: (id, cid, status) =>
            request("PATCH", `${t(id)}/comments/${enc(cid)}`, { status }),
        addSchedule: (id, { when, fire_at, action = "surface", note } = {}) => {
            const payload = { action }
            if (when) payload.when = when
            if (fire_at) payload.fire_at = fire_at
            if (note) payload.note = note
            return request("POST", `${t(id)}/schedules`, payload)
        },
        deleteSchedule: (sid) =>
            request("DELETE", `/api/schedules/${enc(sid)}`),
        createAsana: (id) => request("POST", `${t(id)}/asana`),
        closeOut: (id) => request("POST", `${t(id)}/close-out`),
        enrich: (id) => request("POST", `${t(id)}/enrich`),
        command: (text) => request("POST", "/api/command", { text }),
        getJob: (jid) => request("GET", `/api/jobs/${enc(jid)}`),
        cancelJob: (jid) => request("POST", `/api/jobs/${enc(jid)}/cancel`),
        getSettings: () => request("GET", "/api/settings"),
        patchSettings: (changes) => request("PATCH", "/api/settings", changes),
        pairCode: () => request("POST", "/api/pair/code"),
        pair: ({ code, name }) => request("POST", "/api/pair", { code, name }),
        listDevices: () => request("GET", "/api/devices"),
        revokeDevice: (did) => request("DELETE", `/api/devices/${enc(did)}`),
        healthz: () => request("GET", "/healthz"),

        // --- phase 2: herdr workers ------------------------------------
        /** Launch the worker agent. 202 { session }; 409 branch_conflict. */
        startTask: (id, { kind } = {}) =>
            request("POST", `${t(id)}/start`, kind ? { kind } : {}),
        /**
         * Worker action: create-pr | address-feedback | clean | focus |
         * send { text, quote? } | relaunch-codex | stop -> { ok, delivery? }
         */
        taskAction: (id, name, body = {}) =>
            request("POST", `${t(id)}/actions/${enc(name)}`, body),
        getAgent: (id) => request("GET", `${t(id)}/agent`),

        // --- phase 2: PR watcher ----------------------------------------
        pollPrs: (id) => request("POST", `${t(id)}/prs/poll`),
        postSlackNotice: (id) => request("POST", `${t(id)}/slack-notice`),
        dismissSlackNotice: (id) =>
            request("POST", `${t(id)}/slack-notice/dismiss`),
        checkSlackNotice: (id) =>
            request("POST", `${t(id)}/slack-notice/check`),
        claimPr: (id, url) => request("POST", `${t(id)}/prs/claim`, { url }),
        setDeliverable: (id, repo, disposition = "no_change") =>
            request("POST", `${t(id)}/deliverables/${enc(repo)}`, {
                disposition,
            }),
        reopenFeedback: (id, itemId) =>
            request("PATCH", `${t(id)}/feedback/${enc(itemId)}`, {
                status: "open",
            }),

        // --- phase 3 ----------------------------------------------------
        /** URL of the SOC2 evidence export (opened in a new tab). */
        soc2ExportUrl: ({ from, to, format = "md" } = {}) =>
            `${base}/api/soc2/export${buildQuery({ from, to, format })}`,
        soc2Export: ({ from, to } = {}) =>
            request(
                "GET",
                `/api/soc2/export${buildQuery({ from, to, format: "json" })}`
            ),
        pushKey: () => request("GET", "/api/push/key"),
        pushSubscribe: ({ endpoint, keys }) =>
            request("POST", "/api/push/subscribe", { endpoint, keys }),
        pushUnsubscribe: (endpoint) =>
            request("DELETE", "/api/push/subscribe", { endpoint }),
        getDigest: () => request("GET", "/api/digest"),
        runDigest: () => request("POST", "/api/digest/run"),
    }
}

export const api = createApi()

/**
 * 421 (Host does not match the configured public URL) or 503 (tailnet
 * access not configured) from the tailnet listener.
 */
export function isTailnetConfigError(err) {
    return err instanceof ApiError && (err.status === 421 || err.status === 503)
}

/** Message suitable for a toast. */
export function errorMessage(err) {
    if (!err) return "Something went wrong"
    if (err instanceof ApiError) {
        if (err.status === 401) return "Not signed in"
        if (err.status === 403) return "Owner access required"
        return err.message || err.code
    }
    return err.message || String(err)
}
