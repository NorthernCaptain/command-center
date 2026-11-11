/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"
import Settings, {
    MODEL_DEFAULTS,
    changedSettings,
    modelChanges,
    modelState,
    readSetting,
    rebaseForm,
    settingErrors,
    toForm,
} from "./Settings.jsx"
import { mockFetch, reply } from "../../test/helpers.js"
import {
    ALL_FEATURES,
    emit,
    freshStream,
    renderWithApp,
} from "../../test/render.jsx"

const SETTINGS = {
    "center.provider": "claude-sdk",
    "center.fallback_provider": "codex",
    "center.auto_fallback": false,
    "center.models": {
        "claude-sdk": { light: "claude-haiku-5-5", heavy: "claude-sonnet-5-5" },
        "claude-cli": { light: "claude-haiku-5-5", heavy: "claude-sonnet-5-5" },
        codex: { light: "gpt-6-luna", heavy: "gpt-6.1-sol" },
    },
    "workers.default_kind": "claude",
}

const DEVICES = [
    {
        id: "d1",
        name: "iPhone",
        created_at: "2026-11-01T10:00:00Z",
        last_seen_at: "2026-11-07T08:00:00Z",
        revoked_at: null,
    },
    {
        id: "d2",
        name: "Old iPad",
        created_at: "2026-10-01T10:00:00Z",
        last_seen_at: null,
        revoked_at: "2026-10-05T10:00:00Z",
    },
]

let stream
beforeEach(() => {
    stream = freshStream()
})

describe("rebaseForm", () => {
    it("takes server values for untouched fields and keeps edits", () => {
        const orig = toForm(SETTINGS)
        const form = {
            ...orig,
            "center.auto_fallback": true,
            "center.models": {
                ...orig["center.models"],
                codex: { light: "a", heavy: "" },
            },
        }
        const server = toForm({
            ...SETTINGS,
            "center.provider": "codex",
            "center.auto_fallback": false,
            "center.models": {
                ...SETTINGS["center.models"],
                codex: { light: "s1", heavy: "s2" },
                "claude-sdk": { light: "n1", heavy: "n2" },
            },
        })
        const out = rebaseForm(orig, form, server)
        expect(out["center.provider"]).toBe("codex")
        expect(out["center.auto_fallback"]).toBe(true)
        expect(out["center.models"].codex).toEqual({ light: "a", heavy: "" })
        expect(out["center.models"]["claude-sdk"]).toEqual({
            light: "n1",
            heavy: "n2",
        })
        // a clean form simply becomes the server form
        expect(rebaseForm(orig, orig, server)).toEqual(server)
    })
})

describe("readSetting / changedSettings", () => {
    it("reads flat, nested and default values", () => {
        expect(
            readSetting({ "center.provider": "codex" }, "center.provider")
        ).toBe("codex")
        expect(
            readSetting(
                { center: { provider: "claude-cli" } },
                "center.provider"
            )
        ).toBe("claude-cli")
        expect(readSetting({ center: {} }, "center.provider")).toBe(
            "claude-sdk"
        )
        expect(readSetting(null, "center.auto_fallback")).toBe(false)
    })
    it("diffs deeply, sending only changed complete model pairs", () => {
        const a = toForm({
            "center.models": { codex: { light: "1", heavy: "h" } },
        })
        const b = toForm({
            "center.models": {
                codex: { light: "2", heavy: "h" },
                "claude-cli": { light: "only light" },
            },
        })
        expect(changedSettings(a, b)).toEqual({
            "center.models": { codex: { light: "2", heavy: "h" } },
        })
        // every provider has a pair in the form, but untouched empty pairs
        // and half-filled ones are never sent
        expect(b["center.models"]["claude-sdk"]).toEqual({
            light: "",
            heavy: "",
        })
        expect(
            changedSettings(a, { ...a, "center.provider": "codex" })
        ).toEqual({ "center.provider": "codex" })
    })

    it("classifies model pairs and trims sent values", () => {
        expect(
            modelState({ light: "a", heavy: "b" }, { light: "a", heavy: "b" })
        ).toBe("same")
        expect(modelState(undefined, { light: "", heavy: "" })).toBe("same")
        expect(modelState({}, { light: "a", heavy: "b" })).toBe("ready")
        expect(modelState({}, { light: "a", heavy: " " })).toBe("partial")
        expect(
            modelState({ light: "a", heavy: "b" }, { light: "", heavy: "" })
        ).toBe("cleared")
        expect(modelState({ light: "a", heavy: "b" }, null)).toBe("cleared")
        expect(
            modelChanges(undefined, { codex: { light: " x ", heavy: "y" } })
        ).toEqual({
            codex: { light: "x", heavy: "y" },
        })
        expect(modelChanges()).toEqual({})
    })
})

