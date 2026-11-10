/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { render } from "@testing-library/react"
import { useRef } from "react"
import useDockHeight from "./useDockHeight.js"

function Dock({ active = true, show = true }) {
    const ref = useRef(null)
    useDockHeight(ref, active)
    return show ? <div ref={ref} data-testid="dock" /> : null
}

const dockH = () => document.documentElement.style.getPropertyValue("--dock-h")

describe("useDockHeight", () => {
    const realRO = global.ResizeObserver
    const realHeight = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "offsetHeight"
    )
    let height
    let observers

    beforeEach(() => {
        height = 90
        observers = []
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
            configurable: true,
            get: () => height,
        })
        global.ResizeObserver = class {
            constructor(cb) {
                this.cb = cb
                this.disconnect = jest.fn()
                observers.push(this)
            }
            observe(el) {
                this.el = el
            }
        }
    })

    afterEach(() => {
        global.ResizeObserver = realRO
        if (realHeight)
            Object.defineProperty(
                HTMLElement.prototype,
                "offsetHeight",
                realHeight
            )
        else delete HTMLElement.prototype.offsetHeight
        document.documentElement.style.removeProperty("--dock-h")
    })

    it("publishes the dock's height, follows resizes, clears on unmount", () => {
        const { unmount } = render(<Dock />)
        expect(dockH()).toBe("90px")
        height = 300.4
        observers[0].cb()
        expect(dockH()).toBe("301px")
        unmount()
        expect(observers[0].disconnect).toHaveBeenCalled()
        expect(dockH()).toBe("")
    })

    it("does nothing without the element; works without ResizeObserver", () => {
        render(<Dock show={false} />)
        expect(dockH()).toBe("")
        global.ResizeObserver = undefined
        const { unmount } = render(<Dock />)
        expect(dockH()).toBe("90px")
        unmount()
        expect(dockH()).toBe("")
    })
})
