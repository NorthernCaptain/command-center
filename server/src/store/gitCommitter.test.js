/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { jest } from "@jest/globals"
import { createFakeClock } from "../util/clock.js"
import { NotFoundError, ValidationError } from "../util/errors.js"
import { buildCommitMessage, createGitCommitter } from "./gitCommitter.js"

const run = promisify(execFile)
const exec = (cmd, args, opts) => run(cmd, args, opts)

let root
let dir
let clock
let log

async function gitOut(args, cwd = dir) {
    return (await run("git", args, { cwd })).stdout
}

async function initRepo(where, branch = "tasks") {
    fs.mkdirSync(where, { recursive: true })
    await run("git", ["init", "-q", "-b", branch], { cwd: where })
}

function write(rel, text) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text)
}

const commits = async () => {
    try {
        return (await gitOut(["log", "--format=%B%x1e"]))
            .split("\x1e")
            .map((s) => s.trim())
            .filter(Boolean)
    } catch {
        return []
    }
}

const committedFiles = async (ref = "HEAD") =>
    (await gitOut(["show", "--name-only", "--format=", ref]))
        .trim()
        .split("\n")
        .filter(Boolean)

function make(opts = {}) {
    return createGitCommitter({
        tasksDir: dir,
        exec,
        clock,
        debounceMs: 15000,
        author: { name: "Test Author", email: "test@example.com" },
        log,
        ...opts,
    })
}

beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-git-"))
    dir = path.join(root, "tasks")
    await initRepo(dir)
    clock = createFakeClock()
    log = {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    }
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

test("buildCommitMessage", () => {
    expect(
        buildCommitMessage("T-0001", ["a", "b"], new Set(["me", "center"]))
    ).toBe("T-0001: a; b\n\nActor: me\nActor: center")
    expect(buildCommitMessage("T-0002", [], new Set())).toBe("T-0002: updated")
})

test("ensureRepo accepts the tasks branch (unborn)", async () => {
    await expect(make().ensureRepo()).resolves.toEqual({ branch: "tasks" })
})

test("ensureRepo refuses a non-repo dir", async () => {
    const plain = path.join(root, "plain")
    fs.mkdirSync(plain)
    const git = createGitCommitter({ tasksDir: plain, exec, clock, log })
    await expect(git.ensureRepo()).rejects.toMatchObject({
        code: "git_not_ready",
    })
})

test("ensureRepo refuses a subfolder of another work tree", async () => {
    const sub = path.join(dir, "nested")
    fs.mkdirSync(sub)
    const git = createGitCommitter({ tasksDir: sub, exec, clock, log })
    await expect(git.ensureRepo()).rejects.toMatchObject({
        code: "git_not_ready",
    })
})

test("refuses to commit on another branch", async () => {
    await run("git", ["checkout", "-q", "-b", "main"], { cwd: dir })
    const git = make()
    await expect(git.ensureRepo()).rejects.toMatchObject({
        code: "git_wrong_branch",
    })
    write("T-0001/a.txt", "x")
    git.touch(1, "me", "created")
    await clock.advance(15000)
    expect(await commits()).toEqual([])
    expect(log.error).toHaveBeenCalled()
    expect(git.pendingCount()).toBe(1)
    await git.flush()
    expect(git.pendingCount()).toBe(1)
    await expect(git.recoverUncommitted()).rejects.toMatchObject({
        code: "git_wrong_branch",
    })
})

test("refuses on a detached HEAD", async () => {
    write("seed.txt", "s")
    await run("git", ["add", "seed.txt"], { cwd: dir })
    await run(
        "git",
        [
            "-c",
            "user.name=x",
            "-c",
            "user.email=x@x",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-q",
            "-m",
            "seed",
        ],
        { cwd: dir }
    )
    await run("git", ["checkout", "-q", "--detach"], { cwd: dir })
    await expect(make().ensureRepo()).rejects.toMatchObject({
        code: "git_wrong_branch",
    })
})

test("debounces touches into one commit with summaries and actors", async () => {
    const git = make()
    write("T-0001/task.json", "{}")
    git.touch(1, "me", "created")
    await clock.advance(10000)
    write("T-0001/artifact.md", "# hi")
    git.touch(1, "center", "updated Summary")
    git.touch(1, "center", "updated Summary")
    await clock.advance(14000)
    expect(await commits()).toEqual([])
    await clock.advance(1000)
    expect(await commits()).toEqual([
        "T-0001: created; updated Summary\n\nActor: me\nActor: center",
    ])
    const author = await gitOut(["log", "-1", "--format=%an <%ae>"])
    expect(author.trim()).toBe("Test Author <test@example.com>")
    expect(git.pendingCount()).toBe(0)
})

