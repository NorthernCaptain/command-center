/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// The fixed bottom dock grows (job chips, the chat reply above the input).
// The page reserves --dock-h below its content (and toasts / the side panel
// keep clear of it), so publish the dock's real height while it is shown;
// the theme's static value applies again once it is gone.

import { useLayoutEffect } from "react"

const VAR = "--dock-h"

/**
 * Keep --dock-h on <html> equal to the height of the element in `ref`
 * while `active` (the dock is rendered).
 */
export default function useDockHeight(ref, active = true) {
    useLayoutEffect(() => {
        const el = ref.current
        if (!el) return undefined
        const root = document.documentElement
        const set = () =>
            root.style.setProperty(VAR, `${Math.ceil(el.offsetHeight)}px`)
        set()
        let ro = null
        if (typeof ResizeObserver === "function") {
            ro = new ResizeObserver(set)
            ro.observe(el)
        }
        return () => {
            if (ro) ro.disconnect()
            root.style.removeProperty(VAR)
        }
    }, [ref, active])
}
