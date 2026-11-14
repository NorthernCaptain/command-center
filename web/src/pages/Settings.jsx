/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useEffect, useState } from "react"
import PushDevice from "../components/PushDevice.jsx"
import Soc2Export from "../components/Soc2Export.jsx"
import { ConfirmButton } from "../components/ConfirmDialog.jsx"
import { EmptyState, SkeletonRows } from "../components/Skeleton.jsx"
import { useApp } from "../components/AppContext.jsx"
import { useToast } from "../components/Toasts.jsx"
import { api, errorMessage } from "../lib/api.js"
import { PROVIDERS, SETTINGS_DEFAULTS, WORKER_KINDS } from "../lib/constants.js"
import { useEvents } from "../lib/hooks.js"
import { relativeTime } from "../lib/time.js"

export const SETTING_KEYS = [
    "center.provider",
    "center.fallback_provider",
    "center.auto_fallback",
    "center.models",
    "workers.default_kind",
    "workers.auto_clean_on_done",
    "github.poll_minutes",
    "digest.enabled",
    "digest.time",
    "stale.days",
    "push.enabled",
]

const DEFAULTS = SETTINGS_DEFAULTS

const intIn = (v, min, max) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max

/** Client-side checks (same ranges as the server's SETTINGS_SCHEMAS). */
export function settingErrors(form) {
    const errors = {}
    if (!intIn(form["github.poll_minutes"], 5, 1440))
        errors["github.poll_minutes"] = "Whole minutes, 5 to 1440."
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(form["digest.time"] || "")))
        errors["digest.time"] = "Use HH:MM, e.g. 08:30."
    if (!intIn(form["stale.days"], 1, 90))
        errors["stale.days"] = "Whole days, 1 to 90."
    return errors
}

/** Number input value -> number ("" while the field is empty). */
const toNumber = (v) => (v === "" ? "" : Number(v))

/** Read a dotted key from a flat or nested settings object. */
export function readSetting(settings, key) {
    if (!settings) return DEFAULTS[key]
    if (key in settings) return settings[key]
    let cur = settings
    for (const part of key.split(".")) {
        if (cur && typeof cur === "object" && part in cur) cur = cur[part]
        else return DEFAULTS[key]
    }
    return cur
}

/** Server-side model defaults per provider, shown as placeholders. */
export const MODEL_DEFAULTS = {
    "claude-sdk": { light: "claude-haiku-5-5", heavy: "claude-sonnet-5-5" },
    "claude-cli": { light: "claude-haiku-5-5", heavy: "claude-sonnet-5-5" },
    codex: { light: "gpt-6-luna", heavy: "gpt-6.1-sol" },
}

/** Settings -> form values (every provider gets a { light, heavy } pair). */
export function toForm(settings) {
    const form = {}
    for (const k of SETTING_KEYS) form[k] = readSetting(settings, k)
    const models = {}
    for (const p of PROVIDERS) {
        const m = (form["center.models"] || {})[p] || {}
        models[p] = { light: m.light || "", heavy: m.heavy || "" }
    }
    form["center.models"] = models
    return form
}

const field = (pair, k) => (pair && pair[k]) || ""
const samePair = (a, b) =>
    field(a, "light") === field(b, "light") &&
    field(a, "heavy") === field(b, "heavy")

/**
 * Model pair state for a provider: "same" (unchanged), "ready" (changed,
 * both fields set: sendable), "partial" (one field empty) or "cleared"
 * (both emptied; the server keeps the stored pair, so nothing is sent).
 */
export function modelState(origPair, pair) {
    if (samePair(origPair, pair)) return "same"
    const light = field(pair, "light").trim()
    const heavy = field(pair, "heavy").trim()
    if (light && heavy) return "ready"
    return light || heavy ? "partial" : "cleared"
}

/** Only the changed, complete model pairs (the server needs both fields). */
export function modelChanges(original = {}, models = {}) {
    const out = {}
    for (const [p, pair] of Object.entries(models)) {
        if (modelState(original[p], pair) === "ready")
            out[p] = { light: pair.light.trim(), heavy: pair.heavy.trim() }
    }
    return out
}