test("maxWait bounds the debounce under constant writes", async () => {
    const git = make({ debounceMs: 15000, maxWaitMs: 30000 })
    for (let i = 0; i < 5; i++) {
        write("T-0002/events.jsonl", `${i}\n`)
        git.touch(2, "me", `e${i}`)
        await clock.advance(10000)
    }
    // First commit fired at t=30s even though touches kept coming.
    const list = await commits()
    expect(list).toEqual(["T-0002: e0; e1; e2\n\nActor: me"])
})

test("commits only the task folder and skips temp files", async () => {
    const git = make()
    write("T-0001/task.json", "{}")
    write("T-0001/.task.json.abc.cctmp", "tmp")
    write("T-0002/task.json", "{}")
    write("README.md", "x")
    git.touch(1, "me", "created")
    await git.flush()
    expect(await committedFiles()).toEqual(["T-0001/task.json"])
    const status = await gitOut(["status", "--porcelain", "-uall"])
    expect(status).toContain("T-0002/task.json")
    expect(status).toContain("README.md")
    expect(status).toContain(".task.json.abc.cctmp")
})

test("never commits other staged paths under another task's message (regression)", async () => {
    const git = make()
    write("T-0001/task.json", "{}")
    git.touch(1, "me", "created")
    await git.flush()
    // Something else staged in the index: by hand, or left over from a
    // failed earlier commit of another task.
    write("T-0001/file.txt", "staged by hand")
    write("README.md", "staged outside the tasks")
    await run("git", ["add", "T-0001/file.txt", "README.md"], { cwd: dir })
    write("T-0002/task.json", "{}")
    git.touch(2, "center", "created")
    await git.flush()
    expect((await commits())[0]).toBe("T-0002: created\n\nActor: center")
    expect(await committedFiles()).toEqual(["T-0002/task.json"])
    // The unrelated paths stay staged for their own commit.
    const staged = await gitOut(["diff", "--cached", "--name-only"])
    expect(staged.trim().split("\n").sort()).toEqual([
        "README.md",
        "T-0001/file.txt",
    ])
    git.touch(1, "me", "file")
    await git.flush()
    expect(await committedFiles()).toEqual(["T-0001/file.txt"])
})

test("corrupt jsonl sidecars are never committed", async () => {
    const git = make()
    write("T-0001/comments.jsonl", "{}\n")
    write("T-0001/comments.jsonl.corrupt", '{"torn\n')
    git.touch(1, "recovery", "repaired")
    await git.flush()
    expect(await committedFiles()).toEqual(["T-0001/comments.jsonl"])
    // A sidecar alone is not a leftover for recovery.
    expect(await git.recoverUncommitted()).toBe(false)
    const status = await gitOut(["status", "--porcelain", "-uall"])
    expect(status).toContain("comments.jsonl.corrupt")
})

test("no commit when nothing changed", async () => {
    const git = make()
    write("T-0001/task.json", "{}")
    git.touch(1, "me", "created")
    await git.flush()
    git.touch(1, "me", "noop")
    await git.flush()
    expect(await commits()).toHaveLength(1)
    await git.flush() // nothing pending
})

test("a failed commit keeps its summaries for the next one", async () => {
    let fail = true
    const flaky = async (cmd, args, opts) => {
        if (fail && args.includes("commit")) {
            fail = false
            throw new Error("index.lock exists")
        }
        return exec(cmd, args, opts)
    }
    const git = make({ exec: flaky })
    write("T-0001/task.json", "{}")
    git.touch(1, "me", "first")
    await clock.advance(15000)
    expect(log.error).toHaveBeenCalled()
    expect(git.pendingCount()).toBe(1)
    await git.flush()
    expect(await commits()).toEqual(["T-0001: first\n\nActor: me"])

    // Failure while another touch is already pending merges both entries.
    fail = true
    let release
    const gate = new Promise((r) => {
        release = r
    })
    const slow = async (cmd, args, opts) => {
        if (args.includes("commit") && fail) {
            fail = false
            await gate
            throw new Error("boom")
        }
        return exec(cmd, args, opts)
    }
    const git2 = make({ exec: slow })
    write("T-0001/task.json", '{"a":1}')
    git2.touch(1, "me", "second")
    const p = git2.flush()
    await new Promise((r) => setTimeout(r, 300))
    git2.touch(1, "center", "third")
    release()
    await p
    await git2.flush()
    expect((await commits())[0]).toBe(
        "T-0001: second; third\n\nActor: center\nActor: me"
    )
})