describe("Settings (owner)", () => {
    function setup(routes = {}) {
        return mockFetch({
            "GET /api/settings": { settings: SETTINGS },
            "GET /api/devices": { devices: DEVICES },
            ...routes,
        })
    }

    it("saves the provider switch and models", async () => {
        const f = setup({
            "PATCH /api/settings": ({ body }) => ({
                settings: { ...SETTINGS, ...body },
            }),
        })
        renderWithApp(<Settings />)
        const provider = await screen.findByDisplayValue("claude-sdk")
        const save = screen.getByRole("button", { name: "Save" })
        expect(save).toBeDisabled()
        fireEvent.change(provider, { target: { value: "codex" } })
        fireEvent.click(screen.getByLabelText(/Fall back automatically/))
        fireEvent.change(screen.getByLabelText("codex heavy model"), {
            target: { value: "gpt-7" },
        })
        expect(screen.getByText("3 unsaved change(s)")).toBeInTheDocument()
        fireEvent.click(save)
        await screen.findByText("Settings saved")
        const body = f.find("PATCH", "/api/settings")[0].body
        expect(body["center.provider"]).toBe("codex")
        expect(body["center.auto_fallback"]).toBe(true)
        expect(body["center.models"].codex).toEqual({
            light: "gpt-6-luna",
            heavy: "gpt-7",
        })
        expect(body["center.fallback_provider"]).toBeUndefined()
        expect(save).toBeDisabled()
    })

    it("resets, sets fallback none and worker kind, and reports save errors", async () => {
        const f = setup({
            "PATCH /api/settings": reply(400, {
                error: "validation",
                message: "unknown key",
            }),
        })
        renderWithApp(<Settings />)
        await screen.findByDisplayValue("claude-sdk")
        const fallback = screen.getAllByRole("combobox")[1]
        fireEvent.change(fallback, { target: { value: "" } })
        fireEvent.click(screen.getByRole("button", { name: "Reset" }))
        expect(fallback).toHaveValue("codex")
        fireEvent.change(fallback, { target: { value: "" } })
        fireEvent.change(screen.getAllByRole("combobox")[2], {
            target: { value: "codex" },
        })
        fireEvent.change(screen.getByLabelText("claude-cli light model"), {
            target: { value: "x" },
        })
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
        expect(await screen.findByText("unknown key")).toBeInTheDocument()
        expect(f.find("PATCH", "/api/settings")[0].body).toEqual({
            "center.fallback_provider": null,
            "center.models": {
                "claude-cli": { light: "x", heavy: "claude-sonnet-5-5" },
            },
            "workers.default_kind": "codex",
        })
    })

    it("switches provider without touching unset model overrides", async () => {
        const bare = {
            "center.provider": "claude-sdk",
            "center.fallback_provider": null,
            "center.auto_fallback": false,
            "workers.default_kind": "claude",
        }
        const f = setup({
            "GET /api/settings": { settings: bare },
            "PATCH /api/settings": ({ body }) => ({
                settings: { ...bare, ...body },
            }),
        })
        renderWithApp(<Settings />)
        await screen.findByDisplayValue("claude-sdk")
        // null fallback renders as "none"
        const fallback = screen.getAllByRole("combobox")[1]
        expect(fallback).toHaveValue("")
        expect(fallback.selectedOptions[0].textContent).toBe("none")
        // defaults are placeholders, not values
        for (const p of Object.keys(MODEL_DEFAULTS)) {
            const light = screen.getByLabelText(`${p} light model`)
            const heavy = screen.getByLabelText(`${p} heavy model`)
            expect(light).toHaveValue("")
            expect(light).toHaveAttribute(
                "placeholder",
                MODEL_DEFAULTS[p].light
            )
            expect(heavy).toHaveAttribute(
                "placeholder",
                MODEL_DEFAULTS[p].heavy
            )
        }
        // a half-filled pair can't be saved on its own...
        fireEvent.change(screen.getByLabelText("codex light model"), {
            target: { value: "gpt-x" },
        })
        expect(
            screen.getByText("Fill in both light and heavy to override.")
        ).toBeInTheDocument()
        const save = screen.getByRole("button", { name: "Save" })
        expect(save).toBeDisabled()
        expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled()
        // ...but does not block the provider switch
        fireEvent.change(screen.getAllByRole("combobox")[0], {
            target: { value: "codex" },
        })
        expect(screen.getByText("1 unsaved change(s)")).toBeInTheDocument()
        fireEvent.click(save)
        await screen.findByText("Settings saved")
        expect(f.find("PATCH", "/api/settings")[0].body).toEqual({
            "center.provider": "codex",
        })
        // the unsent half pair is kept in the form
        expect(screen.getByLabelText("codex light model")).toHaveValue("gpt-x")
        fireEvent.change(screen.getByLabelText("codex heavy model"), {
            target: { value: "gpt-y" },
        })
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
        await waitFor(() =>
            expect(f.find("PATCH", "/api/settings")).toHaveLength(2)
        )
        expect(f.find("PATCH", "/api/settings")[1].body).toEqual({
            "center.models": { codex: { light: "gpt-x", heavy: "gpt-y" } },
        })
    })

    it("does not send a cleared model pair", async () => {
        setup()
        renderWithApp(<Settings />)
        await screen.findByDisplayValue("claude-sdk")
        fireEvent.change(screen.getByLabelText("codex light model"), {
            target: { value: "" },
        })
        fireEvent.change(screen.getByLabelText("codex heavy model"), {
            target: { value: "" },
        })
        expect(
            screen.getByText(
                "Empty fields are not saved; the current override stays."
            )
        ).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
        fireEvent.click(screen.getByRole("button", { name: "Reset" }))
        expect(screen.getByLabelText("codex light model")).toHaveValue(
            "gpt-6-luna"
        )
    })

    it("follows settings.updated when the form is clean", async () => {
        setup()
        renderWithApp(<Settings />)
        await screen.findByDisplayValue("claude-sdk")
        act(() =>
            emit(stream, "settings.updated", null, {
                settings: { ...SETTINGS, "center.provider": "claude-cli" },
            })
        )
        expect(screen.getAllByRole("combobox")[0]).toHaveValue("claude-cli")
        // dirty form is not overwritten
        fireEvent.change(screen.getAllByRole("combobox")[0], {
            target: { value: "codex" },
        })
        act(() =>
            emit(stream, "settings.updated", null, { settings: SETTINGS })
        )
        expect(screen.getAllByRole("combobox")[0]).toHaveValue("codex")
        act(() => emit(stream, "settings.updated", null, {}))
    })

    it("rebases a dirty form on settings.updated so Save keeps changes made elsewhere", async () => {
        const f = setup({
            "PATCH /api/settings": ({ body }) => ({
                settings: {
                    ...SETTINGS,
                    "center.provider": "codex",
                    ...body,
                },
            }),
        })
        renderWithApp(<Settings />)
        const light = await screen.findByLabelText("codex light model")
        fireEvent.change(light, { target: { value: "x" } })
        fireEvent.change(screen.getByLabelText("codex heavy model"), {
            target: { value: "y" },
        })
        fireEvent.change(screen.getAllByRole("combobox")[1], {
            target: { value: "claude-cli" },
        })
        // another tab switched the provider and the claude-cli models
        act(() =>
            emit(stream, "settings.updated", null, {
                settings: {
                    ...SETTINGS,
                    "center.provider": "codex",
                    "center.fallback_provider": "claude-sdk",
                    "center.models": {
                        ...SETTINGS["center.models"],
                        "claude-cli": { light: "l2", heavy: "h2" },
                    },
                },
            })
        )
        expect(screen.getAllByRole("combobox")[0]).toHaveValue("codex")
        // my edits are kept
        expect(screen.getAllByRole("combobox")[1]).toHaveValue("claude-cli")
        expect(screen.getByLabelText("codex light model")).toHaveValue("x")
        expect(screen.getByLabelText("claude-cli light model")).toHaveValue(
            "l2"
        )
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
        await screen.findByText("Settings saved")
        expect(f.find("PATCH", "/api/settings")[0].body).toEqual({
            "center.fallback_provider": "claude-cli",
            "center.models": { codex: { light: "x", heavy: "y" } },
        })
    })

    it("shows a settings load error", async () => {
        mockFetch({
            "GET /api/settings": reply(500, {
                error: "x",
                message: "settings broke",
            }),
            "GET /api/devices": reply(500, {
                error: "x",
                message: "devices broke",
            }),
        })
        renderWithApp(<Settings />)
        expect(await screen.findByText("settings broke")).toBeInTheDocument()
        expect(await screen.findByText("devices broke")).toBeInTheDocument()
    })

    it("lists devices, revokes with confirmation and shows a pairing code", async () => {
        const f = setup({
            "DELETE /api/devices/d1": { ok: true },
            "POST /api/pair/code": {
                code: "123456",
                expires_at: new Date(Date.now() + 600000).toISOString(),
            },
        })
        renderWithApp(<Settings />)
        expect(await screen.findByText("iPhone")).toBeInTheDocument()
        expect(screen.getByText("revoked")).toBeInTheDocument()
        const row = screen.getByText("iPhone").closest("li")
        fireEvent.click(within(row).getByRole("button", { name: "Revoke" }))
        expect(f.find("DELETE", "/api/devices/d1")).toHaveLength(0)
        const dlg = screen.getByRole("alertdialog", { name: "Revoke iPhone?" })
        expect(dlg).toHaveTextContent("push notifications stop")
        fireEvent.click(within(dlg).getByRole("button", { name: "Revoke" }))
        await screen.findByText("Revoked iPhone")
        await waitFor(() =>
            expect(f.find("GET", "/api/devices")).toHaveLength(2)
        )

        fireEvent.click(screen.getByRole("button", { name: "Pair a device" }))
        expect(
            await screen.findByLabelText("Pairing code 123456")
        ).toBeInTheDocument()
        expect(screen.getByText(/expires in (9|10):/)).toBeInTheDocument()
    })

    it("handles expired codes, empty device lists and errors", async () => {
        let n = 0
        setup({
            "GET /api/devices": { devices: [] },
            "POST /api/pair/code": () =>
                n++ === 0
                    ? {
                          code: "654321",
                          expires_at: new Date(Date.now() - 1000).toISOString(),
                      }
                    : reply(500, { error: "x", message: "no codes" }),
            "DELETE /api/devices/d1": reply(500, {
                error: "x",
                message: "revoke failed",
            }),
        })
        renderWithApp(<Settings />)
        expect(
            await screen.findByText("No paired devices.")
        ).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Pair a device" }))
        expect(
            await screen.findByRole("button", {
                name: "Code expired, pair again",
            })
        ).toBeInTheDocument()
        fireEvent.click(
            screen.getByRole("button", { name: "Code expired, pair again" })
        )
        expect(await screen.findByText("no codes")).toBeInTheDocument()
    })

    it("toasts revoke errors", async () => {
        setup({
            "DELETE /api/devices/d1": reply(500, {
                error: "x",
                message: "revoke failed",
            }),
        })
        renderWithApp(<Settings />)
        const row = (await screen.findByText("iPhone")).closest("li")
        fireEvent.click(within(row).getByRole("button", { name: "Revoke" }))
        fireEvent.click(
            within(screen.getByRole("alertdialog")).getByRole("button", {
                name: "Revoke",
            })
        )
        expect(await screen.findByText("revoke failed")).toBeInTheDocument()
    })

    it("counts down the pairing code", async () => {
        jest.useFakeTimers()
        setup({
            "POST /api/pair/code": {
                code: "111222",
                expires_at: new Date(Date.now() + 65000).toISOString(),
            },
        })
        renderWithApp(<Settings />)
        await act(async () => {
            await Promise.resolve()
        })
        fireEvent.click(
            await screen.findByRole("button", { name: "Pair a device" })
        )
        await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
        })
        expect(screen.getByText(/expires in 1:05/)).toBeInTheDocument()
        act(() => jest.advanceTimersByTime(2000))
        expect(screen.getByText(/expires in 1:03/)).toBeInTheDocument()
        jest.useRealTimers()
    })
})

