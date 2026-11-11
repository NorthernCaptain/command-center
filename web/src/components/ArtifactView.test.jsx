/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { fireEvent, render } from "@testing-library/react"
import ArtifactView, { highlightable } from "./ArtifactView.jsx"
import { currentPath } from "../lib/router.js"

const CONTENT = "## Summary\nThe upload lambda has a cold start of 12s.\n"
const thread = (id, exact) => ({
    id,
    status: "open",
    anchor: { section: "Summary", exact, prefix: "", suffix: "" },
})

let scroll
beforeEach(() => {
    scroll = jest.fn()
    Element.prototype.scrollIntoView = scroll
})

describe("ArtifactView", () => {
    it("scrolls once per active comment, not on every live update", () => {
        const threads = [thread("c1", "cold start")]
        const { container, rerender } = render(
            <ArtifactView content={CONTENT} threads={threads} activeId="c1" />
        )
        const mark = container.querySelector('mark[data-comment-id="c1"]')
        expect(mark).toHaveClass("is-active")
        expect(scroll).toHaveBeenCalledTimes(1)

        // live updates: new content and new thread objects
        rerender(
            <ArtifactView
                content={CONTENT + "\nMore text from the agent.\n"}
                threads={[...threads, thread("c2", "upload")]}
                activeId="c1"
            />
        )
        expect(
            container.querySelector('mark[data-comment-id="c1"]')
        ).toHaveClass("is-active")
        expect(scroll).toHaveBeenCalledTimes(1)

        // a different active comment scrolls again
        rerender(
            <ArtifactView
                content={CONTENT}
                threads={[...threads, thread("c2", "upload")]}
                activeId="c2"
            />
        )
        expect(scroll).toHaveBeenCalledTimes(2)
        expect(
            container.querySelector('mark[data-comment-id="c1"]')
        ).not.toHaveClass("is-active")

        // clearing and re-selecting the same one scrolls again
        rerender(<ArtifactView content={CONTENT} threads={threads} />)
        rerender(
            <ArtifactView content={CONTENT} threads={threads} activeId="c1" />
        )
        expect(scroll).toHaveBeenCalledTimes(3)
    })

    it("an explicit focus of the active comment (new focusKey) scrolls again", () => {
        const threads = [thread("c1", "cold start")]
        const view = (focusKey, content = CONTENT) => (
            <ArtifactView
                content={content}
                threads={threads}
                activeId="c1"
                focusKey={focusKey}
            />
        )
        const { rerender } = render(view(1))
        expect(scroll).toHaveBeenCalledTimes(1)
        rerender(view(2))
        expect(scroll).toHaveBeenCalledTimes(2)
        // live update with the same focusKey: no scroll
        rerender(view(2, CONTENT + "\nMore.\n"))
        expect(scroll).toHaveBeenCalledTimes(2)
    })

    it("scrolls once the active comment's mark appears", () => {
        const { rerender } = render(
            <ArtifactView content={CONTENT} threads={[]} activeId="c9" />
        )
        expect(scroll).not.toHaveBeenCalled()
        rerender(
            <ArtifactView
                content={CONTENT}
                threads={[thread("c9", "lambda")]}
                activeId="c9"
            />
        )
        expect(scroll).toHaveBeenCalledTimes(1)
    })

    it("filters highlightable threads", () => {
        expect(highlightable(null)).toEqual([])
        expect(
            highlightable([
                thread("a", "x"),
                { ...thread("b", "x"), status: "resolved" },
                { ...thread("c", "x"), status: "orphaned" },
                { id: "d", anchor: null },
            ]).map((t) => t.id)
        ).toEqual(["a"])
    })

    it("a task link routes in place; modified clicks and web links are left alone", () => {
        window.scrollTo = jest.fn() // the router scrolls to top on navigate
        window.history.replaceState(null, "", "/t/5")
        const { container } = render(
            <ArtifactView
                content={
                    "## Links\n\n- [spun off from T-2](</t/2>)\n- [web](<https://example.com/a>)\n"
                }
                threads={[]}
            />
        )
        const app = container.querySelector('a[href="/t/2"]')
        expect(app.hasAttribute("target")).toBe(false)
        expect(fireEvent.click(app, { metaKey: true })).toBe(true)
        expect(currentPath()).toBe("/t/5")
        expect(fireEvent.click(app)).toBe(false) // default prevented
        expect(currentPath()).toBe("/t/2")
        const web = container.querySelector('a[href="https://example.com/a"]')
        expect(fireEvent.click(web)).toBe(true)
        expect(currentPath()).toBe("/t/2")
    })
})

describe("ArtifactView attachments", () => {
    it("opens attachments in the viewer; videos and modified clicks stay", () => {
        const onOpenFile = jest.fn()
        const { container } = render(
            <ArtifactView
                content={
                    "## Attachments\n- ![Shot](files/a.png)\n- ![Clip](files/c.mp4)\n- [Spec](files/s.md)\n"
                }
                threads={[]}
                filesBase="/api/tasks/2/files/"
                onOpenFile={onOpenFile}
            />
        )
        fireEvent.click(container.querySelector('img[data-file="a.png"]'))
        fireEvent.click(container.querySelector('video[data-file="c.mp4"]'))
        const spec = container.querySelector('a[data-file="s.md"]')
        fireEvent.click(spec, { ctrlKey: true })
        fireEvent.click(spec)
        expect(onOpenFile.mock.calls).toEqual([["a.png"], ["s.md"]])
    })
})