test("recoverUncommitted commits leftovers per task with Actor: recovery", async () => {
    const git = make()
    write("T-0003/task.json", "{}")
    write("T-0004/artifact.md", "x")
    write("T-0004/.artifact.md.zz.cctmp", "tmp")
    write("notes.txt", "outside")
    expect(await git.recoverUncommitted()).toBe(true)
    const list = await commits()
    expect(list).toEqual([
        "T-0004: recovery commit\n\nActor: recovery",
        "T-0003: recovery commit\n\nActor: recovery",
    ])
    expect(await git.recoverUncommitted()).toBe(false)

    // Renames are parsed (two NUL-separated paths).
    await run("git", ["mv", "T-0003/task.json", "T-0003/moved.json"], {
        cwd: dir,
    })
    expect(await git.recoverUncommitted()).toBe(true)
    expect(await committedFiles()).toEqual(
        expect.arrayContaining(["T-0003/moved.json"])
    )
})

test("log and diff", async () => {
    const git = make()
    expect(await git.log(1)).toEqual([]) // unborn branch
    expect(log.debug).toHaveBeenCalled()
    write("T-0001/artifact.md", "one\n")
    git.touch(1, "me", "created")
    await git.flush()
    write("T-0001/artifact.md", "two\n")
    write("T-0002/artifact.md", "other\n")
    git.touch(1, "agent:w1", "edited")
    git.touch(1, "center", "edited")
    git.touch(2, "me", "created")
    await git.flush()

    const history = await git.log(1, 10)
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({
        sha: expect.stringMatching(/^[0-9a-f]{40}$/),
        at: expect.any(String),
        actor: "agent:w1, center",
        actors: ["agent:w1", "center"],
        message: "T-0001: edited",
    })
    expect(history[1].message).toBe("T-0001: created")
    expect(await git.log(1, 1)).toHaveLength(1)
    expect(await git.log(1, "bad")).toHaveLength(2)
    expect(await git.log(9)).toEqual([])

    const d = await git.diff(1, history[0].sha)
    expect(d).toContain("-one")
    expect(d).toContain("+two")
    expect(d).not.toContain("T-0002")
    await expect(git.diff(1, "zz;rm")).rejects.toBeInstanceOf(ValidationError)
    await expect(git.diff(1, "deadbeef")).rejects.toBeInstanceOf(NotFoundError)
})

test("log tolerates commits without Actor trailers", async () => {
    write("T-0001/a", "a")
    await run("git", ["add", "."], { cwd: dir })
    await run(
        "git",
        [
            "-c",
            "user.name=x",
            "-c",
            "user.email=x@x",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-q",
            "-m",
            "manual",
        ],
        { cwd: dir }
    )
    const [entry] = await make().log(1)
    expect(entry.actor).toBeNull()
    expect(entry.actors).toEqual([])
})

test("defaults: system clock and default author", async () => {
    const git = createGitCommitter({ tasksDir: dir, exec })
    write("T-0001/a", "a")
    git.touch(1, "me", "x")
    await git.flush()
    const author = await gitOut(["log", "-1", "--format=%an"])
    expect(author.trim()).toBe("Command Center")
})

describe("separation from the code repo", () => {
    test("refuses a tasksDir that is the code repo or one of its worktrees", async () => {
        await initRepo(dir)
        // the code checkout itself as tasksDir
        await expect(
            make({ codeRepoDir: dir }).ensureRepo()
        ).rejects.toMatchObject({
            code: "git_not_separate",
        })
        // a worktree of the code repo (the old orphan-branch layout)
        write("seed", "x")
        await gitOut(["add", "seed"])
        await gitOut([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@x",
            "commit",
            "-qm",
            "seed",
        ])
        const wt = path.join(root, "wt")
        await gitOut(["worktree", "add", "-q", "-b", "data", wt])
        await expect(
            createGitCommitter({
                tasksDir: wt,
                exec,
                branch: "data",
                codeRepoDir: dir,
            }).ensureRepo()
        ).rejects.toMatchObject({ code: "git_not_separate" })
    })

    test("accepts a separate repo, or a code checkout that is not a git repo", async () => {
        await initRepo(dir)
        const code = path.join(root, "code")
        await initRepo(code, "main")
        expect(await make({ codeRepoDir: code }).ensureRepo()).toEqual({
            branch: "tasks",
        })
        const plain = path.join(root, "plain")
        fs.mkdirSync(plain)
        expect(await make({ codeRepoDir: plain }).ensureRepo()).toEqual({
            branch: "tasks",
        })
    })
})
