/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { fireEvent, screen, waitFor } from "@testing-library/react"
import ReviewRepos, { nextFlags } from "./ReviewRepos.jsx"
import { mockFetch, reply } from "../../test/helpers.js"
import { renderWithApp } from "../../test/render.jsx"

const REPOS = [
    {
        name: "mobile",
        description: "the app",
        track: true,
        auto_review: false,
        last_scan_at: new Date(Date.now() - 5 * 60000).toISOString(),
        open: 3,
        error: null,
    },
    {
        name: "aws-lambda",
        description: "",
        track: false,
        auto_review: false,
        last_scan_at: null,
        open: null,
        error: null,
    },
    {
        name: "web-trace",
        description: "web",
        track: true,
        auto_review: true,
        last_scan_at: null,
        open: null,
        error: "gh: not found",
    },
]

describe("nextFlags", () => {
    const r = { track: true, auto_review: false }
    it("auto-review on implies track; off keeps track", () => {
        expect(nextFlags({}, "auto_review", true)).toEqual({
            track: true,
            auto_review: true,
        })
        expect(nextFlags(r, "auto_review", false)).toEqual({
            track: true,
            auto_review: false,
        })
    })
    it("track off clears auto-review; on keeps it", () => {
        expect(nextFlags({ ...r, auto_review: true }, "track", false)).toEqual({
            track: false,
            auto_review: false,
        })
        expect(nextFlags({ auto_review: true }, "track", true)).toEqual({
            track: true,
            auto_review: true,
        })
        expect(nextFlags({}, "track", true)).toEqual({
            track: true,
            auto_review: false,
        })
    })
})

function open() {
    fireEvent.click(screen.getByRole("button", { name: /Repos/ }))
}

