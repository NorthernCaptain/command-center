/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { applyHighlights } from "../lib/anchoring.js"
import { isAppPath } from "../lib/links.js"
import { navigate } from "../lib/router.js"
import { renderMarkdown } from "../lib/markdown.js"

/** Threads whose anchors should be highlighted. */
export function highlightable(threads) {
    return (threads || []).filter(
        (t) =>
            t.anchor &&
            t.anchor.exact &&
            t.status !== "resolved" &&
            t.status !== "orphaned"
    )
}

/**
 * Rendered artifact with comment highlights. Highlights are DOM ranges added
 * after render; the Markdown never contains markers.
 */
export default function ArtifactView({
    content,
    threads,
    activeId,
    focusKey = 0,
    onOrphans,
    onMarkClick,
    rootRef: externalRef,
}) {
    const localRef = useRef(null)
    const rootRef = externalRef || localRef
    const html = useMemo(() => renderMarkdown(content || ""), [content])
    const items = useMemo(
        () =>
            highlightable(threads).map((t) => ({ id: t.id, anchor: t.anchor })),
        [threads]
    )
    const onOrphansRef = useRef(onOrphans)
    onOrphansRef.current = onOrphans

    useLayoutEffect(() => {
        const root = rootRef.current
        if (!root) return
        const { orphaned } = applyHighlights(root, items)
        if (onOrphansRef.current) onOrphansRef.current(orphaned)
    }, [html, items, rootRef])

    // Highlights are re-created on every live update, so the active class is
    // re-applied each time; scrolling happens once per focus action (activeId
    // + focusKey, bumped on every explicit click, as soon as the mark exists)
    // so live updates don't yank the reader back but clicks always scroll.
    const scrolledFor = useRef(null)
    useEffect(() => {
        const root = rootRef.current
        if (!root) return
        let first = null
        for (const m of root.querySelectorAll("mark[data-comment-id]")) {
            const on =
                activeId != null &&
                m.getAttribute("data-comment-id") === String(activeId)
            m.classList.toggle("is-active", on)
            if (on && !first) first = m
        }
        if (activeId == null) {
            scrolledFor.current = null
            return
        }
        const focus = `${activeId}#${focusKey}`
        if (!first || scrolledFor.current === focus) return
        scrolledFor.current = focus
        if (first.scrollIntoView)
            first.scrollIntoView({ block: "center", behavior: "smooth" })
    }, [activeId, focusKey, html, items, rootRef])

    function onClick(e) {
        // an app page link ("/t/2") routes in place on a plain click
        const a = e.target.closest && e.target.closest("a[href]")
        if (a && isAppPath(a.getAttribute("href"))) {
            const plain =
                e.button === 0 &&
                !e.metaKey &&
                !e.ctrlKey &&
                !e.shiftKey &&
                !e.altKey
            if (plain) {
                e.preventDefault()
                navigate(a.getAttribute("href"))
            }
            return
        }
        const mark =
            e.target.closest && e.target.closest("mark[data-comment-id]")
        if (mark && onMarkClick) {
            const sel = document.getSelection && document.getSelection()
            if (sel && !sel.isCollapsed) return
            onMarkClick(mark.getAttribute("data-comment-id"))
        }
    }

    return (
        <article
            ref={rootRef}
            className="artifact prose"
            onClick={onClick}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    )
}
