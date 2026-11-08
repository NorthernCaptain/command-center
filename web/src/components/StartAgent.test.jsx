/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import StartAgent, { defaultKindOf } from "./StartAgent.jsx"
import { sampleTask } from "../../test/helpers.js"

const withRepo = (over = {}) =>
    sampleTask({ repos: [{ name: "aws-lambda", role: "main" }], ...over })

const settingsApi = (settings) => ({
    getSettings: jest.fn(async () => ({ settings })),
})

describe("defaultKindOf", () => {
    it("reads flat or nested settings", () => {
        expect(defaultKindOf({ "workers.default_kind": "codex" })).toBe("codex")
        expect(defaultKindOf({ workers: { default_kind: "codex" } })).toBe(
            "codex"
        )
        expect(defaultKindOf({})).toBeNull()
        expect(defaultKindOf(null)).toBeNull()
    })
})

describe("StartAgent", () => {
    it("defaults to the task's worker kind without asking the settings", async () => {
        const api = settingsApi({})
        const onStart = jest.fn(async () => {})
        render(
            <StartAgent
                task={withRepo({ worker_kind: "codex" })}
                onStart={onStart}
                api={api}
            />
        )
        expect(screen.getByLabelText("Agent kind")).toHaveValue("codex")
        fireEvent.click(
            screen.getByRole("button", { name: "Start with Codex" })
        )
        await waitFor(() => expect(onStart).toHaveBeenCalledWith("codex", null))
        expect(api.getSettings).not.toHaveBeenCalled()
    })

    it("falls back to the settings default, and the user can pick", async () => {
        const api = settingsApi({ "workers.default_kind": "codex" })
        const onStart = jest.fn(async () => {})
        render(<StartAgent task={withRepo()} onStart={onStart} api={api} />)
        expect(screen.getByLabelText("Agent kind")).toHaveValue("claude")
        await waitFor(() =>
            expect(screen.getByLabelText("Agent kind")).toHaveValue("codex")
        )
        fireEvent.change(screen.getByLabelText("Agent kind"), {
            target: { value: "claude" },
        })
        fireEvent.click(
            screen.getByRole("button", { name: "Start with Claude" })
        )
        await waitFor(() =>
            expect(onStart).toHaveBeenCalledWith("claude", null)
        )
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Start with Claude" })
            ).not.toBeDisabled()
        )
    })

    it("keeps the built-in default when settings fail or are invalid", async () => {
        const api = {
            getSettings: jest.fn(async () => ({
                settings: { "workers.default_kind": "gpt" },
            })),
        }
        const { unmount } = render(
            <StartAgent task={withRepo()} onStart={jest.fn()} api={api} />
        )
        await waitFor(() => expect(api.getSettings).toHaveBeenCalled())
        expect(screen.getByLabelText("Agent kind")).toHaveValue("claude")
        unmount()
        const failing = {
            getSettings: jest.fn(async () => {
                throw new Error("down")
            }),
        }
        render(
            <StartAgent task={withRepo()} onStart={jest.fn()} api={failing} />
        )
        await waitFor(() => expect(failing.getSettings).toHaveBeenCalled())
        expect(screen.getByLabelText("Agent kind")).toHaveValue("claude")
    })

    it("ignores a settings answer after unmount", async () => {
        let resolve
        const api = {
            getSettings: jest.fn(() => new Promise((r) => (resolve = r))),
        }
        const { unmount } = render(
            <StartAgent task={withRepo()} onStart={jest.fn()} api={api} />
        )
        unmount()
        resolve({ settings: { "workers.default_kind": "codex" } })
        await Promise.resolve()
    })

    it("a task without repos asks for one before Start", async () => {
        const api = {
            getSettings: jest.fn(async () => ({ settings: {} })),
            listRepos: jest.fn(async () => ({
                repos: [{ name: "aws-batch" }, { name: "web-trace" }],
            })),
        }
        const onStart = jest.fn(async () => {})
        render(
            <StartAgent
                task={sampleTask({ repos: [] })}
                onStart={onStart}
                api={api}
            />
        )
        const start = screen.getByRole("button", { name: "Start with Claude" })
        expect(start).toBeDisabled()
        expect(start).toHaveAttribute("title", "Pick a repo first")
        const pick = screen.getByLabelText("Repo for the agent")
        await waitFor(() => expect(pick).not.toBeDisabled())
        fireEvent.change(pick, { target: { value: "aws-batch" } })
        expect(start).not.toBeDisabled()
        fireEvent.click(start)
        await waitFor(() =>
            expect(onStart).toHaveBeenCalledWith("claude", "aws-batch")
        )
    })

    it("no repo list (error) keeps Start disabled", async () => {
        const api = {
            getSettings: jest.fn(async () => ({ settings: {} })),
            listRepos: jest.fn(async () => {
                throw new Error("down")
            }),
        }
        render(
            <StartAgent
                task={sampleTask({ repos: undefined })}
                onStart={jest.fn()}
                api={api}
            />
        )
        await waitFor(() =>
            expect(
                screen.getByRole("option", { name: "pick a repo" })
            ).toBeTruthy()
        )
        expect(
            screen.getByRole("button", { name: "Start with Claude" })
        ).toBeDisabled()
    })
})
