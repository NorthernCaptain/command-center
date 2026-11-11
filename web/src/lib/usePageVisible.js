/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Is the page in front of Leo (its tab is the visible one)? Things that
// count as "seen" (a reminder's Now flag) must wait for it: a live update
// that arrives in a background tab was not seen.

import { useEffect, useState } from "react"

const visibleNow = () =>
    typeof document === "undefined" || document.visibilityState !== "hidden"

/** true while the document is visible, re-rendering when that changes. */
export default function usePageVisible() {
    const [visible, setVisible] = useState(visibleNow)
    useEffect(() => {
        const update = () => setVisible(visibleNow())
        document.addEventListener("visibilitychange", update)
        return () => document.removeEventListener("visibilitychange", update)
    }, [])
    return visible
}