describe("Settings (viewer)", () => {
    it("tailnet viewer can pair this device", async () => {
        const refreshMe = jest.fn(async () => {})
        const f = mockFetch({ "POST /api/pair": { device: { id: "d3" } } })
        renderWithApp(<Settings />, {
            role: "viewer",
            mode: "tailnet",
            refreshMe,
        })
        const btn = screen.getByRole("button", { name: "Pair this device" })
        expect(btn).toBeDisabled()
        fireEvent.change(screen.getByLabelText("Pairing code"), {
            target: { value: "123 456" },
        })
        fireEvent.change(screen.getByLabelText("Device name"), {
            target: { value: "Leo's iPhone" },
        })
        fireEvent.click(btn)
        await screen.findByText(/Device paired/)
        expect(f.find("POST", "/api/pair")[0].body).toEqual({
            code: "123456",
            name: "Leo's iPhone",
        })
        expect(refreshMe).toHaveBeenCalled()
    })

    it("pairing errors are toasted; blank name falls back", async () => {
        const f = mockFetch({
            "POST /api/pair": reply(403, { error: "forbidden" }),
        })
        renderWithApp(<Settings />, { role: "viewer", mode: "tailnet" })
        fireEvent.change(screen.getByLabelText("Pairing code"), {
            target: { value: "999999" },
        })
        fireEvent.change(screen.getByLabelText("Device name"), {
            target: { value: " " },
        })
        fireEvent.click(
            screen.getByRole("button", { name: "Pair this device" })
        )
        expect(
            await screen.findByText("Owner access required")
        ).toBeInTheDocument()
        expect(f.find("POST", "/api/pair")[0].body.name).toBe("Device")
    })

    it("local viewers see a read-only notice", () => {
        mockFetch({})
        renderWithApp(<Settings />, { role: "viewer", mode: "local" })
        expect(screen.getByText("Read-only access")).toBeInTheDocument()
        expect(screen.queryByText("Center agent")).not.toBeInTheDocument()
    })
})

