/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Worker identity: slug, branch and herdr agent name for a task, plus the
// uniqueness checks and the tree-folder scan. See docs/03-architecture.md
// "Branch and PR identity" and docs/implementation/phase2-contracts.md (B).

import { execFile } from "node:child_process"
import crypto from "node:crypto"
import nodeFs from "node:fs"
import path from "node:path"
import { AppError } from "../util/errors.js"

const STOP_WORDS = new Set([
    "a",
    "an",
    "the",
    "to",
    "of",
    "for",
    "in",
    "on",
    "at",
    "and",
    "or",
    "with",
    "is",
    "be",
    "by",
    "from",
    "into",
    "it",
    "this",
    "that",
])
const SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"
const MAX_SLUG_TRIES = 50
const AGENT_NAME_MAX = 32
const SLUG_RE = /^[a-z0-9]{1,16}$/
const PAGE = 1000
const NOTE_FILE = path.join(".git", "agent-task.md")

/** Kebab summary of a title: [a-z0-9-], at most maxWords words, ≤ 40 chars. */
export function slugify(title, maxWords = 4) {
    const words = String(title || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    const meaningful = words.filter((w) => !STOP_WORDS.has(w))
    const picked = (meaningful.length ? meaningful : words).slice(
        0,
        Math.max(1, maxWords)
    )
    let out = ""
    for (const w of picked) {
        const next = out ? `${out}-${w}` : w
        if (next.length > 40) break
        out = next
    }
    if (!out && picked.length) out = picked[0].slice(0, 40)
    return out || "task"
}

/** "t123-fix-upload-retry" */
export function defaultBranch(task) {
    return `t${task.id}-${slugify(task.title)}`
}

/** herdr agent name: [a-z][a-z0-9_-]{0,31}, "t<id>-<slug>" truncated. */
export function agentName(task) {
    return truncateName(`t${task.id}-${slugify(task.title)}`)
}

/** Cut a name to the herdr limit without a trailing "-". */
export function truncateName(name, max = AGENT_NAME_MAX) {
    return String(name).slice(0, max).replace(/-+$/, "")
}

/** Folder name in the tree: "<repo>--<branch with / → ->--<slug>". */
export function folderName({ repo, branch, slug }) {
    return `${repo}--${String(branch).replace(/\//g, "-")}--${slug}`
}

/** A git branch name we are willing to pass to git and herdr. */
export function isValidBranch(branch) {
    const b = String(branch || "")
    return (
        b.length > 0 &&
        b.length <= 200 &&
        /^[A-Za-z0-9._/-]+$/.test(b) &&
        !b.startsWith("-") &&
        !b.startsWith("/") &&
        !b.endsWith("/") &&
        !b.endsWith(".") &&
        !b.endsWith(".lock") &&
        !b.includes("..") &&
        !b.includes("//")
    )
}

/**
 * Parse `.git/agent-task.md` (tree AGENTS.md "Record the task"): `key: value`
 * lines. `folders:` lists "<folder> (<role>)" entries separated by commas or
 * continuation lines. Unknown keys are kept; nothing here throws.
 */
export function parseTaskNote(text) {
    const out = { folders: [] }
    let lastKey = null
    for (const raw of String(text || "").split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, "")
        if (!line.trim()) continue
        const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
        if (m && !/^\s/.test(line)) {
            lastKey = m[1].toLowerCase()
            if (lastKey === "folders") out.folders.push(...parseFolders(m[2]))
            else out[lastKey] = m[2].trim()
            continue
        }
        // continuation line (indented or a bullet), only meaningful for folders
        if (lastKey === "folders")
            out.folders.push(...parseFolders(line.replace(/^\s*[-*]\s*/, "")))
    }
    const st = /^(\S+)(?:\s+(\S+))?/.exec(out.status || "")
    if (st) {
        out.status = st[1]
        if (st[2] && /^https?:\/\//.test(st[2])) out.pr = st[2]
    }
    return out
}

function parseFolders(value) {
    const out = []
    for (const part of String(value || "").split(",")) {
        const m = /^\s*([^\s()]+)\s*(?:\(([^)]*)\))?/.exec(part)
        if (!m) continue
        const role = (m[2] || "").trim().toLowerCase()
        out.push({ folder: m[1], role: role || null })
    }
    return out
}

function defaultExec(file, args) {
    return new Promise((resolve, reject) => {
        execFile(
            file,
            args,
            { timeout: 20000, maxBuffer: 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) reject(err)
                else resolve({ stdout, stderr })
            }
        )
    })
}

function defaultRandom(n) {
    return crypto.randomInt(n)
}

/**
 * @param {object} deps
 * @param {object} deps.store      query() over every task
 * @param {string} deps.treeDir    config.treeDir (where agents check out repos)
 * @param {object} [deps.fs]       node:fs (sync API)
 * @param {Function} [deps.exec]   (file, args) -> Promise<{ stdout }>
 * @param {Function} [deps.random] (n) -> integer in [0, n)
 * @param {string} [deps.org]
 */
