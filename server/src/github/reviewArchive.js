/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Read-only view of the review orchestrator archive:
// <dir>/<folder>:<branch with "/" -> "__">/<timestamp>.json, each file
// { timestamp, context: { repo, branch, repoRoot }, result: { status } }.
// The folder is the work folder basename "<repo>--<branch>--<slug>".

import nodeFs from "node:fs"
import os from "node:os"
import path from "node:path"
import { folderName } from "../workers/identity.js"

function expandHome(dir) {
    const d = String(dir || "")
    if (d === "~") return os.homedir()
    if (d.startsWith("~/")) return path.join(os.homedir(), d.slice(2))
    return d
}

/** Archive directory name for a work folder + branch. */
export function contextDirName(folder, branch) {
    return `${folder}:${String(branch).split("/").join("__")}`
}

/**
 * Work folder basename used by tree AGENTS.md:
 * <repo>--<branch with "/" -> "-">--<slug>. Same rule as the workers
 * module's identity.folderName.
 */
// Same folder naming as the worker module (one rule for both).
export function workFolder(repo, branch, slug) {
    return folderName({ repo, branch, slug })
}

/**
 * @param {{ dir: string, fs?: typeof nodeFs, dashboardUrl?: string|null }} deps
 */
export function createReviewArchive({
    dir,
    fs = nodeFs,
    dashboardUrl = null,
} = {}) {
    const root = expandHome(dir)

    /**
     * Newest parseable archive entry for the folder/branch, or null.
     * @returns {Promise<{ status, timestamp, file, dashboardUrl } | null>}
     */
    async function latest({ folder, branch }) {
        if (!root || !folder || !branch) return null
        const ctxDir = path.join(root, contextDirName(folder, branch))
        let names
        try {
            names = await fs.promises.readdir(ctxDir)
        } catch {
            return null
        }
        const files = names
            .filter((n) => n.endsWith(".json"))
            .sort()
            .reverse()
        for (const name of files) {
            const file = path.join(ctxDir, name)
            try {
                const data = JSON.parse(
                    await fs.promises.readFile(file, "utf8")
                )
                const status = data && data.result && data.result.status
                if (!status) continue
                return {
                    status: String(status),
                    timestamp: data.timestamp || null,
                    file,
                    dashboardUrl,
                }
            } catch {
                // unreadable or partial file: try the next older one
            }
        }
        return null
    }

    return { latest }
}
