/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Debounced per-task git commits in the tasks/ worktree. Commits only on the
// configured branch, only paths under the task folder, never pushes.

import fs from "node:fs"
import path from "node:path"
import { taskDirName } from "../contracts/schemas.js"
import { AppError, NotFoundError, ValidationError } from "../util/errors.js"
import { systemClock } from "../util/clock.js"
import { nullLogger } from "../util/logger.js"
import { CORRUPT_SUFFIX, TEMP_SUFFIX } from "./fsutil.js"

const TASK_DIR_RE = /^T-\d+$/
const SHA_RE = /^[0-9a-f]{4,40}$/i
const REC = "\x1e"
const FLD = "\x1f"

/** Commit message: "T-0123: a; b" + blank line + one Actor trailer each. */
export function buildCommitMessage(dir, summaries, actors) {
    const subject = `${dir}: ${summaries.length ? summaries.join("; ") : "updated"}`
    const trailers = [...actors].map((a) => `Actor: ${a}`).join("\n")
    return trailers ? `${subject}\n\n${trailers}` : subject
}

/** Pathspec for one task folder, excluding temp files and corrupt sidecars. */
function pathspec(dir) {
    return [
        dir,
        `:(exclude,glob)${dir}/**/*${TEMP_SUFFIX}`,
        `:(exclude,glob)${dir}/**/*${CORRUPT_SUFFIX}`,
    ]
}

const ignored = (file) =>
    file.endsWith(TEMP_SUFFIX) || file.endsWith(CORRUPT_SUFFIX)

