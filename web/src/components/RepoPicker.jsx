/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useEffect, useState } from "react"
import { api as defaultApi } from "../lib/api.js"

export const REPO_ROLES = ["main", "work", "ref"]
export const REPO_ROLE_HINT = {
    main: "the repo the agent works in",
    work: "also changed",
    ref: "reference only",
}

/** Add `name`: "main" when there is no main yet, else "work". */
export function addRepo(repos, name) {
    const list = repos || []
    if (!name || list.some((r) => r.name === name)) return list
    const role = list.some((r) => r.role === "main") ? "work" : "main"
    return [...list, { name, role }]
}

/** Set a repo's role; a new main demotes the previous main to "work". */
export function setRepoRole(repos, name, role) {
    return (repos || []).map((r) => {
        if (r.name === name) return { ...r, role }
        if (role === "main" && r.role === "main") return { ...r, role: "work" }
        return r
    })
}

/**
 * Remove a repo. Removing the main promotes the next repo to main, so the
 * agent still has a repo to work in.
 */
export function removeRepo(repos, name) {
    const gone = (repos || []).find((r) => r.name === name)
    const rest = (repos || []).filter((r) => r.name !== name)
    if (gone && gone.role === "main" && rest.length)
        return [{ ...rest[0], role: "main" }, ...rest.slice(1)]
    return rest
}

/** Known repos for the picker: GET /api/repos once per mount. */
export function useKnownRepos(api, enabled) {
    const [known, setKnown] = useState(null)
    useEffect(() => {
        if (!enabled) return
        let alive = true
        api.listRepos()
            .then((res) => {
                if (alive) setKnown((res && res.repos) || [])
            })
            .catch(() => {
                if (alive) setKnown([])
            })
        return () => {
            alive = false
        }
    }, [api, enabled])
    return known
}

/**
 * The task's repos. Owner: role select, remove and "+ repo" add (choices
 * from GET /api/repos); onChange(repos) -> Promise. Viewer: read-only.
 */
export default function RepoPicker({
    repos = [],
    isOwner,
    onChange,
    api = defaultApi,
}) {
    const known = useKnownRepos(api, isOwner)
    const [busy, setBusy] = useState(false)
    const list = repos || []

    async function save(next) {
        setBusy(true)
        try {
            await onChange(next)
        } finally {
            setBusy(false)
        }
    }

    if (!isOwner)
        return list.length ? (
            <span className="repo-chips">
                {list.map((r) => (
                    <span key={r.name} className="repo-chip">
                        <code>{r.name}</code>
                        <span className="repo-role">{r.role}</span>
                    </span>
                ))}
            </span>
        ) : (
            <span className="muted">none</span>
        )

    const assigned = new Set(list.map((r) => r.name))
    const choices = (known || []).filter((r) => !assigned.has(r.name))

    return (
        <span className="repo-chips" role="group" aria-label="Repos">
            {list.length ? null : <span className="repo-none">none</span>}
            {list.map((r) => (
                <span key={r.name} className={`repo-chip repo-${r.role}`}>
                    <code>{r.name}</code>
                    <select
                        className="repo-role-select"
                        aria-label={`Role of ${r.name}`}
                        title={REPO_ROLE_HINT[r.role]}
                        value={r.role}
                        disabled={busy}
                        onChange={(e) =>
                            save(setRepoRole(list, r.name, e.target.value))
                        }
                    >
                        {REPO_ROLES.map((role) => (
                            <option key={role} value={role}>
                                {role}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        className="repo-remove"
                        aria-label={`Remove ${r.name}`}
                        disabled={busy}
                        onClick={() => save(removeRepo(list, r.name))}
                    >
                        ×
                    </button>
                </span>
            ))}
            <select
                className="select-pill repo-add"
                aria-label="Add repo"
                value=""
                disabled={busy || known === null || !choices.length}
                onChange={(e) => save(addRepo(list, e.target.value))}
            >
                <option value="">
                    {known === null ? "loading…" : "+ repo"}
                </option>
                {choices.map((r) => (
                    <option
                        key={r.name}
                        value={r.name}
                        title={r.description || ""}
                    >
                        {r.name}
                    </option>
                ))}
            </select>
        </span>
    )
}
