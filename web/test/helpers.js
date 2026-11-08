/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Test helpers for the web project: a routed fetch mock and a fake
// EventSource.

export function reply(status, body) {
    return { __status: status, body }
}

function response(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: "",
        text: async () => (body === undefined ? "" : JSON.stringify(body)),
    }
}

/**
 * Install a fetch mock. routes: { "METHOD /path": value | fn({url, body}) }.
 * Values may be reply(status, body). Unknown routes -> 404.
 */
export function mockFetch(routes = {}) {
    const calls = []
    const fn = jest.fn(async (url, init = {}) => {
        const method = init.method || "GET"
        const path = url.split("?")[0]
        const body = init.body ? JSON.parse(init.body) : undefined
        calls.push({ method, url, path, body, init })
        let handler = routes[`${method} ${url}`]
        if (handler === undefined) handler = routes[`${method} ${path}`]
        if (handler === undefined) {
            return response(404, {
                error: "not_found",
                message: `no mock for ${method} ${path}`,
            })
        }
        if (typeof handler === "function")
            handler = await handler({ url, body, method })
        if (handler && handler.__status)
            return response(handler.__status, handler.body)
        return response(200, handler)
    })
    fn.calls = calls
    fn.find = (method, path) =>
        calls.filter((c) => c.method === method && c.path === path)
    global.fetch = fn
    return fn
}

export class FakeEventSource {
    static instances = []
    constructor(url, opts) {
        this.url = url
        this.opts = opts
        this.listeners = {}
        this.closed = false
        FakeEventSource.instances.push(this)
    }
    addEventListener(type, fn) {
        if (!this.listeners[type]) this.listeners[type] = []
        this.listeners[type].push(fn)
    }
    close() {
        this.closed = true
    }
    emit(type, data) {
        const msg = {
            data: typeof data === "string" ? data : JSON.stringify(data),
        }
        for (const fn of this.listeners[type] || []) fn(msg)
    }
    static reset() {
        FakeEventSource.instances = []
    }
    static last() {
        return FakeEventSource.instances[FakeEventSource.instances.length - 1]
    }
}

export const sampleTask = (over = {}) => ({
    id: 12,
    title: "Fix lambda timeout",
    kind: "todo",
    area: "backend",
    status: "active",
    prev_status: null,
    visibility: "auto",
    source: { type: "slack", url: "https://slack.example/x", text: null },
    due_at: null,
    snooze_until: null,
    repos: [],
    branch: null,
    asana: { gid: null, url: null },
    links: [],
    flags: { enriching: false, now: false, now_reason: null, error: null },
    created_at: "2026-11-06T10:00:00Z",
    updated_at: "2026-11-07T09:00:00Z",
    done_at: null,
    ...over,
})

/** Fake browser env with a service worker + PushManager. */
export function fakePushEnv({
    permission = "granted",
    existing = null,
    secure = true,
    registration = true,
} = {}) {
    const sub = {
        endpoint: "https://push.example/abc",
        toJSON: () => ({
            endpoint: "https://push.example/abc",
            keys: { p256dh: "P", auth: "A" },
        }),
        unsubscribe: jest.fn(async () => true),
    }
    const pushManager = {
        getSubscription: jest.fn(async () => existing),
        subscribe: jest.fn(async () => sub),
    }
    const reg = { pushManager }
    const serviceWorker = {
        register: jest.fn(async () => reg),
        ready: Promise.resolve(reg),
        getRegistration: jest.fn(async () => (registration ? reg : undefined)),
    }
    return {
        sub,
        pushManager,
        serviceWorker,
        env: {
            navigator: { serviceWorker },
            window: {
                isSecureContext: secure,
                PushManager: function PushManager() {},
                Notification: {
                    requestPermission: jest.fn(async () => permission),
                },
            },
        },
    }
}