export function createGitCommitter({
    tasksDir,
    exec,
    clock = systemClock,
    debounceMs = 15000,
    maxWaitMs = debounceMs * 4,
    author = { name: "Command Center", email: "command-center@localhost" },
    branch = "tasks",
    // the code checkout (config.repoRoot): the task repo must not share its
    // git storage (itself or a worktree of it), so task content can't land
    // in the code repo
    codeRepoDir = null,
    log = nullLogger,
}) {
    const pending = new Map() // dir -> { summaries, actors, timer, firstAt }
    let chain = Promise.resolve()
    let verifiedTop = false

    const git = async (args) =>
        (await exec("git", args, { cwd: tasksDir })).stdout

    async function currentBranch() {
        try {
            return (await git(["symbolic-ref", "--short", "HEAD"])).trim()
        } catch {
            return null // detached HEAD
        }
    }

    /** Canonical git common dir of a work tree (null: not a git work tree). */
    async function commonDir(cwd) {
        try {
            const out = (
                await exec("git", ["rev-parse", "--git-common-dir"], { cwd })
            ).stdout.trim()
            return fs.realpathSync(path.resolve(cwd, out))
        } catch {
            return null
        }
    }

    async function ensureRepo() {
        if (!verifiedTop) {
            let top
            try {
                top = (await git(["rev-parse", "--show-toplevel"])).trim()
            } catch (err) {
                throw new AppError(
                    "git_not_ready",
                    `${tasksDir} is not a git work tree: ${err.message}`,
                    { status: 500 }
                )
            }
            if (fs.realpathSync(top) !== fs.realpathSync(tasksDir)) {
                throw new AppError(
                    "git_not_ready",
                    `${tasksDir} is not the root of its own work tree (${top})`,
                    { status: 500 }
                )
            }
            if (codeRepoDir) {
                const code = await commonDir(codeRepoDir)
                if (code && code === (await commonDir(tasksDir)))
                    throw new AppError(
                        "git_not_separate",
                        `refusing to commit: ${tasksDir} uses the code repo's git storage (${code}); task data needs its own repo (install/setup-tasks-repo.sh)`,
                        { status: 500 }
                    )
            }
            verifiedTop = true
        }
        const cur = await currentBranch()
        if (cur !== branch) {
            throw new AppError(
                "git_wrong_branch",
                `refusing to commit: ${tasksDir} is on "${cur}", not "${branch}"`,
                { status: 500 }
            )
        }
        return { branch: cur }
    }

    async function commitDir(dir, summaries, actors) {
        await git(["add", "-A", "--", ...pathspec(dir)])
        const staged = (
            await git(["diff", "--cached", "--name-only", "--", dir])
        ).trim()
        if (!staged) return false
        await git([
            "-c",
            `user.name=${author.name}`,
            "-c",
            `user.email=${author.email}`,
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--no-verify",
            "--quiet",
            "-m",
            buildCommitMessage(dir, summaries, actors),
            // Partial commit: only this task folder, never whatever else
            // happens to be staged in the index (other tasks, leftovers).
            "--only",
            "--",
            ...pathspec(dir),
        ])
        return true
    }

    function enqueue(fn) {
        const run = chain.then(fn)
        chain = run.catch(() => {})
        return run
    }

    // The pending entry is taken when the commit actually starts (not when
    // it is queued), so writes that land while an earlier commit runs keep
    // their summaries and actors for the commit that will contain them.
    function commitPending(dir) {
        return enqueue(async () => {
            if (!pending.has(dir)) return false
            try {
                await ensureRepo()
            } catch (err) {
                log.error({ err, dir }, "task commit refused")
                return false
            }
            const entry = pending.get(dir)
            pending.delete(dir)
            if (entry.timer) clock.clearTimeout(entry.timer)
            try {
                return await commitDir(dir, entry.summaries, entry.actors)
            } catch (err) {
                log.error({ err, dir }, "task commit failed")
                // Keep the work for the next touch / flush / recovery.
                const again = pending.get(dir)
                if (again) {
                    again.summaries.unshift(...entry.summaries)
                    entry.actors.forEach((a) => again.actors.add(a))
                } else {
                    pending.set(dir, { ...entry, timer: null })
                }
                return false
            }
        })
    }

    return {
        ensureRepo,

        /** Schedule a debounced commit for the task. */
        touch(id, actor, summary) {
            const dir = taskDirName(id)
            const nowMs = clock.now().getTime()
            let entry = pending.get(dir)
            if (!entry) {
                entry = {
                    summaries: [],
                    actors: new Set(),
                    timer: null,
                    firstAt: nowMs,
                }
                pending.set(dir, entry)
            }
            if (summary && !entry.summaries.includes(summary))
                entry.summaries.push(summary)
            if (actor) entry.actors.add(actor)
            if (entry.timer) clock.clearTimeout(entry.timer)
            const delay = Math.max(
                0,
                Math.min(debounceMs, entry.firstAt + maxWaitMs - nowMs)
            )
            entry.timer = clock.setTimeout(() => commitPending(dir), delay)
        },

        /** Commit everything pending now. */
        async flush() {
            const dirs = [...pending.keys()]
            await Promise.all(dirs.map((d) => commitPending(d)))
            await chain
        },

        pendingCount: () => pending.size,

        /** Commit leftovers (e.g. after a crash) with Actor: recovery. */
        async recoverUncommitted() {
            return enqueue(async () => {
                await ensureRepo()
                const out = await git([
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "--untracked-files=all",
                ])
                const dirs = new Set()
                const tokens = out.split("\0")
                for (let i = 0; i < tokens.length; i++) {
                    const t = tokens[i]
                    if (t.length < 4) continue
                    const xy = t.slice(0, 2)
                    const file = t.slice(3)
                    if (xy.includes("R") || xy.includes("C")) i++
                    const top = file.split("/")[0]
                    if (!TASK_DIR_RE.test(top)) continue
                    if (ignored(file)) continue
                    dirs.add(top)
                }
                let committed = false
                for (const dir of [...dirs].sort()) {
                    const ok = await commitDir(
                        dir,
                        ["recovery commit"],
                        new Set(["recovery"])
                    )
                    committed = committed || ok
                }
                return committed
            })
        },

        /** [{ sha, at, actor, actors, message }] newest first. */
        async log(id, limit = 50) {
            const dir = taskDirName(id)
            let out
            try {
                out = await git([
                    "log",
                    `-n${Math.max(1, Number(limit) || 50)}`,
                    `--format=%H${FLD}%cI${FLD}%B${REC}`,
                    "--",
                    dir,
                ])
            } catch (err) {
                // Unborn branch: no commits yet.
                log.debug({ err }, "git log failed")
                return []
            }
            return out
                .split(REC)
                .map((r) => r.replace(/^\n/, ""))
                .filter((r) => r.trim())
                .map((r) => {
                    const [sha, at, body] = r.split(FLD)
                    const lines = body.trim().split("\n")
                    const actors = lines
                        .map((l) => /^Actor: (.+)$/.exec(l))
                        .filter(Boolean)
                        .map((m) => m[1].trim())
                    return {
                        sha,
                        at,
                        actor: actors.join(", ") || null,
                        actors,
                        message: lines[0],
                    }
                })
        },

        /** Patch of one commit limited to the task folder. */
        async diff(id, sha) {
            if (!SHA_RE.test(String(sha)))
                throw new ValidationError("invalid commit sha")
            try {
                return await git([
                    "show",
                    "--no-color",
                    "--pretty=format:",
                    "--patch",
                    String(sha),
                    "--",
                    taskDirName(id),
                ])
            } catch {
                throw new NotFoundError(`commit ${sha}`)
            }
        },
    }
}
