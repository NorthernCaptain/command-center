/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { act, render, screen } from "@testing-library/react"
import usePageVisible from "./usePageVisible.js"

function Probe() {
    return <p>{usePageVisible() ? "visible" : "hidden"}</p>
}

function setVisibility(state) {
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
    })
    document.dispatchEvent(new Event("visibilitychange"))
}

describe("usePageVisible", () => {
    afterEach(() => {
        delete document.visibilityState
    })

    it("follows the tab's visibility", () => {
        const { unmount } = render(<Probe />)
        expect(screen.getByText("visible")).toBeInTheDocument()
        act(() => setVisibility("hidden"))
        expect(screen.getByText("hidden")).toBeInTheDocument()
        act(() => setVisibility("visible"))
        expect(screen.getByText("visible")).toBeInTheDocument()
        unmount()
        // no listener left behind
        expect(() => setVisibility("hidden")).not.toThrow()
    })
})
