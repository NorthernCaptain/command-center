/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import ErrorBoundary from "./ErrorBoundary.jsx"

let boom = true
function Bomb() {
    if (boom) throw new Error("kaboom")
    return <p>fine</p>
}

let spy
beforeEach(() => {
    boom = true
    // React and the boundary log caught errors; keep the output clean.
    spy = jest.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => spy.mockRestore())

describe("ErrorBoundary", () => {
    it("shows a recoverable message instead of unmounting", () => {
        render(
            <ErrorBoundary resetKey="/a">
                <Bomb />
            </ErrorBoundary>
        )
        expect(screen.getByRole("alert")).toBeInTheDocument()
        expect(screen.getByText("Something went wrong")).toBeInTheDocument()
        expect(screen.getByText("kaboom")).toBeInTheDocument()
        expect(
            screen.getByRole("link", { name: "Back to board" })
        ).toHaveAttribute("href", "/")
        boom = false
        fireEvent.click(screen.getByRole("button", { name: "Try again" }))
        expect(screen.getByText("fine")).toBeInTheDocument()
    })

    it("resets when the reset key changes", () => {
        const { rerender } = render(
            <ErrorBoundary resetKey="/a">
                <Bomb />
            </ErrorBoundary>
        )
        expect(screen.getByText("Something went wrong")).toBeInTheDocument()
        boom = false
        rerender(
            <ErrorBoundary resetKey="/a">
                <Bomb />
            </ErrorBoundary>
        )
        expect(screen.getByText("Something went wrong")).toBeInTheDocument()
        rerender(
            <ErrorBoundary resetKey="/b">
                <Bomb />
            </ErrorBoundary>
        )
        expect(screen.getByText("fine")).toBeInTheDocument()
    })

    it("shows non-Error throws", () => {
        function Thrower() {
            throw "plain" // eslint-disable-line no-throw-literal
        }
        render(
            <ErrorBoundary>
                <Thrower />
            </ErrorBoundary>
        )
        expect(screen.getByText("plain")).toBeInTheDocument()
    })
})
