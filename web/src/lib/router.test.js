/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { act, renderHook } from "@testing-library/react"
import { currentPath, matchRoute, navigate, usePath } from "./router.js"

describe("router", () => {
    it("matches routes", () => {
        expect(matchRoute("/")).toEqual({ name: "home", params: {} })
        expect(matchRoute("")).toEqual({ name: "home", params: {} })
        expect(matchRoute("/settings/")).toEqual({
            name: "settings",
            params: {},
        })
        expect(matchRoute("/t/12")).toEqual({
            name: "task",
            params: { id: 12 },
        })
        expect(matchRoute("/t/T-12")).toEqual({
            name: "task",
            params: { id: 12 },
        })
        expect(matchRoute("/t/abc")).toEqual({ name: "not_found", params: {} })
    })

    it("navigates and notifies subscribers", () => {
        window.scrollTo = jest.fn()
        const { result } = renderHook(() => usePath())
        act(() => navigate("/t/3"))
        expect(result.current).toBe("/t/3")
        expect(currentPath()).toBe("/t/3")
        act(() => navigate("/t/3")) // same path: no-op
        act(() => navigate("/settings", { replace: true }))
        expect(result.current).toBe("/settings")
        act(() => {
            window.history.pushState(null, "", "/")
            window.dispatchEvent(new PopStateEvent("popstate"))
        })
        expect(result.current).toBe("/")
    })
})