describe("ReviewRepos", () => {
    it("shows the tracked count and lists repos with their flags", async () => {
        mockFetch({ "GET /api/reviews/repos": { repos: REPOS } })
        renderWithApp(<ReviewRepos />)
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: /Repos/ })
            ).toHaveTextContent("2")
        )
        open()
        expect(await screen.findByText("mobile")).toHaveAttribute(
            "title",
            "the app"
        )
        expect(screen.getByLabelText("Track mobile")).toBeChecked()
        expect(screen.getByLabelText("Auto-review mobile")).not.toBeChecked()
        expect(screen.getByLabelText("Track aws-lambda")).not.toBeChecked()
        expect(screen.getByText("scanned 5m ago · 3 open")).toBeInTheDocument()
        expect(screen.getByText("not scanned yet")).toBeInTheDocument()
        expect(screen.getByText("gh: not found")).toBeInTheDocument()
        // only tracked repos get a scan button
        expect(screen.queryByLabelText("Scan aws-lambda now")).toBeNull()
    })

    it("auto-review on also tracks; the server answer wins", async () => {
        const onChanged = jest.fn()
        const f = mockFetch({
            "GET /api/reviews/repos": { repos: REPOS },
            "PUT /api/reviews/repos/aws-lambda": ({ body }) => ({
                repo: { name: "aws-lambda", ...body, last_scan_at: null },
            }),
        })
        renderWithApp(<ReviewRepos onChanged={onChanged} />)
        open()
        fireEvent.click(await screen.findByLabelText("Auto-review aws-lambda"))
        expect(screen.getByLabelText("Track aws-lambda")).toBeChecked()
        await waitFor(() => expect(onChanged).toHaveBeenCalled())
        expect(f.find("PUT", "/api/reviews/repos/aws-lambda")[0].body).toEqual({
            track: true,
            auto_review: true,
        })
        expect(screen.getByLabelText("Auto-review aws-lambda")).toBeChecked()
    })

    it("track off clears auto-review; errors roll back and toast", async () => {
        const f = mockFetch({
            "GET /api/reviews/repos": { repos: REPOS },
            "PUT /api/reviews/repos/web-trace": reply(500, {
                message: "save failed",
            }),
            "PUT /api/reviews/repos/mobile": {},
        })
        renderWithApp(<ReviewRepos />)
        open()
        fireEvent.click(await screen.findByLabelText("Track web-trace"))
        expect(await screen.findByText("save failed")).toBeInTheDocument()
        expect(f.find("PUT", "/api/reviews/repos/web-trace")[0].body).toEqual({
            track: false,
            auto_review: false,
        })
        expect(screen.getByLabelText("Track web-trace")).toBeChecked()
        expect(screen.getByLabelText("Auto-review web-trace")).toBeChecked()
        // an answer without a repo keeps the optimistic flags
        fireEvent.click(screen.getByLabelText("Track mobile"))
        await waitFor(() =>
            expect(screen.getByLabelText("Track mobile")).not.toBeDisabled()
        )
        expect(screen.getByLabelText("Track mobile")).not.toBeChecked()
    })

    it("a failed toggle undoes only its own repo", async () => {
        let fail
        mockFetch({
            "GET /api/reviews/repos": { repos: REPOS },
            "PUT /api/reviews/repos/web-trace": () =>
                new Promise((res) => {
                    fail = () => res(reply(500, { message: "save failed" }))
                }),
            "PUT /api/reviews/repos/mobile": {
                repo: { ...REPOS[0], auto_review: true },
            },
        })
        renderWithApp(<ReviewRepos />)
        open()
        fireEvent.click(await screen.findByLabelText("Track web-trace"))
        expect(screen.getByLabelText("Track web-trace")).toBeDisabled()
        fireEvent.click(screen.getByLabelText("Auto-review mobile"))
        await waitFor(() =>
            expect(
                screen.getByLabelText("Auto-review mobile")
            ).not.toBeDisabled()
        )
        expect(screen.getByLabelText("Track web-trace")).toBeDisabled()
        fail()
        expect(await screen.findByText("save failed")).toBeInTheDocument()
        expect(screen.getByLabelText("Track web-trace")).toBeChecked()
        expect(screen.getByLabelText("Auto-review mobile")).toBeChecked()
    })

    it("a load that started before a toggle never overwrites it", async () => {
        let gets = 0
        let late
        mockFetch({
            "GET /api/reviews/repos": () => {
                gets++
                if (gets === 1) return { repos: REPOS }
                // the reopen load: answered after the toggle saved
                return new Promise((res) => {
                    late = () => res({ repos: REPOS })
                })
            },
            "PUT /api/reviews/repos/aws-lambda": {
                repo: { ...REPOS[1], track: true },
            },
        })
        renderWithApp(<ReviewRepos />)
        open()
        await screen.findByLabelText("Track aws-lambda")
        fireEvent.click(screen.getByLabelText("Track aws-lambda"))
        await waitFor(() =>
            expect(screen.getByLabelText("Track aws-lambda")).not.toBeDisabled()
        )
        late && late()
        await new Promise((r) => setTimeout(r, 20))
        expect(screen.getByLabelText("Track aws-lambda")).toBeChecked()
    })

    it("a load overlapping a save in flight is dropped", async () => {
        let gets = 0
        let save
        let late
        mockFetch({
            "GET /api/reviews/repos": () => {
                gets++
                if (gets === 1) return { repos: REPOS }
                return new Promise((res) => {
                    late = () => res({ repos: REPOS })
                })
            },
            "PUT /api/reviews/repos/aws-lambda": () =>
                new Promise((res) => {
                    save = () => res({ repo: { ...REPOS[1], track: true } })
                }),
        })
        renderWithApp(<ReviewRepos />)
        await screen.findByRole("button", { name: /Repos/ })
        fireEvent.click(screen.getByRole("button", { name: /Repos/ }))
        await screen.findByLabelText("Track aws-lambda")
        late && late()
        fireEvent.click(screen.getByLabelText("Track aws-lambda"))
        // reopen while the save is in flight: a new load starts
        fireEvent.click(screen.getByRole("button", { name: /Repos/ }))
        fireEvent.click(screen.getByRole("button", { name: /Repos/ }))
        save()
        await waitFor(() =>
            expect(screen.getByLabelText("Track aws-lambda")).not.toBeDisabled()
        )
        late()
        await new Promise((r) => setTimeout(r, 20))
        expect(screen.getByLabelText("Track aws-lambda")).toBeChecked()
    })

    it("scans one repo and toasts errors", async () => {
        let n = 0
        const f = mockFetch({
            "GET /api/reviews/repos": { repos: REPOS },
            "POST /api/reviews/scan": () =>
                n++ === 0 ? { ok: true } : reply(500, { message: "no gh" }),
        })
        renderWithApp(<ReviewRepos />)
        open()
        fireEvent.click(await screen.findByLabelText("Scan mobile now"))
        expect(await screen.findByText("Scanning mobile…")).toBeInTheDocument()
        expect(f.find("POST", "/api/reviews/scan")[0].body).toEqual({
            repo: "mobile",
        })
        fireEvent.click(screen.getByLabelText("Scan mobile now"))
        expect(await screen.findByText("no gh")).toBeInTheDocument()
    })

    it("closes on Escape and outside clicks", async () => {
        mockFetch({ "GET /api/reviews/repos": { repos: REPOS } })
        renderWithApp(
            <div>
                <p>outside</p>
                <ReviewRepos />
            </div>
        )
        open()
        await screen.findByLabelText("Track mobile")
        fireEvent.mouseDown(screen.getByLabelText("Track mobile"))
        expect(screen.getByLabelText("Track mobile")).toBeInTheDocument()
        fireEvent.keyDown(document, { key: "Escape" })
        expect(screen.queryByLabelText("Track mobile")).toBeNull()
        open()
        await screen.findByLabelText("Track mobile")
        fireEvent.mouseDown(screen.getByText("outside"))
        expect(screen.queryByLabelText("Track mobile")).toBeNull()
        open()
        await screen.findByLabelText("Track mobile")
        fireEvent.click(screen.getByRole("button", { name: /Repos/ }))
        expect(screen.queryByLabelText("Track mobile")).toBeNull()
    })

    it("load errors, loading and empty lists", async () => {
        let n = 0
        mockFetch({
            "GET /api/reviews/repos": () =>
                n++ < 2
                    ? reply(500, { message: "repos failed" })
                    : { repos: [] },
        })
        renderWithApp(<ReviewRepos />)
        open()
        expect(await screen.findByText("repos failed")).toBeInTheDocument()
        expect(screen.getByText("Loading…")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: /Repos/ }))
        open()
        expect(
            await screen.findByText("No repos in the tree AGENTS.md table.")
        ).toBeInTheDocument()
    })
})
