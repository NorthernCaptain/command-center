/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Web Push on this device: service worker registration, PushManager
// subscription with the server's VAPID key, and the subscribe/unsubscribe
// calls. `env` ({ navigator, window }) is injectable for tests.

export const SW_URL = "/sw.js"

function defaultEnv() {
    return {
        navigator: typeof navigator === "undefined" ? undefined : navigator,
        window: typeof window === "undefined" ? undefined : window,
    }
}

/**
 * "supported" | "unsupported" (no service worker / PushManager /
 * Notification, e.g. iOS Safari outside a Home Screen app) | "insecure"
 * (push needs https or localhost).
 */
export function pushSupport(env = defaultEnv()) {
    const nav = env.navigator
    const win = env.window
    if (!nav || !win) return "unsupported"
    if (!("serviceWorker" in nav)) return "unsupported"
    if (!("PushManager" in win) || !("Notification" in win))
        return "unsupported"
    if (win.isSecureContext === false) return "insecure"
    return "supported"
}

/** VAPID public key (base64url) -> Uint8Array for applicationServerKey. */
export function urlBase64ToUint8Array(base64) {
    const s = String(base64 || "")
    const padding = "=".repeat((4 - (s.length % 4)) % 4)
    const b64 = (s + padding).replace(/-/g, "+").replace(/_/g, "/")
    const raw = atob(b64)
    const out = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
    return out
}

/** Register the service worker (idempotent). Resolves to the registration. */
export async function registerServiceWorker(env = defaultEnv()) {
    const sw = env.navigator && env.navigator.serviceWorker
    if (!sw) return null
    await sw.register(SW_URL)
    return sw.ready
}

/** Existing push subscription of this device (or null). */
export async function currentSubscription(env = defaultEnv()) {
    if (pushSupport(env) !== "supported") return null
    const reg = await env.navigator.serviceWorker.getRegistration(SW_URL)
    if (!reg || !reg.pushManager) return null
    return (await reg.pushManager.getSubscription()) || null
}

/**
 * Ask for permission, register the service worker, subscribe with the
 * server's VAPID key and send the subscription to the server.
 * Resolves to the PushSubscription; throws an Error with a readable
 * message when the browser can't or the user declines.
 */
export async function enablePush({ api, env = defaultEnv() }) {
    const support = pushSupport(env)
    if (support === "insecure")
        throw new Error("Notifications need https (or localhost).")
    if (support !== "supported")
        throw new Error("This browser can't receive push notifications.")
    const permission = await env.window.Notification.requestPermission()
    if (permission !== "granted")
        throw new Error("Notifications are blocked for this site.")
    const reg = await registerServiceWorker(env)
    const { publicKey } = (await api.pushKey()) || {}
    if (!publicKey) throw new Error("The server has no push key.")
    let sub = await reg.pushManager.getSubscription()
    let created = false
    if (!sub) {
        sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
        })
        created = true
    }
    const json = typeof sub.toJSON === "function" ? sub.toJSON() : sub
    try {
        await api.pushSubscribe({ endpoint: json.endpoint, keys: json.keys })
    } catch (err) {
        // The server does not know this subscription: drop the one we just
        // made, or the page would show notifications as on (nothing arrives).
        if (created && typeof sub.unsubscribe === "function") {
            try {
                await sub.unsubscribe()
            } catch {
                // keep the registration error
            }
        }
        throw err
    }
    return sub
}

/** Unsubscribe this device locally and on the server. */
export async function disablePush({ api, env = defaultEnv() }) {
    const sub = await currentSubscription(env)
    if (!sub) return false
    const endpoint = sub.endpoint
    await sub.unsubscribe()
    await api.pushUnsubscribe(endpoint)
    return true
}
