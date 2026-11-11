/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Phones: the on-screen keyboard covers the bottom of the layout viewport,
// where the fixed dock sits. Once the chat box grows past what the browser
// scrolled into view, its last lines (the caret) end up under the keyboard.
// Publish how much of the layout viewport's bottom is hidden (keyboard,
// pinch zoom) as --kb-inset, so the dock sits on the visible bottom edge.

import { useEffect } from "react"

const VAR = "--kb-inset"

/** Pixels of the layout viewport hidden below the visual viewport. */
export function keyboardInset(win = window) {
    const vv = win.visualViewport
    if (!vv) return 0
    const hidden = win.innerHeight - (vv.offsetTop + vv.height)
    return hidden > 1 ? Math.round(hidden) : 0
}

/** Keep --kb-inset on <html> current while `active`. */
export default function useKeyboardInset(active = true) {
    useEffect(() => {
        const vv = window.visualViewport
        if (!active || !vv) return undefined
        const root = document.documentElement
        const set = () => root.style.setProperty(VAR, `${keyboardInset()}px`)
        set()
        vv.addEventListener("resize", set)
        vv.addEventListener("scroll", set)
        return () => {
            vv.removeEventListener("resize", set)
            vv.removeEventListener("scroll", set)
            root.style.removeProperty(VAR)
        }
    }, [active])
}
