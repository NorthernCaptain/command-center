/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { renderHook } from "@testing-library/react"
import { AppContext, FEATURES, featuresOf, useApp } from "./AppContext.jsx"

describe("featuresOf", () => {
    it("is all off without a features object", () => {
        const off = Object.fromEntries(FEATURES.map((k) => [k, false]))
        expect(featuresOf(null)).toEqual(off)
        expect(featuresOf({ role: "owner" })).toEqual(off)
    })

    it("only accepts true flags", () => {
        expect(
            featuresOf({
                features: { workers: true, github: "yes", push: true },
            })
        ).toEqual({
            workers: true,
            github: false,
            push: true,
            soc2: false,
            digest: false,
        })
    })
})

describe("useApp", () => {
    it("defaults features for providers without them", () => {
        const wrapper = ({ children }) => (
            <AppContext.Provider value={{ isOwner: true }}>
                {children}
            </AppContext.Provider>
        )
        const { result } = renderHook(() => useApp(), { wrapper })
        expect(result.current.isOwner).toBe(true)
        expect(result.current.features.workers).toBe(false)
    })

    it("passes a provided features object through", () => {
        const features = { workers: true }
        const wrapper = ({ children }) => (
            <AppContext.Provider value={{ features }}>
                {children}
            </AppContext.Provider>
        )
        const { result } = renderHook(() => useApp(), { wrapper })
        expect(result.current.features).toBe(features)
        const plain = renderHook(() => useApp())
        expect(plain.result.current.features.digest).toBe(false)
        expect(plain.result.current.refreshMe()).toBeUndefined()
    })
})
