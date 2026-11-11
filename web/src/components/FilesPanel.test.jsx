/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import FilesPanel from "./FilesPanel.jsx"

const FILES = [
    { name: "a.png", label: "A", kind: "image", size: 10, at: null },
    {
        name: "gone.pdf",
        label: "Gone",
        kind: "pdf",
        size: null,
        missing: true,
        added_by: "agent:t1-x",
    },
    { name: "b.zip", label: "B", kind: "other", size: 2048 },
]

describe("FilesPanel", () => {
    it("lists files with thumbnails, glyphs and the missing state", () => {
        const onOpen = jest.fn()
        render(
            <FilesPanel
                taskId={1}
                files={FILES}
                onUpload={jest.fn()}
                onOpen={onOpen}
                onDelete={jest.fn()}
            />
        )
        expect(
            document.querySelector("img.file-thumb").getAttribute("src")
        ).toBe("/api/tasks/1/files/a.png")
        expect(
            screen.getByText("missing on disk · agent:t1-x")
        ).toBeInTheDocument()
        expect(screen.getByRole("button", { name: /Gone/ })).toBeDisabled()
        expect(screen.getAllByRole("link", { name: "Download" })).toHaveLength(
            2
        )
        fireEvent.click(screen.getByRole("button", { name: /B/ }))
        expect(onOpen).toHaveBeenCalledWith(FILES[2])
    })

    it("drop zone takes dropped files and ignores other drags", () => {
        const onUpload = jest.fn()
        render(
            <FilesPanel
                taskId={1}
                files={[]}
                onUpload={onUpload}
                onOpen={jest.fn()}
                onDelete={jest.fn()}
                uploading={2}
            />
        )
        expect(screen.getByText("No files yet.")).toBeInTheDocument()
        expect(
            screen.getByRole("button", { name: "Uploading 2…" })
        ).toBeDisabled()
        const zone = document.querySelector(".files-drop")
        fireEvent.dragOver(zone, { dataTransfer: { types: ["text/plain"] } })
        expect(zone).not.toHaveClass("is-over")
        const file = new File(["x"], "a.txt")
        fireEvent.dragOver(zone, { dataTransfer: { types: ["Files"] } })
        expect(zone).toHaveClass("is-over")
        fireEvent.dragLeave(zone)
        expect(zone).not.toHaveClass("is-over")
        fireEvent.drop(zone, { dataTransfer: { types: ["text/plain"] } })
        fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [] } })
        expect(onUpload).not.toHaveBeenCalled()
        fireEvent.drop(zone, {
            dataTransfer: { types: ["Files"], files: [file] },
        })
        expect(onUpload).toHaveBeenCalledWith([file])
        // an empty pick does nothing
        fireEvent.change(screen.getByTestId("file-input"), {
            target: { files: [] },
        })
        expect(onUpload).toHaveBeenCalledTimes(1)
    })

    it("read-only without edit rights", () => {
        render(
            <FilesPanel
                taskId={1}
                files={[FILES[0]]}
                canEdit={false}
                onUpload={jest.fn()}
                onOpen={jest.fn()}
                onDelete={jest.fn()}
            />
        )
        expect(document.querySelector(".files-drop")).toBeNull()
        expect(screen.queryByRole("button", { name: "Delete" })).toBeNull()
    })
})
