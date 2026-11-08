/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import Soc2Export, { defaultRange } from "./Soc2Export.jsx"

describe("defaultRange", () => {
    it("covers the last 90 days", () => {
        expect(defaultRange(new Date(2026, 10, 7))).toEqual({
            from: "2026-08-09",
            to: "2026-11-07",
        })
    })
})

describe("Soc2Export", () => {
    it("opens the export for the chosen range and format", () => {
        const open = jest.fn()
        render(<Soc2Export open={open} />)
        fireEvent.change(screen.getByLabelText("From"), {
            target: { value: "2026-10-01" },
        })
        fireEvent.change(screen.getByLabelText("To"), {
            target: { value: "2026-10-31" },
        })
        fireEvent.click(screen.getByRole("button", { name: "Export evidence" }))
        expect(open).toHaveBeenLastCalledWith(
            "/api/soc2/export?from=2026-10-01&to=2026-10-31&format=md"
        )
        fireEvent.change(screen.getByLabelText("Format"), {
            target: { value: "json" },
        })
        fireEvent.click(screen.getByRole("button", { name: "Export evidence" }))
        expect(open).toHaveBeenLastCalledWith(
            "/api/soc2/export?from=2026-10-01&to=2026-10-31&format=json"
        )
    })

    it("rejects an inverted range", () => {
        const open = jest.fn()
        render(<Soc2Export open={open} />)
        fireEvent.change(screen.getByLabelText("From"), {
            target: { value: "2026-12-01" },
        })
        fireEvent.change(screen.getByLabelText("To"), {
            target: { value: "2026-11-01" },
        })
        expect(screen.getByRole("alert")).toHaveTextContent("start date")
        const btn = screen.getByRole("button", { name: "Export evidence" })
        expect(btn).toBeDisabled()
        fireEvent.submit(btn.closest("form"))
        expect(open).not.toHaveBeenCalled()
    })

    it("uses window.open by default", () => {
        const spy = jest.spyOn(window, "open").mockImplementation(() => null)
        render(<Soc2Export />)
        fireEvent.click(screen.getByRole("button", { name: "Export evidence" }))
        expect(spy).toHaveBeenCalledWith(
            expect.stringMatching(/^\/api\/soc2\/export\?from=.*&format=md$/),
            "_blank",
            "noopener"
        )
        spy.mockRestore()
    })
})
