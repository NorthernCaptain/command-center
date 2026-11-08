/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

/* eslint-env serviceworker */

// Service worker: Web Push only (no offline cache). The server sends
// { title, body, url } (see server push.sendAll); the notification opens
// or focuses the app at `url`.

self.addEventListener("install", () => self.skipWaiting())

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim())
})

function parsePayload(event) {
    if (!event.data) return {}
    try {
        return event.data.json() || {}
    } catch {
        return { body: event.data.text() }
    }
}

self.addEventListener("push", (event) => {
    const p = parsePayload(event)
    const title = p.title || "Command Center"
    const url = p.url || "/"
    event.waitUntil(
        self.registration.showNotification(title, {
            body: p.body || "",
            icon: "/icon.svg",
            badge: "/icon.svg",
            tag: p.tag || undefined,
            data: { url },
        })
    )
})

self.addEventListener("notificationclick", (event) => {
    event.notification.close()
    const target = new URL(
        (event.notification.data && event.notification.data.url) || "/",
        self.location.origin
    ).href
    event.waitUntil(
        self.clients
            .matchAll({ type: "window", includeUncontrolled: true })
            .then((list) => {
                // Prefer a window already on the target, then any app window.
                const same = list.find((c) => c.url === target)
                if (same) return same.focus()
                const any = list.find(
                    (c) => new URL(c.url).origin === self.location.origin
                )
                if (any) {
                    return any
                        .focus()
                        .then((c) => (c && c.navigate ? c.navigate(target) : c))
                }
                return self.clients.openWindow(target)
            })
    )
})
