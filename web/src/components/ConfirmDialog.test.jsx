/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import ConfirmDialog, { ConfirmButton } from "./ConfirmDialog.jsx"

function renderDialog(props = {}) {
    const onConfirm = jest.fn(async () => {})
    const onCancel = jest.fn()
    render(
        <ConfirmDialog
            title="Close the agent?"
            confirmLabel="Close workspace"
            onConfirm={onConfirm}
            onCancel={onCancel}
            {...props}
        >
            <p>Body text</p>
        </ConfirmDialog>
    )
    return { onConfirm, onCancel }
}

describe("ConfirmDialog", () => {
    it("is a labelled alert dialog with Cancel focused", () => {
        renderDialog()
        const dlg = screen.getByRole("alertdialog", {
            name: "Close the agent?",
        })
        expect(dlg).toHaveTextContent("Body text")
        // [0] is the backdrop (also cancels), [1] the Cancel button
        expect(
            screen.getAllByRole("button", { name: "Cancel" })[1]
        ).toHaveFocus()
    })

    it("confirm runs onConfirm (buttons disabled meanwhile)", async () => {
        let release
        const onConfirm = jest.fn(
            () =>
                new Promise((r) => {
                    release = r
                })
        )
        renderDialog({ onConfirm, danger: true })
        const ok = screen.getByRole("button", { name: "Close workspace" })
        expect(ok).toHaveClass("btn-danger")
        fireEvent.click(ok)
        expect(onConfirm).toHaveBeenCalledTimes(1)
        await waitFor(() => expect(ok).toBeDisabled())
        release()
        await waitFor(() => expect(ok).not.toBeDisabled())
    })

    it("Escape, the backdrop and Cancel cancel", () => {
        const { onCancel, onConfirm } = renderDialog()
        fireEvent.keyDown(document, { key: "Escape" })
        fireEvent.keyDown(document, { key: "Enter" })
        fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0])
        fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1])
        expect(onCancel).toHaveBeenCalledTimes(3)
        expect(onConfirm).not.toHaveBeenCalled()
    })

    it("a failing onConfirm is swallowed and the dialog stays usable", async () => {
        const onConfirm = jest.fn(async () => {
            throw new Error("nope")
        })
        renderDialog({ onConfirm })
        const ok = screen.getByRole("button", { name: "Close workspace" })
        fireEvent.click(ok)
        await waitFor(() => expect(ok).not.toBeDisabled())
        expect(onConfirm).toHaveBeenCalledTimes(1)
    })

    it("defaults: Confirm label, accent button", () => {
        renderDialog({ confirmLabel: undefined })
        expect(screen.getByRole("button", { name: "Confirm" })).toHaveClass(
            "btn-accent"
        )
    })
})

describe("ConfirmDialog focus", () => {
    it("Tab and Shift+Tab stay inside; focus returns to the opener", () => {
        const opener = document.createElement("button")
        opener.textContent = "open"
        document.body.appendChild(opener)
        opener.focus()
        const outside = document.createElement("button")
        outside.textContent = "behind"
        document.body.appendChild(outside)
        try {
            const { unmount } = render(
                <ConfirmDialog
                    title="Sure?"
                    confirmLabel="Yes"
                    onConfirm={async () => {}}
                    onCancel={() => {}}
                >
                    <p>x</p>
                </ConfirmDialog>
            )
            const cancel = screen.getAllByRole("button", { name: "Cancel" })[1]
            const yes = screen.getByRole("button", { name: "Yes" })
            expect(cancel).toHaveFocus()
            // Tab from the last control wraps to the first
            yes.focus()
            fireEvent.keyDown(document, { key: "Tab" })
            expect(cancel).toHaveFocus()
            // Shift+Tab from the first wraps to the last
            fireEvent.keyDown(document, { key: "Tab", shiftKey: true })
            expect(yes).toHaveFocus()
            // focus that escaped (e.g. a click behind) is pulled back in
            outside.focus()
            fireEvent.keyDown(document, { key: "Tab" })
            expect(cancel).toHaveFocus()
            outside.focus()
            fireEvent.keyDown(document, { key: "Tab", shiftKey: true })
            expect(yes).toHaveFocus()
            // Tab between the middle controls is left to the browser
            cancel.focus()
            fireEvent.keyDown(document, { key: "Tab" })
            expect(cancel).toHaveFocus()
            unmount()
            expect(opener).toHaveFocus()
        } finally {
            opener.remove()
            outside.remove()
        }
    })

    it("while busy (no enabled controls) Tab goes nowhere", async () => {
        let release
        render(
            <ConfirmDialog
                title="Sure?"
                onConfirm={() => new Promise((r) => (release = r))}
                onCancel={() => {}}
            >
                <p>x</p>
            </ConfirmDialog>
        )
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Confirm" })
            ).toBeDisabled()
        )
        const ev = new KeyboardEvent("keydown", {
            key: "Tab",
            bubbles: true,
            cancelable: true,
        })
        document.dispatchEvent(ev)
        expect(ev.defaultPrevented).toBe(true)
        release()
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Confirm" })
            ).not.toBeDisabled()
        )
    })
})

describe("ConfirmDialog placement and ConfirmButton", () => {
    it("renders into document.body and focuses without scrolling", () => {
        const spy = jest.spyOn(HTMLElement.prototype, "focus")
        try {
            const host = document.createElement("div")
            document.body.appendChild(host)
            render(
                <ConfirmDialog
                    title="T"
                    onConfirm={async () => {}}
                    onCancel={() => {}}
                >
                    <p>x</p>
                </ConfirmDialog>,
                { container: host }
            )
            const dlg = screen.getByRole("alertdialog")
            expect(host.contains(dlg)).toBe(false)
            expect(dlg.parentElement).toBe(document.body)
            expect(spy).toHaveBeenCalledWith({ preventScroll: true })
            host.remove()
        } finally {
            spy.mockRestore()
        }
    })

    it("ConfirmButton: disabled with a hint; opens, cancels, confirms", async () => {
        const onConfirm = jest.fn(async () => {})
        const { rerender } = render(
            <ConfirmButton
                label="Do it"
                title="Really?"
                disabled
                buttonTitle="not now"
                onConfirm={onConfirm}
            >
                <p>why</p>
            </ConfirmButton>
        )
        const btn = screen.getByRole("button", { name: "Do it" })
        expect(btn).toBeDisabled()
        expect(btn).toHaveAttribute("title", "not now")
        rerender(
            <ConfirmButton label="Do it" title="Really?" onConfirm={onConfirm}>
                <p>why</p>
            </ConfirmButton>
        )
        fireEvent.click(screen.getByRole("button", { name: "Do it" }))
        fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1])
        expect(screen.queryByRole("alertdialog")).toBeNull()
        expect(onConfirm).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole("button", { name: "Do it" }))
        expect(
            screen.getByRole("alertdialog", { name: "Really?" })
        ).toHaveTextContent("why")
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
        await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
        await waitFor(() =>
            expect(screen.queryByRole("alertdialog")).toBeNull()
        )
    })
})
