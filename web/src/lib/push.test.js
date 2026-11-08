/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    SW_URL,
    currentSubscription,
    disablePush,
    enablePush,
    pushSupport,
    registerServiceWorker,
    urlBase64ToUint8Array,
} from "./push.js"
import { fakePushEnv as fakeEnv } from "../../test/helpers.js"

const fakeApi = () => ({
    pushKey: jest.fn(async () => ({ publicKey: "BAEC" })),
    pushSubscribe: jest.fn(async () => ({ ok: true })),
    pushUnsubscribe: jest.fn(async () => ({ ok: true })),
})

describe("pushSupport", () => {
    it("detects unsupported, insecure and supported browsers", () => {
        expect(pushSupport({})).toBe("unsupported")
        expect(pushSupport({ navigator: {}, window: {} })).toBe("unsupported")
        expect(
            pushSupport({
                navigator: { serviceWorker: {} },
                window: { Notification: {} },
            })
        ).toBe("unsupported")
        expect(pushSupport(fakeEnv({ secure: false }).env)).toBe("insecure")
        expect(pushSupport(fakeEnv().env)).toBe("supported")
        // jsdom: no service worker
        expect(pushSupport()).toBe("unsupported")
    })
})

describe("urlBase64ToUint8Array", () => {
    it("decodes base64url with padding", () => {
        expect([...urlBase64ToUint8Array("AQID")]).toEqual([1, 2, 3])
        expect([...urlBase64ToUint8Array("-_8")]).toEqual([251, 255])
        expect([...urlBase64ToUint8Array("")]).toEqual([])
        expect([...urlBase64ToUint8Array(null)]).toEqual([])
    })
})

describe("registerServiceWorker / currentSubscription", () => {
    it("registers /sw.js and waits until ready", async () => {
        const f = fakeEnv()
        const reg = await registerServiceWorker(f.env)
        expect(f.serviceWorker.register).toHaveBeenCalledWith(SW_URL)
        expect(reg.pushManager).toBe(f.pushManager)
        expect(await registerServiceWorker({ navigator: {} })).toBeNull()
        expect(await registerServiceWorker()).toBeNull()
    })

    it("finds the existing subscription", async () => {
        const existing = { endpoint: "e" }
        expect(await currentSubscription(fakeEnv({ existing }).env)).toBe(
            existing
        )
        expect(await currentSubscription(fakeEnv().env)).toBeNull()
        expect(
            await currentSubscription(fakeEnv({ registration: false }).env)
        ).toBeNull()
        expect(await currentSubscription({})).toBeNull()
    })
})

describe("enablePush", () => {
    it("asks permission, subscribes with the VAPID key and posts it", async () => {
        const f = fakeEnv()
        const api = fakeApi()
        const sub = await enablePush({ api, env: f.env })
        expect(sub).toBe(f.sub)
        expect(f.env.window.Notification.requestPermission).toHaveBeenCalled()
        const opts = f.pushManager.subscribe.mock.calls[0][0]
        expect(opts.userVisibleOnly).toBe(true)
        expect([...opts.applicationServerKey]).toEqual([4, 1, 2])
        expect(api.pushSubscribe).toHaveBeenCalledWith({
            endpoint: "https://push.example/abc",
            keys: { p256dh: "P", auth: "A" },
        })
    })

    it("drops a just-created subscription when the server rejects it", async () => {
        const f = fakeEnv()
        const api = fakeApi()
        api.pushSubscribe.mockRejectedValueOnce(new Error("503 unavailable"))
        await expect(enablePush({ api, env: f.env })).rejects.toThrow(
            "503 unavailable"
        )
        expect(f.sub.unsubscribe).toHaveBeenCalled()
        // the registration error wins even if unsubscribe fails too
        const g = fakeEnv()
        g.sub.unsubscribe.mockRejectedValueOnce(new Error("gone"))
        const api2 = fakeApi()
        api2.pushSubscribe.mockRejectedValueOnce(new Error("503 again"))
        await expect(enablePush({ api: api2, env: g.env })).rejects.toThrow(
            "503 again"
        )
    })

    it("keeps an older subscription it did not create when the server fails", async () => {
        const existing = {
            endpoint: "https://push.example/old",
            keys: { auth: "x" },
            unsubscribe: jest.fn(),
        }
        const f = fakeEnv({ existing })
        const api = fakeApi()
        api.pushSubscribe.mockRejectedValueOnce(new Error("503"))
        await expect(enablePush({ api, env: f.env })).rejects.toThrow("503")
        expect(existing.unsubscribe).not.toHaveBeenCalled()
    })

    it("reuses an existing subscription", async () => {
        const existing = {
            endpoint: "https://push.example/old",
            keys: { auth: "x" },
        }
        const f = fakeEnv({ existing })
        const api = fakeApi()
        await enablePush({ api, env: f.env })
        expect(f.pushManager.subscribe).not.toHaveBeenCalled()
        expect(api.pushSubscribe).toHaveBeenCalledWith({
            endpoint: "https://push.example/old",
            keys: { auth: "x" },
        })
    })

    it("explains why it can't", async () => {
        const api = fakeApi()
        await expect(enablePush({ api, env: {} })).rejects.toThrow(
            "can't receive push"
        )
        await expect(
            enablePush({ api, env: fakeEnv({ secure: false }).env })
        ).rejects.toThrow("https")
        await expect(
            enablePush({ api, env: fakeEnv({ permission: "denied" }).env })
        ).rejects.toThrow("blocked")
        api.pushKey.mockResolvedValueOnce({})
        await expect(enablePush({ api, env: fakeEnv().env })).rejects.toThrow(
            "no push key"
        )
        api.pushKey.mockResolvedValueOnce(null)
        await expect(enablePush({ api, env: fakeEnv().env })).rejects.toThrow(
            "no push key"
        )
    })
})

describe("disablePush", () => {
    it("unsubscribes locally and on the server", async () => {
        const existing = {
            endpoint: "https://push.example/abc",
            unsubscribe: jest.fn(async () => true),
        }
        const api = fakeApi()
        expect(await disablePush({ api, env: fakeEnv({ existing }).env })).toBe(
            true
        )
        expect(existing.unsubscribe).toHaveBeenCalled()
        expect(api.pushUnsubscribe).toHaveBeenCalledWith(
            "https://push.example/abc"
        )
        expect(await disablePush({ api, env: fakeEnv().env })).toBe(false)
    })
})