/**
 * Settings to PATCH: changed keys, with center.models reduced to the changed
 * complete pairs (and dropped when there are none), so provider switches
 * save independently of half-typed model fields.
 */
export function changedSettings(original, form) {
    const out = {}
    for (const k of SETTING_KEYS) {
        if (k === "center.models") {
            const models = modelChanges(original[k], form[k])
            if (Object.keys(models).length) out[k] = models
        } else if (JSON.stringify(original[k]) !== JSON.stringify(form[k])) {
            out[k] = form[k]
        }
    }
    return out
}

/** Any visible difference (incl. unsendable model edits). */
function formDiffers(original, form) {
    return JSON.stringify(original) !== JSON.stringify(form)
}

/** New form after a save: server values, keeping model edits not sent. */
function afterSave(serverForm, oldOriginal, form, sent) {
    const sentModels = sent["center.models"] || {}
    const models = { ...serverForm["center.models"] }
    for (const p of PROVIDERS) {
        const pair = form["center.models"][p]
        if (!sentModels[p] && !samePair(oldOriginal["center.models"][p], pair))
            models[p] = pair
    }
    return { ...serverForm, "center.models": models }
}

/**
 * Rebase an edited form onto new server values (another tab or device saved
 * meanwhile): fields the user has not touched (still equal to the old
 * original) take the new server value; edited fields keep the edit. Model
 * pairs are rebased per provider.
 */
export function rebaseForm(oldOriginal, form, serverForm) {
    const out = { ...serverForm }
    for (const k of SETTING_KEYS) {
        if (k === "center.models") continue
        if (JSON.stringify(form[k]) !== JSON.stringify(oldOriginal[k]))
            out[k] = form[k]
    }
    const models = { ...serverForm["center.models"] }
    for (const p of PROVIDERS) {
        const pair = form["center.models"][p]
        if (!samePair(oldOriginal["center.models"][p], pair)) models[p] = pair
    }
    out["center.models"] = models
    return out
}

const MODEL_HINTS = {
    partial: "Fill in both light and heavy to override.",
    cleared: "Empty fields are not saved; the current override stays.",
}

