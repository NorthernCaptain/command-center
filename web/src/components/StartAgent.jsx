/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useEffect, useState } from "react"
import { api as defaultApi } from "../lib/api.js"
import { SETTINGS_DEFAULTS, WORKER_KINDS } from "../lib/constants.js"
import { useKnownRepos } from "./RepoPicker.jsx"

export const WORKER_KIND_LABELS = { claude: "Claude", codex: "Codex" }

/** workers.default_kind from a flat or nested settings object. */
export function defaultKindOf(settings) {
    if (!settings) return null
    if (settings["workers.default_kind"])
        return settings["workers.default_kind"]
    return (settings.workers && settings.workers.default_kind) || null
}

/**
 * Start button with a Claude/Codex select. The kind defaults to the task's
 * worker_kind, else the workers.default_kind setting, else its default.
 * A task without repos asks for one (it becomes the main repo):
 * onStart(kind, repo | null) -> Promise.
 */
export default function StartAgent({ task, onStart, api = defaultApi }) {
    const [picked, setPicked] = useState(null)
    const [fallback, setFallback] = useState(null)
    const [busy, setBusy] = useState(false)
    const [repo, setRepo] = useState("")
    const fromTask = task.worker_kind || null
    const needsRepo = !(task.repos && task.repos.length)
    const known = useKnownRepos(api, needsRepo)

    useEffect(() => {
        if (fromTask) return
        let alive = true
        api.getSettings()
            .then((res) => {
                const k = defaultKindOf(res && res.settings)
                if (alive && WORKER_KINDS.includes(k)) setFallback(k)
            })
            .catch(() => {}) // keep the built-in default
        return () => {
            alive = false
        }
    }, [api, fromTask])

    const kind =
        picked ||
        fromTask ||
        fallback ||
        SETTINGS_DEFAULTS["workers.default_kind"]

    async function start() {
        setBusy(true)
        try {
            await onStart(kind, needsRepo ? repo : null)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="start-agent" role="group" aria-label="Start agent">
            {needsRepo ? (
                <select
                    className="select-pill"
                    aria-label="Repo for the agent"
                    value={repo}
                    disabled={busy || known === null}
                    onChange={(e) => setRepo(e.target.value)}
                >
                    <option value="">
                        {known === null ? "loading repos…" : "pick a repo"}
                    </option>
                    {(known || []).map((r) => (
                        <option key={r.name} value={r.name}>
                            {r.name}
                        </option>
                    ))}
                </select>
            ) : null}
            <select
                className="select-pill"
                aria-label="Agent kind"
                value={kind}
                disabled={busy}
                onChange={(e) => setPicked(e.target.value)}
            >
                {WORKER_KINDS.map((k) => (
                    <option key={k} value={k}>
                        {WORKER_KIND_LABELS[k] || k}
                    </option>
                ))}
            </select>
            <button
                type="button"
                className="btn btn-accent btn-sm"
                aria-label={`Start with ${WORKER_KIND_LABELS[kind] || kind}`}
                title={needsRepo && !repo ? "Pick a repo first" : undefined}
                disabled={busy || (needsRepo && !repo)}
                onClick={start}
            >
                <span aria-hidden="true">▶</span> Start
            </button>
        </div>
    )
}