export function createIdentity({
    store,
    treeDir,
    fs = nodeFs,
    exec = defaultExec,
    random = defaultRandom,
    org = null,
}) {
    /** treeDir entries; [] when unreadable, unless strict (then throws). */
    function treeEntries(strict = false) {
        try {
            return fs.readdirSync(treeDir, { withFileTypes: true })
        } catch (err) {
            if (strict) throw err
            return []
        }
    }

    /** Every task: store.query pages (limit ≤ 1000) until total is reached. */
    async function allTasks() {
        const out = []
        for (let offset = 0; ;) {
            const r = (await store.query({ limit: PAGE, offset })) || {}
            const page = r.tasks || []
            out.push(...page)
            offset += page.length
            if (!page.length || offset >= (r.total ?? 0)) return out
        }
    }

    async function newSlug() {
        const names = treeEntries().map((e) => e.name)
        const taken = new Set(
            (await allTasks()).map((t) => t.slug).filter(Boolean)
        )
        for (let i = 0; i < MAX_SLUG_TRIES; i++) {
            let slug = ""
            for (let j = 0; j < 4; j++) slug += SLUG_CHARS[random(36)]
            if (taken.has(slug)) continue
            if (names.some((n) => n.endsWith(`--${slug}`))) continue
            return slug
        }
        throw new AppError("slug_exhausted", "could not find a free slug", {
            status: 500,
        })
    }

    /** Branches other tasks hold in `repo` (task.branch for its repos + deliverables). */
    function branchesInRepo(tasks, repo, taskId) {
        const used = new Map()
        for (const t of tasks) {
            if (Number(t.id) === Number(taskId)) continue
            const repos = (t.repos || []).map((r) => r.name)
            if (t.branch && (repos.includes(repo) || !repos.length))
                used.set(t.branch, t.id)
            for (const d of t.deliverables || [])
                if (d.repo === repo && d.branch) used.set(d.branch, t.id)
            // branch reservations made with cc_add_link(type: "branch") for a
            // repo that has no deliverable yet (label = repo, url = branch)
            for (const l of t.links || [])
                if (l.type === "branch" && l.label === repo && l.url)
                    used.set(l.url, t.id)
        }
        return used
    }

    function suggestFor(branch, taskId, used) {
        let base = branch
        const tag = `t${taskId}`
        if (!new RegExp(`(^|[/-])${tag}(-|$)`).test(base)) {
            const cut = base.lastIndexOf("/")
            base =
                cut >= 0
                    ? `${base.slice(0, cut + 1)}${tag}-${base.slice(cut + 1)}`
                    : `${tag}-${base}`
        }
        if (!used.has(base) && base !== branch) return base
        for (let n = 2; n < 100; n++) {
            const s = `${base}-${n}`
            if (!used.has(s)) return s
        }
        return `${base}-${Date.now().toString(36)}`
    }

    /**
     * Branch must be unique per repo across all other tasks and absent on the
     * remote. A remote-check failure (offline) is a warning, not a conflict.
     * The task's own recorded deliverable branch skips the remote check (its
     * agent may already have pushed it).
     */
    async function checkBranch(repo, branch, taskId) {
        if (!isValidBranch(branch))
            return {
                ok: false,
                reason: `invalid branch name: ${branch}`,
                suggestion: null,
            }
        const tasks = await allTasks()
        const used = branchesInRepo(tasks, repo, taskId)
        if (used.has(branch))
            return {
                ok: false,
                reason: `branch ${branch} is already used in ${repo} by T-${used.get(branch)}`,
                suggestion: suggestFor(branch, taskId, used),
            }
        const self = tasks.find((t) => Number(t.id) === Number(taskId))
        const owned =
            self &&
            (self.deliverables || []).some(
                (d) => d.repo === repo && d.branch === branch
            )
        if (owned) return { ok: true }
        if (!org)
            return {
                ok: true,
                warning: "remote check skipped: github.org is not configured",
            }
        let stdout
        try {
            const r = await exec("git", [
                "ls-remote",
                "--heads",
                `git@github.com:${org}/${repo}.git`,
                branch,
            ])
            stdout = r && r.stdout
        } catch (err) {
            return {
                ok: true,
                warning: `remote check failed: ${(err && err.message) || err}`,
            }
        }
        const exists = String(stdout || "")
            .split(/\r?\n/)
            .some((l) => l.trim().endsWith(`refs/heads/${branch}`))
        if (exists) {
            used.set(branch, null)
            return {
                ok: false,
                reason: `branch ${branch} already exists on ${org}/${repo}`,
                suggestion: suggestFor(branch, taskId, used),
            }
        }
        return { ok: true }
    }

    function readNote(dir) {
        try {
            return parseTaskNote(
                fs.readFileSync(path.join(treeDir, dir, NOTE_FILE), "utf8")
            )
        } catch {
            return null
        }
    }

    /**
     * treeDir/*--<slug> folders with whatever their task notes say. strict:
     * an unreadable tree throws instead of looking empty (callers that act
     * on "no folders left").
     */
    function scanFolders(slug, { strict = false } = {}) {
        if (!SLUG_RE.test(String(slug || ""))) return []
        const dirs = treeEntries(strict)
            .filter((e) => e.isDirectory() && e.name.endsWith(`--${slug}`))
            .map((e) => e.name)
            .sort()
        const notes = new Map()
        for (const d of dirs) {
            const note = readNote(d)
            if (note) notes.set(d, note)
        }
        const roles = new Map()
        for (const note of notes.values())
            for (const f of note.folders)
                if (f.role && !roles.has(f.folder)) roles.set(f.folder, f.role)
        return dirs.map((folder) => {
            const parts = folder.split("--")
            const note = notes.get(folder)
            const entry = {
                folder,
                repo: (note && note.repo) || parts[0],
                branch:
                    (note && note.branch) ||
                    (parts.length > 2 ? parts.slice(1, -1).join("--") : null),
            }
            const role = roles.get(folder)
            if (role) entry.role = role
            if (note && note.status) entry.status = note.status
            if (note && note.pr) entry.pr = note.pr
            return entry
        })
    }

    return { newSlug, checkBranch, scanFolders }
}