function CenterSettings() {
    const toast = useToast()
    const { features } = useApp()
    const [original, setOriginal] = useState(null)
    const [form, setForm] = useState(null)
    const [error, setError] = useState(null)
    const [saving, setSaving] = useState(false)
    const [runningDigest, setRunningDigest] = useState(false)

    async function runDigest() {
        setRunningDigest(true)
        try {
            await api.runDigest()
            toast.success("Digest ready: see Home")
        } catch (err) {
            toast.error(err)
        } finally {
            setRunningDigest(false)
        }
    }

    useEffect(() => {
        api.getSettings()
            .then((res) => {
                const f = toForm(res && res.settings)
                setOriginal(f)
                setForm(f)
            })
            .catch(setError)
    }, [])

    useEvents("settings.updated", (evt) => {
        const s = evt.data && evt.data.settings
        if (!s || !original) return
        const f = toForm(s)
        // Untouched fields follow the server, so a later Save does not
        // revert changes made elsewhere; edited fields keep the edit.
        setOriginal(f)
        setForm(rebaseForm(original, form, f))
    })

    if (error) return <p className="error-text">{errorMessage(error)}</p>
    if (!form) return <SkeletonRows count={4} label="Loading settings" />

    const changes = changedSettings(original, form)
    const dirty = Object.keys(changes).length > 0
    const errors = settingErrors(form)
    const blocked = Object.keys(changes).some((k) => errors[k])
    const errorFor = (k) =>
        errors[k] && k in changes ? (
            <p className="field-hint error-text" role="alert">
                {errors[k]}
            </p>
        ) : null
    const differs = formDiffers(original, form)
    const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
    const setModel = (p, w, v) =>
        setForm((f) => ({
            ...f,
            "center.models": {
                ...f["center.models"],
                [p]: { ...f["center.models"][p], [w]: v },
            },
        }))

    async function save(e) {
        e.preventDefault()
        setSaving(true)
        try {
            const res = await api.patchSettings(changes)
            const f = res && res.settings ? toForm(res.settings) : form
            setOriginal(f)
            setForm(afterSave(f, original, form, changes))
            toast.success("Settings saved")
        } catch (err) {
            toast.error(err)
        } finally {
            setSaving(false)
        }
    }

    return (
        <form className="settings-form" onSubmit={save}>
            <div className="field-grid">
                <label className="field">
                    <span>Center provider</span>
                    <select
                        className="input"
                        value={form["center.provider"]}
                        onChange={(e) => set("center.provider", e.target.value)}
                    >
                        {PROVIDERS.map((p) => (
                            <option key={p} value={p}>
                                {p}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field">
                    <span>Fallback provider</span>
                    <select
                        className="input"
                        value={form["center.fallback_provider"] || ""}
                        onChange={(e) =>
                            set(
                                "center.fallback_provider",
                                e.target.value || null
                            )
                        }
                    >
                        <option value="">none</option>
                        {PROVIDERS.map((p) => (
                            <option key={p} value={p}>
                                {p}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field field-check">
                    <input
                        type="checkbox"
                        className="switch"
                        checked={Boolean(form["center.auto_fallback"])}
                        onChange={(e) =>
                            set("center.auto_fallback", e.target.checked)
                        }
                    />
                    <span>Fall back automatically on usage limits</span>
                </label>
                <label className="field">
                    <span>Worker default</span>
                    <select
                        className="input"
                        value={form["workers.default_kind"]}
                        onChange={(e) =>
                            set("workers.default_kind", e.target.value)
                        }
                    >
                        {WORKER_KINDS.map((k) => (
                            <option key={k} value={k}>
                                {k}
                            </option>
                        ))}
                    </select>
                </label>
                {features.workers ? (
                    <label className="field field-check">
                        <input
                            type="checkbox"
                            className="switch"
                            checked={Boolean(
                                form["workers.auto_clean_on_done"]
                            )}
                            onChange={(e) =>
                                set(
                                    "workers.auto_clean_on_done",
                                    e.target.checked
                                )
                            }
                        />
                        <span>
                            When a task is done or cancelled, clean its folders
                            and close the agent (cancelled: uncommitted work is
                            dropped)
                        </span>
                    </label>
                ) : null}
            </div>
            {features.github || features.digest || features.push ? (
                <>
                    <h3 className="panel-sub">Automation</h3>
                    <div className="field-grid">
                        {features.github ? (
                            <label className="field">
                                <span>PR poll (minutes)</span>
                                <input
                                    className="input"
                                    type="number"
                                    inputMode="numeric"
                                    min={5}
                                    max={1440}
                                    aria-label="PR poll (minutes)"
                                    aria-invalid={Boolean(
                                        errors["github.poll_minutes"] &&
                                        "github.poll_minutes" in changes
                                    )}
                                    value={form["github.poll_minutes"]}
                                    onChange={(e) =>
                                        set(
                                            "github.poll_minutes",
                                            toNumber(e.target.value)
                                        )
                                    }
                                />
                                {errorFor("github.poll_minutes")}
                            </label>
                        ) : null}
                        {features.digest ? (
                            <>
                                <label className="field">
                                    <span>Flag stale after (days)</span>
                                    <input
                                        className="input"
                                        type="number"
                                        inputMode="numeric"
                                        min={1}
                                        max={90}
                                        aria-label="Flag stale after (days)"
                                        aria-invalid={Boolean(
                                            errors["stale.days"] &&
                                            "stale.days" in changes
                                        )}
                                        value={form["stale.days"]}
                                        onChange={(e) =>
                                            set(
                                                "stale.days",
                                                toNumber(e.target.value)
                                            )
                                        }
                                    />
                                    {errorFor("stale.days")}
                                </label>
                                <label className="field field-check">
                                    <input
                                        type="checkbox"
                                        className="switch"
                                        checked={Boolean(
                                            form["digest.enabled"]
                                        )}
                                        onChange={(e) =>
                                            set(
                                                "digest.enabled",
                                                e.target.checked
                                            )
                                        }
                                    />
                                    <span>Morning digest</span>
                                </label>
                                <label className="field">
                                    <span>Digest time</span>
                                    <input
                                        className="input"
                                        type="time"
                                        aria-label="Digest time"
                                        aria-invalid={Boolean(
                                            errors["digest.time"] &&
                                            "digest.time" in changes
                                        )}
                                        value={form["digest.time"]}
                                        disabled={!form["digest.enabled"]}
                                        onChange={(e) =>
                                            set("digest.time", e.target.value)
                                        }
                                    />
                                    {errorFor("digest.time")}
                                </label>
                            </>
                        ) : null}
                        {features.push ? (
                            <label className="field field-check">
                                <input
                                    type="checkbox"
                                    className="switch"
                                    checked={Boolean(form["push.enabled"])}
                                    onChange={(e) =>
                                        set("push.enabled", e.target.checked)
                                    }
                                />
                                <span>Push notifications</span>
                            </label>
                        ) : null}
                    </div>
                    {features.digest ? (
                        <div className="row-gap settings-row">
                            <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={runningDigest}
                                onClick={runDigest}
                            >
                                Run digest now
                            </button>
                        </div>
                    ) : null}
                </>
            ) : null}
            <h3 className="panel-sub">Models</h3>
            <div className="models">
                {PROVIDERS.map((p) => {
                    const hint =
                        MODEL_HINTS[
                            modelState(
                                original["center.models"][p],
                                form["center.models"][p]
                            )
                        ]
                    const defaults = MODEL_DEFAULTS[p] || {}
                    return (
                        <fieldset
                            key={p}
                            className={`model-set${p === form["center.provider"] ? " is-current" : ""}`}
                        >
                            <legend>{p}</legend>
                            <label className="field">
                                <span>light</span>
                                <input
                                    className="input"
                                    aria-label={`${p} light model`}
                                    placeholder={defaults.light}
                                    value={form["center.models"][p].light}
                                    onChange={(e) =>
                                        setModel(p, "light", e.target.value)
                                    }
                                />
                            </label>
                            <label className="field">
                                <span>heavy</span>
                                <input
                                    className="input"
                                    aria-label={`${p} heavy model`}
                                    placeholder={defaults.heavy}
                                    value={form["center.models"][p].heavy}
                                    onChange={(e) =>
                                        setModel(p, "heavy", e.target.value)
                                    }
                                />
                            </label>
                            {hint ? (
                                <p className="field-hint" role="note">
                                    {hint}
                                </p>
                            ) : null}
                        </fieldset>
                    )
                })}
            </div>
            <div className="form-actions">
                {dirty ? (
                    <span className="muted">
                        {Object.keys(changes).length} unsaved change(s)
                    </span>
                ) : null}
                <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={!differs}
                    onClick={() => setForm(original)}
                >
                    Reset
                </button>
                <button
                    type="submit"
                    className="btn btn-accent"
                    disabled={!dirty || saving || blocked}
                >
                    {saving ? "Saving…" : "Save"}
                </button>
            </div>
        </form>
    )
}

function PairCode() {
    const toast = useToast()
    const [code, setCode] = useState(null)
    const [now, setNow] = useState(Date.now())

    useEffect(() => {
        if (!code) return
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
    }, [code])

    async function generate() {
        try {
            setCode(await api.pairCode())
            setNow(Date.now())
        } catch (err) {
            toast.error(err)
        }
    }

    const left = code
        ? Math.max(0, Math.round((Date.parse(code.expires_at) - now) / 1000))
        : 0
    if (code && left > 0) {
        return (
            <div className="pair-code" aria-live="polite">
                <span
                    className="pair-digits"
                    aria-label={`Pairing code ${code.code}`}
                >
                    {String(code.code).slice(0, 3)}
                    <span className="pair-gap" /> {String(code.code).slice(3)}
                </span>
                <span className="muted">
                    Enter it on the phone under Settings · expires in{" "}
                    {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
                </span>
            </div>
        )
    }
    return (
        <button type="button" className="btn btn-accent" onClick={generate}>
            {code ? "Code expired, pair again" : "Pair a device"}
        </button>
    )
}

function Devices() {
    const toast = useToast()
    const [devices, setDevices] = useState(null)
    const [error, setError] = useState(null)

    const load = () =>
        api
            .listDevices()
            .then((res) => setDevices((res && res.devices) || []))
            .catch(setError)

    useEffect(() => {
        load()
    }, [])

    async function revoke(d) {
        try {
            await api.revokeDevice(d.id)
            toast.success(`Revoked ${d.name}`)
            load()
        } catch (err) {
            toast.error(err)
        }
    }

    return (
        <div className="devices">
            {error ? (
                <p className="error-text">{errorMessage(error)}</p>
            ) : !devices ? (
                <SkeletonRows count={2} label="Loading devices" />
            ) : devices.length ? (
                <ul className="device-list">
                    {devices.map((d) => (
                        <li
                            key={d.id}
                            className={`device${d.revoked_at ? " is-revoked" : ""}`}
                        >
                            <div className="device-main">
                                <span className="device-name">{d.name}</span>
                                <span className="muted">
                                    paired {relativeTime(d.created_at)}
                                    {d.last_seen_at
                                        ? ` · seen ${relativeTime(d.last_seen_at)}`
                                        : ""}
                                </span>
                            </div>
                            {d.revoked_at ? (
                                <span className="tag">revoked</span>
                            ) : (
                                <ConfirmButton
                                    label="Revoke"
                                    title={`Revoke ${d.name || "this device"}?`}
                                    confirmLabel="Revoke"
                                    danger
                                    onConfirm={() => revoke(d)}
                                >
                                    <p>
                                        Its pairing is removed: its push
                                        notifications stop and its open live
                                        updates end. Pair it again with a new
                                        code to get them back.
                                    </p>
                                </ConfirmButton>
                            )}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="muted">No paired devices.</p>
            )}
            <PairCode />
        </div>
    )
}

function PairThisDevice() {
    const toast = useToast()
    const { refreshMe } = useApp()
    const [code, setCode] = useState("")
    const [name, setName] = useState(() =>
        /iPhone|iPad|Android/.test(navigator.userAgent) ? "Phone" : "Browser"
    )
    const [busy, setBusy] = useState(false)

    async function submit(e) {
        e.preventDefault()
        setBusy(true)
        try {
            await api.pair({
                code: code.replace(/\s+/g, ""),
                name: name.trim() || "Device",
            })
            toast.success("Device paired. You're the owner here now.")
            await refreshMe()
        } catch (err) {
            toast.error(err)
        } finally {
            setBusy(false)
        }
    }

    return (
        <form className="pair-form" onSubmit={submit}>
            <p className="muted">
                Owner only: run <code>cc pair</code> on the Mac (or Settings →
                Devices on a signed-in browser) and enter the 6-digit code.
            </p>
            <label className="field">
                <span>Code</span>
                <input
                    className="input input-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={7}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    aria-label="Pairing code"
                />
            </label>
            <label className="field">
                <span>Device name</span>
                <input
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-label="Device name"
                />
            </label>
            <button
                type="submit"
                className="btn btn-accent"
                disabled={busy || code.replace(/\s+/g, "").length < 6}
            >
                Pair this device
            </button>
        </form>
    )
}

export default function Settings() {
    const { me, isOwner, features } = useApp()
    if (!isOwner) {
        return (
            <div className="page settings">
                <h1 className="page-title">Settings</h1>
                {me && me.mode === "tailnet" ? (
                    <section className="card">
                        <h2 className="card-title">Pair this device</h2>
                        <PairThisDevice />
                    </section>
                ) : (
                    <EmptyState title="Read-only access" glyph="◌">
                        Settings are available to the owner only.
                    </EmptyState>
                )}
            </div>
        )
    }
    return (
        <div className="page settings">
            <h1 className="page-title">Settings</h1>
            <section className="card">
                <h2 className="card-title">Center agent</h2>
                <CenterSettings />
            </section>
            {features.push ? (
                <section className="card">
                    <h2 className="card-title">Notifications on this device</h2>
                    <PushDevice />
                </section>
            ) : null}
            <section className="card">
                <h2 className="card-title">Devices</h2>
                <Devices />
            </section>
            {features.soc2 ? (
                <section className="card">
                    <h2 className="card-title">SOC2 evidence</h2>
                    <Soc2Export />
                </section>
            ) : null}
        </div>
    )
}
