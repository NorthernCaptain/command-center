/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Provider registry backed by settingsRepo (runtime switchable). Settings are
// read on every call so a switch takes effect for the next job.

export const DEFAULT_MODELS = {
    "claude-sdk": { light: "claude-haiku-5-5", heavy: "claude-sonnet-5-5" },
    "claude-cli": { light: "claude-haiku-5-5", heavy: "claude-sonnet-5-5" },
    codex: { light: "gpt-6-luna", heavy: "gpt-6.1-sol" },
}

export const DEFAULT_SETTINGS = {
    "center.provider": "claude-sdk",
    "center.fallback_provider": "codex",
    "center.auto_fallback": false,
    "center.models": DEFAULT_MODELS,
    "workers.default_kind": "claude",
}

/**
 * @param {{ providers: Object<string, {name, run}>|Array<{name, run}>,
 *           settingsRepo?: { get(key, def) } }} opts
 */
/** Default passed to settingsRepo.get to tell "not stored" from null. */
const ABSENT = Symbol("absent")

export function createProviderRegistry({ providers, settingsRepo }) {
    const byName = Array.isArray(providers)
        ? Object.fromEntries(providers.map((p) => [p.name, p]))
        : { ...(providers || {}) }
    if (!Object.keys(byName).length) throw new Error("no providers")

    const setting = (key) => {
        const def = DEFAULT_SETTINGS[key]
        if (!settingsRepo) return def
        const v = settingsRepo.get(key, def)
        return v === undefined || v === null ? def : v
    }

    function get(name) {
        return byName[name] || null
    }

    function current() {
        return (
            get(setting("center.provider")) ||
            get(DEFAULT_SETTINGS["center.provider"]) ||
            Object.values(byName)[0]
        )
    }

    function autoFallback() {
        return setting("center.auto_fallback") === true
    }

    /** Fallback provider, or null when auto_fallback is off / not usable. */
    function fallback() {
        if (!autoFallback()) return null
        // An explicitly stored null means "no fallback" (Settings: none).
        // A missing row returns the ABSENT sentinel and uses the default.
        if (
            settingsRepo &&
            settingsRepo.get("center.fallback_provider", ABSENT) === null
        )
            return null
        const p = get(setting("center.fallback_provider"))
        if (!p || p === current()) return null
        return p
    }

    /**
     * Model for a job. Settings may override per job type:
     * center.models[provider][jobType] beats center.models[provider][weight].
     * providerName defaults to the current provider.
     */
    function modelFor(jobType, weight = "light", providerName) {
        const name = providerName || current().name
        const models = setting("center.models") || {}
        const m = models[name] || {}
        const d = DEFAULT_MODELS[name] || {}
        return (
            (typeof m[jobType] === "string" && m[jobType]) ||
            m[weight] ||
            d[weight] ||
            d.light ||
            null
        )
    }

    return { current, fallback, autoFallback, modelFor, get }
}
