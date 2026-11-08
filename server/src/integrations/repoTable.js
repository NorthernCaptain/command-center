/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Known repos, parsed from the "## 0. Main repos" table in the tree
// AGENTS.md. Columns: Repo (`<org>/…`) | Default | Lang | What it is.

import fs from "node:fs"

export const REPO_TABLE_HEADING = "## 0. Main repos"

/** Strip markdown backticks and bold/italic markers from a table cell. */
export function cleanCell(cell) {
    return String(cell ?? "")
        .replace(/`/g, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/__(.+?)__/g, "$1")
        .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1$2")
        .trim()
}

function splitRow(line) {
    let s = line.trim()
    if (s.startsWith("|")) s = s.slice(1)
    if (s.endsWith("|")) s = s.slice(0, -1)
    return s.split("|").map((c) => c.trim())
}

function isSeparator(cells) {
    return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))
}

/**
 * Parse the repo table from AGENTS.md content.
 * @returns {{ name, default_branch, lang, description }[]}
 */
export function parseRepoTable(markdown) {
    const lines = String(markdown ?? "").split(/\r?\n/)
    const start = lines.findIndex((l) => l.trim() === REPO_TABLE_HEADING)
    if (start < 0) return []
    const repos = []
    let inTable = false
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i].trim()
        if (/^#{1,2}\s/.test(line)) break // next section
        if (!line.startsWith("|")) {
            if (inTable) break
            continue
        }
        const cells = splitRow(line)
        if (!inTable) {
            inTable = true // header row
            continue
        }
        if (isSeparator(cells)) continue
        const [repo, def, lang, ...rest] = cells.map(cleanCell)
        const name = (repo || "").replace(/^[^/\s]+\//, "")
        if (!name) continue
        repos.push({
            name,
            default_branch: def || null,
            lang: lang || null,
            description: rest.join(" | ") || "",
        })
    }
    return repos
}

/**
 * @param {{ readFile?: Function, agentsMdPath: string, log?: object }} deps
 */
export function createRepoTable({
    readFile = (p) => fs.readFileSync(p, "utf8"),
    agentsMdPath,
    log,
} = {}) {
    let cache = null
    return {
        /**
         * Synchronous (cached), so both `list()` and `await list()` work.
         * @returns {{ name, default_branch, lang, description }[]}
         */
        list() {
            if (cache) return cache
            let content
            try {
                content = readFile(agentsMdPath, "utf8")
            } catch (err) {
                if (err?.code !== "ENOENT") {
                    log?.warn?.({ err: err?.message }, "repo table unreadable")
                }
                return []
            }
            cache = parseRepoTable(content)
            return cache
        },
        /** Drop the cache (e.g. after AGENTS.md changed). */
        reset() {
            cache = null
        },
    }
}
