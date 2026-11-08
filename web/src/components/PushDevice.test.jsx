/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import PushDevice from "./PushDevice.jsx"
import { ToastProvider } from "./Toasts.jsx"
import { fakePushEnv } from "../../test/helpers.js"

const fakeApi = () => ({
    pushKey: jest.fn(async () => ({ publicKey: "BAEC" })),
    pushSubscribe: jest.fn(async () => ({ ok: true })),
    pushUnsubscribe: jest.fn(async () => ({ ok: true })),
})

const renderIt = (props) =>
    render(
        <ToastProvider>
            <PushDevice {...props} />
        </ToastProvider>
    )

describe("PushDevice", () => {
    it("explains unsupported browsers (jsdom has no service worker)", () => {
        renderIt({ api: fakeApi() })
        expect(screen.getByText(/can't receive push/)).toBeInTheDocument()
        expect(screen.queryByRole("button")).toBeNull()
    })

    it("explains insecure origins", () => {
        renderIt({ api: fakeApi(), env: fakePushEnv({ secure: false }).env })
        expect(screen.getByText(/need https/)).toBeInTheDocument()
    })

    it("enables notifications on this device", async () => {
        const f = fakePushEnv()
        const api = fakeApi()
        renderIt({ api, env: f.env })
        const btn = await screen.findByRole("button", {
            name: "Enable notifications on this device",
        })
        await waitFor(() => expect(btn).not.toBeDisabled())
        expect(
            screen.getByText(/does not receive push notifications yet/)
        ).toBeInTheDocument()
        fireEvent.click(btn)
        expect(
            await screen.findByText("Notifications enabled on this device")
        ).toBeInTheDocument()
        expect(api.pushSubscribe).toHaveBeenCalled()
        expect(
            screen.getByRole("button", { name: "Turn off on this device" })
        ).toBeInTheDocument()
    })

    it("shows errors when enabling fails", async () => {
        const f = fakePushEnv({ permission: "denied" })
        renderIt({ api: fakeApi(), env: f.env })
        const btn = await screen.findByRole("button", {
            name: "Enable notifications on this device",
        })
        await waitFor(() => expect(btn).not.toBeDisabled())
        fireEvent.click(btn)
        expect(await screen.findByText(/blocked for this site/)).toBeVisible()
        await waitFor(() => expect(btn).not.toBeDisabled())
    })

    it("turns notifications off for a subscribed device", async () => {
        const existing = {
            endpoint: "https://push.example/abc",
            unsubscribe: jest.fn(async () => true),
        }
        const api = fakeApi()
        renderIt({ api, env: fakePushEnv({ existing }).env })
        fireEvent.click(
            await screen.findByRole("button", {
                name: "Turn off on this device",
            })
        )
        expect(
            await screen.findByText("Notifications turned off on this device")
        ).toBeInTheDocument()
        expect(api.pushUnsubscribe).toHaveBeenCalledWith(
            "https://push.example/abc"
        )
        expect(
            screen.getByRole("button", {
                name: "Enable notifications on this device",
            })
        ).toBeInTheDocument()
    })

    it("shows errors when turning off fails, and survives a lookup error", async () => {
        const existing = {
            endpoint: "e",
            unsubscribe: jest.fn(async () => {
                throw new Error("nope")
            }),
        }
        renderIt({ api: fakeApi(), env: fakePushEnv({ existing }).env })
        fireEvent.click(
            await screen.findByRole("button", {
                name: "Turn off on this device",
            })
        )
        expect(await screen.findByText("nope")).toBeInTheDocument()
    })

    it("treats a failing subscription lookup as not subscribed", async () => {
        const f = fakePushEnv()
        f.serviceWorker.getRegistration.mockRejectedValue(new Error("x"))
        renderIt({ api: fakeApi(), env: f.env })
        const btn = await screen.findByRole("button", {
            name: "Enable notifications on this device",
        })
        await waitFor(() => expect(btn).not.toBeDisabled())
    })

    it("ignores the lookup after unmount", async () => {
        let resolve
        const f = fakePushEnv()
        f.serviceWorker.getRegistration.mockImplementation(
            () => new Promise((r) => (resolve = r))
        )
        const { unmount } = renderIt({ api: fakeApi(), env: f.env })
        unmount()
        resolve(undefined)
        await Promise.resolve()
    })
})
