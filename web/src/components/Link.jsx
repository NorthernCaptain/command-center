/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { navigate } from "../lib/router.js"

/** In-app link: plain <a href> that routes client-side on a normal click. */
export default function Link({ to, children, onClick, ...rest }) {
    function handle(e) {
        if (onClick) onClick(e)
        if (
            e.defaultPrevented ||
            e.button !== 0 ||
            e.metaKey ||
            e.ctrlKey ||
            e.shiftKey ||
            e.altKey
        ) {
            return
        }
        e.preventDefault()
        navigate(to)
    }
    return (
        <a href={to} onClick={handle} {...rest}>
            {children}
        </a>
    )
}
