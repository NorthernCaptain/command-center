/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import DigestCard from "./DigestCard.jsx"
import { localDate } from "../lib/digest.js"
import { emit, freshStream } from "../../test/render.jsx"

const today = () => localDate(new Date())

function digest(over = {}) {
    return {
        digest: {
            date: today(),
            generated_at: new Date().toISOString(),
            summary: "Morning: 1 in Now, 1 PR",
            sections: [
                {
                    id: "now",
                    title: "Now",
                    items: [{ task_id: 12, title: "Fix lambda", note: "due" }],
                },
                {
                    id: "prs",
                    title: "PRs waiting on you",
                    items: [
                        { title: "External PR", url: "https://gh/pull/1" },
                        { title: "Plain text" },
                    ],
                },
            ],
            ...over,
        },
    }
}

let stream
beforeEach(() => {
    stream = freshStream()
    localStorage.clear()
})

describe("DigestCard", () => {
    it("shows today's digest and dismisses it for the day", async () => {
        const api = { getDigest: jest.fn(async () => digest()) }
        render(<DigestCard api={api} />)
        expect(
            await screen.findByRole("region", { name: "Morning digest" })
        ).toBeInTheDocument()
        expect(screen.getByText("Morning: 1 in Now, 1 PR")).toBeInTheDocument()
        expect(
            screen.getByRole("link", { name: /T-12 Fix lambda/ })
        ).toHaveAttribute("href", "/t/12")
        expect(
            screen.getByRole("link", { name: "External PR" })
        ).toHaveAttribute("href", "https://gh/pull/1")
        expect(screen.getByText("Plain text")).toBeInTheDocument()
        expect(screen.getByText("due")).toBeInTheDocument()
        fireEvent.click(
            screen.getByRole("button", { name: "Dismiss morning digest" })
        )
        expect(
            screen.queryByRole("region", { name: "Morning digest" })
        ).toBeNull()
        expect(localStorage.getItem("cc.digest.dismissed")).toBe(today())
    })

    it("stays hidden when dismissed today, for old digests and errors", async () => {
        localStorage.setItem("cc.digest.dismissed", today())
        const api = { getDigest: jest.fn(async () => digest()) }
        const { unmount } = render(<DigestCard api={api} />)
        await waitFor(() => expect(api.getDigest).toHaveBeenCalled())
        expect(screen.queryByRole("region")).toBeNull()
        unmount()

        localStorage.clear()
        const old = {
            getDigest: jest.fn(async () =>
                digest({ date: "2020-01-01", generated_at: null, summary: "" })
            ),
        }
        const r2 = render(<DigestCard api={old} />)
        await waitFor(() => expect(old.getDigest).toHaveBeenCalled())
        expect(screen.queryByRole("region")).toBeNull()
        r2.unmount()

        const failing = {
            getDigest: jest.fn(async () => {
                throw new Error("404")
            }),
        }
        render(<DigestCard api={failing} />)
        await waitFor(() => expect(failing.getDigest).toHaveBeenCalled())
        expect(screen.queryByRole("region")).toBeNull()
    })

    it("refreshes on digest.updated and reconnects", async () => {
        const api = {
            getDigest: jest
                .fn()
                .mockResolvedValueOnce({ digest: null })
                .mockResolvedValue(digest({ generated_at: null, summary: "" })),
        }
        render(<DigestCard api={api} />)
        await waitFor(() => expect(api.getDigest).toHaveBeenCalledTimes(1))
        expect(screen.queryByRole("region")).toBeNull()
        act(() => emit(stream, "digest.updated", null, {}))
        expect(
            await screen.findByRole("region", { name: "Morning digest" })
        ).toBeInTheDocument()
        act(() => emit(stream, "stream.reconnected", null, {}))
        await waitFor(() => expect(api.getDigest).toHaveBeenCalledTimes(3))
    })

    it("ignores a response after unmount", async () => {
        let resolve
        const api = {
            getDigest: jest.fn(() => new Promise((r) => (resolve = r))),
        }
        const { unmount } = render(<DigestCard api={api} />)
        unmount()
        await act(async () => resolve(digest()))
        expect(screen.queryByRole("region")).toBeNull()
    })
})
