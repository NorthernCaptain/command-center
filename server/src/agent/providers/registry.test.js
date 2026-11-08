/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { createMemorySettingsRepo } from "../testing/fakes.js"
import { createProviderRegistry, DEFAULT_MODELS } from "./registry.js"

const p = (name) => ({ name, run: async () => ({}) })
const providers = [p("claude-sdk"), p("claude-cli"), p("codex")]

describe("provider registry", () => {
    test("defaults without settings", () => {
        const r = createProviderRegistry({ providers })
        expect(r.current().name).toBe("claude-sdk")
        expect(r.fallback()).toBeNull()
        expect(r.autoFallback()).toBe(false)
        expect(r.modelFor("enrich", "light")).toBe("claude-haiku-5-5")
        expect(r.modelFor("asana_create", "heavy")).toBe("claude-sonnet-5-5")
        expect(r.modelFor("enrich", "light", "codex")).toBe("gpt-6-luna")
        expect(r.modelFor("enrich", "heavy", "codex")).toBe("gpt-6.1-sol")
        expect(r.modelFor("enrich")).toBe("claude-haiku-5-5")
        expect(r.get("codex").name).toBe("codex")
        expect(r.get("nope")).toBeNull()
    })

    test("settings switch provider, fallback and models", () => {
        const settings = createMemorySettingsRepo({
            "center.provider": "codex",
        })
        const r = createProviderRegistry({
            providers: Object.fromEntries(providers.map((x) => [x.name, x])),
            settingsRepo: settings,
        })
        expect(r.current().name).toBe("codex")
        expect(r.modelFor("enrich", "light")).toBe("gpt-6-luna")
        // fallback equals current -> null
        settings.set("center.auto_fallback", true)
        expect(r.fallback()).toBeNull()
        settings.set("center.provider", "claude-sdk")
        expect(r.fallback().name).toBe("codex")
        settings.set("center.fallback_provider", "missing")
        expect(r.fallback()).toBeNull()
        settings.set("center.models", {
            "claude-sdk": { light: "custom-light", enrich: "per-job" },
        })
        expect(r.modelFor("enrich", "light")).toBe("per-job")
        expect(r.modelFor("assist", "light")).toBe("custom-light")
        expect(r.modelFor("assist", "heavy")).toBe("claude-sonnet-5-5")
        expect(r.modelFor("x", "light", "unknown")).toBeNull()
        settings.set("center.provider", "unknown")
        expect(r.current().name).toBe("claude-sdk")
        settings.set("center.models", null)
        expect(r.modelFor("x", "light")).toBe(
            DEFAULT_MODELS["claude-sdk"].light
        )
    })

    test("falls back to first provider when default is missing", () => {
        const r = createProviderRegistry({ providers: [p("codex")] })
        expect(r.current().name).toBe("codex")
        expect(r.modelFor("x", "weird")).toBe("gpt-6-luna")
    })

    test("throws without providers", () => {
        expect(() => createProviderRegistry({ providers: [] })).toThrow(
            /no providers/
        )
        expect(() => createProviderRegistry({})).toThrow(/no providers/)
    })
})

test("an explicitly stored null fallback means no fallback", async () => {
    const { createProviderRegistry } = await import("./registry.js")
    const store = new Map([
        ["center.auto_fallback", true],
        ["center.fallback_provider", null],
    ])
    const settingsRepo = {
        get: (k, d) => (store.has(k) ? store.get(k) : d),
    }
    const reg = createProviderRegistry({
        providers: [
            { name: "claude-sdk", run: async () => ({}) },
            { name: "codex", run: async () => ({}) },
        ],
        settingsRepo,
    })
    expect(reg.fallback()).toBeNull()
    store.delete("center.fallback_provider")
    expect(reg.fallback().name).toBe("codex")
})

test("fallback with the real SQLite settings repo: absent vs stored null", async () => {
    const { openDb } = await import("../../store/db.js")
    const { createSettingsRepo } = await import("../../store/settingsRepo.js")
    const db = openDb(":memory:")
    try {
        const settingsRepo = createSettingsRepo(db)
        const reg = createProviderRegistry({
            providers: [
                { name: "claude-sdk", run: async () => ({}) },
                { name: "codex", run: async () => ({}) },
            ],
            settingsRepo,
        })
        expect(reg.fallback()).toBeNull() // auto_fallback off by default
        settingsRepo.set("center.auto_fallback", true)
        // never saved -> default fallback (codex)
        expect(reg.fallback().name).toBe("codex")
        settingsRepo.set("center.fallback_provider", null)
        expect(reg.fallback()).toBeNull()
        settingsRepo.set("center.fallback_provider", "codex")
        expect(reg.fallback().name).toBe("codex")
    } finally {
        db.close()
    }
})
