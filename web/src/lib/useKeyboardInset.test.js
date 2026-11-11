/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { act, render } from "@testing-library/react"
import useKeyboardInset, { keyboardInset } from "./useKeyboardInset.js"

function Probe({ active = true }) {
    useKeyboardInset(active)
    return null
}

const inset = () =>
    document.documentElement.style.getPropertyValue("--kb-inset")

/** A fake visualViewport: an EventTarget with height / offsetTop. */
function fakeViewport(height, offsetTop = 0) {
    const vv = new EventTarget()
    vv.height = height
    vv.offsetTop = offsetTop
    return vv
}

describe("keyboardInset", () => {
    it("is the layout viewport's bottom hidden below the visual one", () => {
        expect(
            keyboardInset({
                innerHeight: 800,
                visualViewport: fakeViewport(500, 0),
            })
        ).toBe(300)
        // the page scrolled the visual viewport down by 100
        expect(
            keyboardInset({
                innerHeight: 800,
                visualViewport: fakeViewport(500.4, 100),
            })
        ).toBe(200)
        // nothing hidden, rounding noise, no API
        expect(
            keyboardInset({
                innerHeight: 800,
                visualViewport: fakeViewport(799.5),
            })
        ).toBe(0)
        expect(keyboardInset({ innerHeight: 800 })).toBe(0)
    })
})

describe("useKeyboardInset", () => {
    const real = Object.getOwnPropertyDescriptor(window, "visualViewport")
    let vv

    beforeEach(() => {
        vv = fakeViewport(window.innerHeight)
        Object.defineProperty(window, "visualViewport", {
            configurable: true,
            value: vv,
        })
    })
    afterEach(() => {
        if (real) Object.defineProperty(window, "visualViewport", real)
        else delete window.visualViewport
    })

    it("follows the keyboard and clears on unmount", () => {
        const { unmount } = render(<Probe />)
        expect(inset()).toBe("0px")
        vv.height = window.innerHeight - 320
        act(() => vv.dispatchEvent(new Event("resize")))
        expect(inset()).toBe("320px")
        vv.offsetTop = 20
        act(() => vv.dispatchEvent(new Event("scroll")))
        expect(inset()).toBe("300px")
        unmount()
        expect(inset()).toBe("")
        // no more updates once unmounted
        act(() => vv.dispatchEvent(new Event("resize")))
        expect(inset()).toBe("")
    })

    it("does nothing while inactive or without the API", () => {
        render(<Probe active={false} />)
        expect(inset()).toBe("")
        delete window.visualViewport
        render(<Probe />)
        expect(inset()).toBe("")
    })
})
