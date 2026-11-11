/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import FileViewer from "./FileViewer.jsx"

const ok = (text) => jest.fn(async () => ({ ok: true, text: async () => text }))

describe("FileViewer", () => {
    it.each([
        ["clip.mp4", "video.fv-video"],
        ["voice.m4a", "audio.fv-audio"],
        ["spec.pdf", "iframe.fv-pdf"],
    ])("shows %s with its player", (name, selector) => {
        render(<FileViewer taskId={3} file={{ name }} onClose={jest.fn()} />)
        const el = document.querySelector(selector)
        expect(el.getAttribute("src")).toBe(`/api/tasks/3/files/${name}`)
    })

    it("text files show as text, links open and download", async () => {
        const fetchImpl = ok("line 1\nline 2")
        render(
            <FileViewer
                taskId={3}
                file={{ name: "run.log", label: "Run log" }}
                onClose={jest.fn()}
                fetchImpl={fetchImpl}
            />
        )
        expect(screen.getByText("Loading…")).toBeInTheDocument()
        expect(
            await screen.findByText(/line 1/, { selector: "pre" })
        ).toBeInTheDocument()
        expect(fetchImpl).toHaveBeenCalledWith("/api/tasks/3/files/run.log", {
            credentials: "same-origin",
        })
        expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
            "href",
            "/api/tasks/3/files/run.log?download=1"
        )
        expect(screen.getByRole("link", { name: "Open ↗" })).toHaveAttribute(
            "href",
            "/api/tasks/3/files/run.log"
        )
    })

    it("markdown renders, with its own attachments resolved", async () => {
        render(
            <FileViewer
                taskId={3}
                file={{ name: "notes.md" }}
                onClose={jest.fn()}
                fetchImpl={ok("# Notes\n\n![s](files/s.png)")}
            />
        )
        expect(
            await screen.findByRole("heading", { name: "Notes" })
        ).toBeInTheDocument()
        expect(
            document.querySelector(".fv-markdown img").getAttribute("src")
        ).toBe("/api/tasks/3/files/s.png")
    })

    it("a failed load says so", async () => {
        render(
            <FileViewer
                taskId={3}
                file={{ name: "notes.md" }}
                onClose={jest.fn()}
                fetchImpl={jest.fn(async () => ({ ok: false, status: 404 }))}
            />
        )
        expect(
            await screen.findByText("Can't load it: HTTP 404")
        ).toBeInTheDocument()
    })

    it("a fetch that rejects says so too", async () => {
        render(
            <FileViewer
                taskId={3}
                file={{ name: "a.txt" }}
                onClose={jest.fn()}
                fetchImpl={jest.fn(async () => {
                    throw new Error("offline")
                })}
            />
        )
        expect(
            await screen.findByText("Can't load it: offline")
        ).toBeInTheDocument()
    })

    it("other types offer a download; backdrop and Escape close", () => {
        const onClose = jest.fn()
        render(
            <FileViewer taskId={3} file={{ name: "a.zip" }} onClose={onClose} />
        )
        expect(
            screen.getByText(/No preview for this file type/)
        ).toBeInTheDocument()
        fireEvent.click(document.querySelector(".fv-backdrop"))
        fireEvent.keyDown(document, { key: "Escape" })
        fireEvent.keyDown(document, { key: "a" })
        expect(onClose).toHaveBeenCalledTimes(2)
    })
})