describe("Settings: phase 2/3", () => {
    function setup(routes = {}) {
        return mockFetch({
            "GET /api/settings": { settings: SETTINGS },
            "GET /api/devices": { devices: DEVICES },
            ...routes,
        })
    }

    it("uses the shared defaults for absent keys", () => {
        const form = toForm({})
        expect(form["workers.default_kind"]).toBe("claude")
        expect(form["github.poll_minutes"]).toBe(15)
        expect(form["digest.enabled"]).toBe(true)
        expect(form["digest.time"]).toBe("08:30")
        expect(form["stale.days"]).toBe(7)
        expect(form["push.enabled"]).toBe(false)
        expect(readSetting(null, "digest.time")).toBe("08:30")
    })

    it("settingErrors checks the server ranges", () => {
        const ok = toForm({})
        expect(settingErrors(ok)).toEqual({})
        expect(
            Object.keys(
                settingErrors({
                    ...ok,
                    "github.poll_minutes": 2,
                    "digest.time": "25:00",
                    "stale.days": "",
                })
            )
        ).toEqual(["github.poll_minutes", "digest.time", "stale.days"])
        expect(settingErrors({ ...ok, "digest.time": null })).toHaveProperty([
            "digest.time",
        ])
    })

    it("toggles auto clean and close after done (default on, needs workers)", async () => {
        const f = setup({
            "PATCH /api/settings": ({ body }) => ({
                settings: { ...SETTINGS, ...body },
            }),
        })
        renderWithApp(<Settings />, { features: { workers: true } })
        await screen.findByDisplayValue("claude-sdk")
        const box = screen.getByLabelText(
            /When a task is done, clean its folders/
        )
        expect(box).toBeChecked()
        fireEvent.click(box)
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
        await screen.findByText("Settings saved")
        const body = f.find("PATCH", "/api/settings")[0].body
        expect(body).toEqual({ "workers.auto_clean_on_done": false })
    })

    it("hides automation, push and SOC2 without the features", async () => {
        setup()
        renderWithApp(<Settings />)
        await screen.findByDisplayValue("claude-sdk")
        expect(screen.queryByText("Automation")).toBeNull()
        expect(screen.queryByText("Notifications on this device")).toBeNull()
        expect(screen.queryByText("SOC2 evidence")).toBeNull()
        expect(
            screen.queryByRole("button", { name: "Run digest now" })
        ).toBeNull()
    })

    it("shows only the sections of enabled features", async () => {
        setup()
        renderWithApp(<Settings />, { features: { github: true } })
        await screen.findByDisplayValue("claude-sdk")
        expect(screen.getByLabelText("PR poll (minutes)")).toHaveValue(15)
        expect(screen.queryByLabelText("Digest time")).toBeNull()
        expect(screen.queryByLabelText("Push notifications")).toBeNull()
    })

    it("edits and validates the automation settings", async () => {
        const f = setup({
            "PATCH /api/settings": ({ body }) => ({
                settings: { ...SETTINGS, ...body },
            }),
        })
        renderWithApp(<Settings />, { features: ALL_FEATURES })
        await screen.findByDisplayValue("claude-sdk")
        const save = screen.getByRole("button", { name: "Save" })
        const poll = screen.getByLabelText("PR poll (minutes)")
        fireEvent.change(poll, { target: { value: "2" } })
        expect(screen.getByRole("alert")).toHaveTextContent("5 to 1440")
        expect(save).toBeDisabled()
        fireEvent.change(poll, { target: { value: "" } })
        expect(save).toBeDisabled()
        fireEvent.change(poll, { target: { value: "30" } })
        fireEvent.change(screen.getByLabelText("Flag stale after (days)"), {
            target: { value: "0" },
        })
        expect(screen.getByRole("alert")).toHaveTextContent("1 to 90")
        fireEvent.change(screen.getByLabelText("Flag stale after (days)"), {
            target: { value: "10" },
        })
        const time = screen.getByLabelText("Digest time")
        expect(time).toHaveValue("08:30")
        fireEvent.change(time, { target: { value: "" } })
        expect(screen.getByRole("alert")).toHaveTextContent("HH:MM")
        fireEvent.change(time, { target: { value: "07:15" } })
        fireEvent.click(screen.getByLabelText("Morning digest"))
        expect(time).toBeDisabled()
        fireEvent.click(screen.getByLabelText("Push notifications"))
        expect(save).not.toBeDisabled()
        fireEvent.click(save)
        await screen.findByText("Settings saved")
        expect(f.find("PATCH", "/api/settings")[0].body).toEqual({
            "github.poll_minutes": 30,
            "stale.days": 10,
            "digest.time": "07:15",
            "digest.enabled": false,
            "push.enabled": true,
        })
    })

    it("runs the digest on demand", async () => {
        let n = 0
        setup({
            "POST /api/digest/run": () =>
                ++n === 1
                    ? { digest: {} }
                    : reply(500, { message: "no digest" }),
        })
        renderWithApp(<Settings />, { features: ALL_FEATURES })
        const btn = await screen.findByRole("button", {
            name: "Run digest now",
        })
        fireEvent.click(btn)
        expect(
            await screen.findByText("Digest ready: see Home")
        ).toBeInTheDocument()
        await waitFor(() => expect(btn).not.toBeDisabled())
        fireEvent.click(btn)
        expect(await screen.findByText("no digest")).toBeInTheDocument()
    })

    it("shows the push and SOC2 cards with their features", async () => {
        setup()
        renderWithApp(<Settings />, { features: ALL_FEATURES })
        await screen.findByDisplayValue("claude-sdk")
        expect(
            screen.getByText("Notifications on this device")
        ).toBeInTheDocument()
        expect(screen.getByText(/can't receive push/)).toBeInTheDocument()
        expect(screen.getByText("SOC2 evidence")).toBeInTheDocument()
        expect(
            screen.getByRole("button", { name: "Export evidence" })
        ).toBeInTheDocument()
    })
})
