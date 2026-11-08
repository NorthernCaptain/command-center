/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import RepoPicker, { addRepo, removeRepo, setRepoRole } from "./RepoPicker.jsx"

const KNOWN = [
    { name: "aws-batch", description: "game processing" },
    { name: "aws-lambda", description: null },
    { name: "web-trace", description: null },
]
const reposApi = (repos = KNOWN) => ({
    listRepos: jest.fn(async () => ({ repos })),
})

describe("repo list helpers", () => {
    it("addRepo: first is main, the rest work; no duplicates or blanks", () => {
        const one = addRepo([], "aws-batch")
        expect(one).toEqual([{ name: "aws-batch", role: "main" }])
        const two = addRepo(one, "web-trace")
        expect(two[1]).toEqual({ name: "web-trace", role: "work" })
        expect(addRepo(two, "web-trace")).toBe(two)
        expect(addRepo(two, "")).toBe(two)
        expect(addRepo(undefined, "x")).toEqual([{ name: "x", role: "main" }])
    })

    it("setRepoRole: a new main demotes the old one", () => {
        const list = [
            { name: "a", role: "main" },
            { name: "b", role: "ref" },
        ]
        expect(setRepoRole(list, "b", "main")).toEqual([
            { name: "a", role: "work" },
            { name: "b", role: "main" },
        ])
        expect(setRepoRole(list, "a", "ref")).toEqual([
            { name: "a", role: "ref" },
            { name: "b", role: "ref" },
        ])
        expect(setRepoRole(undefined, "a", "main")).toEqual([])
    })

    it("removeRepo: removing the main promotes the next repo", () => {
        const list = [
            { name: "a", role: "main" },
            { name: "b", role: "ref" },
        ]
        expect(removeRepo(list, "a")).toEqual([{ name: "b", role: "main" }])
        expect(removeRepo(list, "b")).toEqual([{ name: "a", role: "main" }])
        expect(removeRepo([{ name: "a", role: "main" }], "a")).toEqual([])
        expect(removeRepo(undefined, "a")).toEqual([])
    })
})

describe("RepoPicker", () => {
    it("viewer: read-only chips, or none; never asks the server", () => {
        const api = reposApi()
        const { rerender } = render(
            <RepoPicker
                repos={[{ name: "aws-batch", role: "main" }]}
                isOwner={false}
                api={api}
            />
        )
        expect(screen.getByText("aws-batch")).toBeInTheDocument()
        expect(screen.getByText("main")).toBeInTheDocument()
        expect(screen.queryByLabelText("Add repo")).toBeNull()
        rerender(<RepoPicker repos={[]} isOwner={false} api={api} />)
        expect(screen.getByText("none")).toBeInTheDocument()
        expect(api.listRepos).not.toHaveBeenCalled()
    })

    it("owner: add, change role and remove save the new list", async () => {
        const api = reposApi()
        const onChange = jest.fn(async () => {})
        const repos = [{ name: "aws-batch", role: "main" }]
        render(
            <RepoPicker repos={repos} isOwner onChange={onChange} api={api} />
        )
        const add = screen.getByLabelText("Add repo")
        await waitFor(() => expect(add).not.toBeDisabled())
        // assigned repos are not offered again
        expect(screen.queryByRole("option", { name: "aws-batch" })).toBeNull()
        fireEvent.change(add, { target: { value: "web-trace" } })
        await waitFor(() =>
            expect(onChange).toHaveBeenLastCalledWith([
                { name: "aws-batch", role: "main" },
                { name: "web-trace", role: "work" },
            ])
        )
        await waitFor(() =>
            expect(
                screen.getByLabelText("Role of aws-batch")
            ).not.toBeDisabled()
        )
        fireEvent.change(screen.getByLabelText("Role of aws-batch"), {
            target: { value: "ref" },
        })
        await waitFor(() =>
            expect(onChange).toHaveBeenLastCalledWith([
                { name: "aws-batch", role: "ref" },
            ])
        )
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Remove aws-batch" })
            ).not.toBeDisabled()
        )
        fireEvent.click(
            screen.getByRole("button", { name: "Remove aws-batch" })
        )
        await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([]))
    })

    it("owner with no repos shows none; a failing list leaves add disabled", async () => {
        const api = {
            listRepos: jest.fn(async () => Promise.reject(new Error("x"))),
        }
        render(<RepoPicker repos={[]} isOwner onChange={jest.fn()} api={api} />)
        expect(screen.getByText("none")).toBeInTheDocument()
        expect(screen.getByRole("option", { name: "loading…" })).toBeTruthy()
        await waitFor(() =>
            expect(screen.getByRole("option", { name: "+ repo" })).toBeTruthy()
        )
        expect(screen.getByLabelText("Add repo")).toBeDisabled()
    })

    it("an empty answer and a late answer after unmount are handled", async () => {
        let resolve
        const api = {
            listRepos: jest.fn(
                () =>
                    new Promise((r) => {
                        resolve = r
                    })
            ),
        }
        const { unmount } = render(
            <RepoPicker repos={null} isOwner onChange={jest.fn()} api={api} />
        )
        unmount()
        resolve(null)
        await Promise.resolve()
        const api2 = { listRepos: jest.fn(async () => null) }
        render(
            <RepoPicker repos={[]} isOwner onChange={jest.fn()} api={api2} />
        )
        await waitFor(() =>
            expect(screen.getByRole("option", { name: "+ repo" })).toBeTruthy()
        )
    })
})
