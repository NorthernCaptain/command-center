/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { act, fireEvent, render, screen } from "@testing-library/react"
import App from "./App.jsx"
import { ToastProvider, useToast } from "./components/Toasts.jsx"
import { createEventStream, setEventStream } from "./lib/events.js"
import { navigate } from "./lib/router.js"
import {
    FakeEventSource,
    mockFetch,
    reply,
    sampleTask,
} from "../test/helpers.js"

const BOARD = { lanes: { now: [sampleTask({ id: 1, title: "Board task" })] } }

beforeEach(() => {
    FakeEventSource.reset()
    setEventStream(createEventStream({ EventSource: FakeEventSource }))
    window.scrollTo = jest.fn()
    window.history.replaceState(null, "", "/")
})

function renderApp() {
    return render(
        <ToastProvider>
            <App />
        </ToastProvider>
    )
}

describe("App", () => {
    it("loads /api/me, starts SSE and routes between pages", async () => {
        mockFetch({
            "GET /api/me": { role: "owner", login: null, mode: "local" },
            "GET /api/board": BOARD,
            "GET /api/tasks/1": {
                task: sampleTask({ id: 1, title: "Board task" }),
                revision: "r",
                artifact: { content: "## Summary\nhello", revision: "a" },
            },
            "GET /api/settings": { settings: {} },
            "GET /api/devices": { devices: [] },
        })
        renderApp()
        expect(screen.getByLabelText("Loading")).toBeInTheDocument()
        expect(await screen.findByText("Board task")).toBeInTheDocument()
        expect(FakeEventSource.instances).toHaveLength(1)
        act(() => FakeEventSource.last().onopen())
        expect(screen.getByTitle("Updates: live")).toBeInTheDocument()

        fireEvent.click(screen.getByText("Board task"))
        expect(
            await screen.findByRole("heading", { name: "Board task" })
        ).toBeInTheDocument()
        expect(window.location.pathname).toBe("/t/1")

        fireEvent.click(screen.getByLabelText("Settings"))
        expect(
            await screen.findByRole("heading", { name: "Settings" })
        ).toBeInTheDocument()

        act(() => navigate("/nowhere"))
        expect(screen.getByText("Nothing here")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("link", { name: "Back to board" }))
        expect(await screen.findByText("Board task")).toBeInTheDocument()
    })

    it("a page render error shows a recoverable message, not a blank app", async () => {
        const spy = jest.spyOn(console, "error").mockImplementation(() => {})
        try {
            mockFetch({
                "GET /api/me": { role: "owner", mode: "local" },
                "GET /api/board": BOARD,
                // malformed task: the page throws while rendering
                "GET /api/tasks/1": { task: null, artifact: null },
            })
            window.history.replaceState(null, "", "/t/1")
            renderApp()
            expect(
                await screen.findByText("Something went wrong")
            ).toBeInTheDocument()
            // the shell (top bar) is still there
            expect(screen.getByLabelText("Settings")).toBeInTheDocument()
            fireEvent.click(screen.getByRole("link", { name: "Back to board" }))
            expect(await screen.findByText("Board task")).toBeInTheDocument()
        } finally {
            spy.mockRestore()
        }
    })

    it("modified clicks are left to the browser", async () => {
        mockFetch({
            "GET /api/me": { role: "owner", mode: "local" },
            "GET /api/board": BOARD,
        })
        renderApp()
        const link = await screen.findByText("Board task")
        const stop = (e) => e.preventDefault() // jsdom can't navigate
        window.addEventListener("click", stop)
        fireEvent.click(link, { metaKey: true })
        window.removeEventListener("click", stop)
        expect(window.location.pathname).toBe("/")
    })

    it("shows the read-only badge and hides settings for local viewers", async () => {
        mockFetch({
            "GET /api/me": {
                role: "viewer",
                login: "bob@x.com",
                mode: "local",
            },
            "GET /api/board": BOARD,
        })
        renderApp()
        expect(await screen.findByText("read-only")).toBeInTheDocument()
        expect(screen.queryByLabelText("Settings")).not.toBeInTheDocument()
    })

    it("tailnet viewers get the settings link for pairing", async () => {
        mockFetch({
            "GET /api/me": {
                role: "viewer",
                login: "leo@x.com",
                mode: "tailnet",
            },
            "GET /api/board": BOARD,
        })
        renderApp()
        expect(await screen.findByLabelText("Settings")).toBeInTheDocument()
    })

    it("shows the locked screen on 401 and retries", async () => {
        let n = 0
        mockFetch({
            "GET /api/me": () =>
                n++ === 0
                    ? reply(401, { error: "unauthorized" })
                    : { role: "owner", mode: "local" },
            "GET /api/board": BOARD,
        })
        renderApp()
        expect(await screen.findByText("Not signed in")).toBeInTheDocument()
        expect(screen.getByText("cc open")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Try again" }))
        expect(await screen.findByText("Board task")).toBeInTheDocument()
    })

    it("shows unreachable errors", async () => {
        global.fetch = jest.fn(async () => {
            throw new TypeError("Failed to fetch")
        })
        renderApp()
        expect(
            await screen.findByText("Command Center is unreachable")
        ).toBeInTheDocument()
        expect(
            screen.getByText("Can't reach the command center")
        ).toBeInTheDocument()
    })

    it("re-checks the session on stream errors and stops on 401/403", async () => {
        let me = { role: "owner", login: null, mode: "local" }
        mockFetch({
            "GET /api/me": () => me,
            "GET /api/board": BOARD,
        })
        renderApp()
        expect(await screen.findByText("Board task")).toBeInTheDocument()
        const first = FakeEventSource.last()
        act(() => first.onopen())
        // outage-style error with the same session: nothing changes
        await act(async () => first.onerror())
        expect(screen.getByText("Board task")).toBeInTheDocument()
        // role change (device revoked on the tailnet) is picked up
        me = { role: "viewer", login: "leo@x.com", mode: "local" }
        await act(async () => FakeEventSource.last().onerror())
        expect(await screen.findByText("read-only")).toBeInTheDocument()
        // signed out: the locked screen, and the stream is closed
        me = reply(403, { error: "forbidden" })
        const count = FakeEventSource.instances.length
        await act(async () => FakeEventSource.last().onerror())
        expect(await screen.findByText("Not signed in")).toBeInTheDocument()
        expect(FakeEventSource.last().closed).toBe(true)
        expect(FakeEventSource.instances).toHaveLength(count)
    })

    it("ignores network failures while re-checking the session", async () => {
        let fail = false
        mockFetch({
            "GET /api/me": () => {
                if (fail) throw new TypeError("Failed to fetch")
                return { role: "owner", login: null, mode: "local" }
            },
            "GET /api/board": BOARD,
        })
        renderApp()
        expect(await screen.findByText("Board task")).toBeInTheDocument()
        fail = true
        await act(async () => FakeEventSource.last().onerror())
        expect(screen.getByText("Board task")).toBeInTheDocument()
    })

    it.each([421, 503])(
        "explains a %i from /api/me as missing tailnet configuration",
        async (status) => {
            mockFetch({
                "GET /api/me": reply(status, {
                    error: "host_mismatch",
                    message: "Host does not match",
                }),
            })
            renderApp()
            expect(
                await screen.findByRole("heading", {
                    name: "Command center is not configured for tailnet access",
                })
            ).toBeInTheDocument()
            expect(
                screen.getByText(/configured as its public tailnet address/)
            ).toBeInTheDocument()
            expect(
                screen.getByRole("button", { name: "Try again" })
            ).toBeInTheDocument()
        }
    )
})

describe("Toasts", () => {
    function Pusher() {
        const t = useToast()
        return (
            <>
                <button onClick={() => t.info("info msg")}>info</button>
                <button onClick={() => t.error("plain error")}>err</button>
                <button
                    onClick={() =>
                        t.error(new Error("obj error"), { timeout: 0 })
                    }
                >
                    err2
                </button>
            </>
        )
    }

    it("shows, auto-dismisses and closes toasts", () => {
        jest.useFakeTimers()
        render(
            <ToastProvider timeout={1000}>
                <Pusher />
            </ToastProvider>
        )
        fireEvent.click(screen.getByText("info"))
        fireEvent.click(screen.getByText("err"))
        fireEvent.click(screen.getByText("err2"))
        expect(screen.getByText("info msg")).toBeInTheDocument()
        act(() => jest.advanceTimersByTime(1100))
        expect(screen.queryByText("info msg")).not.toBeInTheDocument()
        expect(screen.getByText("plain error")).toBeInTheDocument()
        act(() => jest.advanceTimersByTime(1000))
        expect(screen.queryByText("plain error")).not.toBeInTheDocument()
        expect(screen.getByText("obj error")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
        expect(screen.queryByText("obj error")).not.toBeInTheDocument()
        jest.useRealTimers()
    })

    it("useToast outside a provider is a no-op", () => {
        function Lonely() {
            const t = useToast()
            t.info("x")
            t.error("y")
            t.success("z")
            t.push("info", "w")
            t.dismiss(1)
            return <span>ok</span>
        }
        render(<Lonely />)
        expect(screen.getByText("ok")).toBeInTheDocument()
    })
})
