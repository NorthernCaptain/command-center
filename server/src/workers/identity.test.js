/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { jest } from "@jest/globals"
import {
    agentName,
    createIdentity,
    defaultBranch,
    folderName,
    isValidBranch,
    parseTaskNote,
    slugify,
    truncateName,
} from "./identity.js"

function fakeStore(tasks, pageSize = 1000) {
    const store = {
        calls: [],
        async query({ limit, offset = 0 }) {
            store.calls.push({ limit, offset })
            const n = Math.min(limit, pageSize)
            return {
                tasks: tasks.slice(offset, offset + n),
                total: tasks.length,
            }
        },
    }
    return store
}

let tree
beforeEach(() => {
    tree = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tree-"))
})
afterEach(() => {
    fs.rmSync(tree, { recursive: true, force: true })
})

function mkFolder(name, note) {
    fs.mkdirSync(path.join(tree, name, ".git"), { recursive: true })
    if (note)
        fs.writeFileSync(path.join(tree, name, ".git", "agent-task.md"), note)
}

describe("pure helpers", () => {
    test("slugify drops stop words, caps words and length", () => {
        expect(slugify("Fix the upload retry for big files")).toBe(
            "fix-upload-retry-big"
        )
        expect(slugify("Fix upload", 1)).toBe("fix")
        expect(slugify("  ")).toBe("task")
        expect(slugify(null)).toBe("task")
        expect(slugify("the a an")).toBe("the-a-an")
        expect(slugify("Café déjà vu!")).toBe("cafe-deja-vu")
        const long = slugify("x".repeat(60))
        expect(long).toBe("x".repeat(40))
        expect(slugify("aaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbb cc")).toBe(
            "aaaaaaaaaaaaaaaaaaaa"
        )
        expect(slugify("fix it now", 0)).toBe("fix")
    })

    test("defaultBranch / agentName", () => {
        const task = { id: 123, title: "Fix upload retry" }
        expect(defaultBranch(task)).toBe("t123-fix-upload-retry")
        expect(agentName(task)).toBe("t123-fix-upload-retry")
        const long = agentName({
            id: 98765,
            title: "Refactor everything aboutness gigantic monolith",
        })
        expect(long.length).toBeLessThanOrEqual(32)
        expect(long).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
        expect(long.endsWith("-")).toBe(false)
        expect(truncateName("abc-def-", 4)).toBe("abc")
    })

    test("folderName replaces slashes in the branch", () => {
        expect(
            folderName({
                repo: "aws-lambda",
                branch: "feature/x",
                slug: "k7q2",
            })
        ).toBe("aws-lambda--feature-x--k7q2")
    })

    test("isValidBranch", () => {
        expect(isValidBranch("t1-fix")).toBe(true)
        expect(isValidBranch("feature/t1-x")).toBe(true)
        for (const bad of [
            "",
            null,
            "-x",
            "/x",
            "x/",
            "x.",
            "x.lock",
            "a..b",
            "a//b",
            "a b",
            "a;b",
            "x".repeat(201),
        ])
            expect(isValidBranch(bad)).toBe(false)
    })

    test("parseTaskNote reads keys, folders, status and pr", () => {
        const note = parseTaskNote(
            [
                "repo: aws-lambda",
                "branch: t1-fix",
                "slug: k7q2",
                "folders: aws-lambda--t1-fix--k7q2 (main), infrastructure--t1-fix--k7q2 (ref)",
                "  - web-trace--t1-fix--k7q2 (work)",
                "  bare--t1-fix--k7q2",
                "status: pr-open https://github.com/acme/aws-lambda/pull/1",
                "",
                "task: something",
                "  continuation ignored",
            ].join("\n")
        )
        expect(note.repo).toBe("aws-lambda")
        expect(note.branch).toBe("t1-fix")
        expect(note.status).toBe("pr-open")
        expect(note.pr).toBe("https://github.com/acme/aws-lambda/pull/1")
        expect(note.folders).toEqual([
            { folder: "aws-lambda--t1-fix--k7q2", role: "main" },
            { folder: "infrastructure--t1-fix--k7q2", role: "ref" },
            { folder: "web-trace--t1-fix--k7q2", role: "work" },
            { folder: "bare--t1-fix--k7q2", role: null },
        ])
        expect(parseTaskNote("status: in-progress").pr).toBeUndefined()
        expect(parseTaskNote(null)).toEqual({ folders: [] })
        expect(parseTaskNote("folders: ,  ,").folders).toEqual([])
    })
})

describe("createIdentity", () => {
    test("newSlug avoids tree folders and task slugs", async () => {
        mkFolder("aws-lambda--x--aaaa")
        const store = fakeStore([{ id: 1, slug: "bbbb" }, { id: 2 }])
        // random yields a,a,a,a then b,b,b,b then c,c,c,c
        const seq = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]
        const random = jest.fn(() => seq.shift())
        const id = createIdentity({ store, treeDir: tree, random })
        expect(await id.newSlug()).toBe("cccc")
    })

    test("newSlug gives up after many collisions; missing tree is fine", async () => {
        const store = fakeStore([{ id: 1, slug: "aaaa" }])
        const id = createIdentity({
            store,
            treeDir: path.join(tree, "missing"),
            random: () => 0,
        })
        await expect(id.newSlug()).rejects.toMatchObject({
            code: "slug_exhausted",
        })
    })

    test("allTasks pages through store.query until total", async () => {
        const tasks = []
        for (let i = 1; i <= 5; i++) tasks.push({ id: i, slug: null })
        tasks.push({
            id: 6,
            repos: [{ name: "r", role: "main" }],
            branch: "old-branch",
        })
        const store = fakeStore(tasks, 2)
        const exec = jest.fn(async () => ({ stdout: "" }))
        const id = createIdentity({ store, treeDir: tree, exec, org: "acme" })
        const r = await id.checkBranch("r", "old-branch", 99)
        expect(r.ok).toBe(false)
        expect(store.calls.map((c) => c.offset)).toEqual([0, 2, 4])
        expect(exec).not.toHaveBeenCalled()
    })

    test("allTasks stops on an empty page or missing result", async () => {
        const store = {
            query: jest
                .fn()
                .mockResolvedValueOnce({ tasks: [{ id: 1 }], total: 5 })
                .mockResolvedValueOnce({ tasks: [], total: 5 }),
        }
        const exec = jest.fn(async () => ({ stdout: "" }))
        const id = createIdentity({ store, treeDir: tree, exec, org: "acme" })
        expect(await id.checkBranch("r", "b", 1)).toEqual({ ok: true })
        const empty = createIdentity({
            store: { query: async () => null },
            treeDir: tree,
            exec,
            org: "acme",
        })
        expect(await empty.checkBranch("r", "b", 1)).toEqual({ ok: true })
        // no github.org: the remote check is skipped with a warning
        const noOrg = createIdentity({
            store: { query: async () => null },
            treeDir: tree,
            exec,
        })
        expect(await noOrg.checkBranch("r", "b", 1)).toEqual({
            ok: true,
            warning: "remote check skipped: github.org is not configured",
        })
    })

    test("checkBranch: a branch link reserved for a secondary repo conflicts", async () => {
        const store = fakeStore([
            {
                id: 1,
                repos: [{ name: "aws-lambda", role: "main" }],
                branch: "t1-main",
                deliverables: [],
                links: [
                    { type: "branch", label: "infra", url: "t1-infra-change" },
                    { type: "pr", label: "infra", url: "https://x" },
                ],
            },
        ])
        const exec = jest.fn(async () => ({ stdout: "" }))
        const id = createIdentity({ store, treeDir: tree, exec, org: "acme" })
        const r = await id.checkBranch("infra", "t1-infra-change", 2)
        expect(r.ok).toBe(false)
        expect(r.reason).toMatch(/T-1/)
        // the reservation is per repo, and the owner itself may use it
        expect((await id.checkBranch("web", "t1-infra-change", 2)).ok).toBe(
            true
        )
        expect((await id.checkBranch("infra", "t1-infra-change", 1)).ok).toBe(
            true
        )
    })

    test("checkBranch: conflicts with another task's branch / deliverable", async () => {
        const store = fakeStore([
            {
                id: 1,
                repos: [{ name: "aws-lambda", role: "main" }],
                branch: "t5-fix",
            },
            {
                id: 2,
                repos: [],
                deliverables: [{ repo: "infra", branch: "t5-x" }],
            },
            { id: 3, repos: [], branch: "t5-norepo" },
            {
                id: 4,
                repos: [{ name: "other", role: "main" }],
                branch: "t5-other",
            },
            { id: 6, repos: [], branch: "feature/t5-y" },
            { id: 7, repos: [], branch: "feature/t5-y-2" },
        ])
        const exec = jest.fn(async () => ({ stdout: "" }))
        const id = createIdentity({ store, treeDir: tree, exec, org: "acme" })

        const a = await id.checkBranch("aws-lambda", "t5-fix", 5)
        expect(a).toMatchObject({ ok: false, suggestion: "t5-fix-2" })
        expect(a.reason).toMatch(/T-1/)
        const b = await id.checkBranch("infra", "t5-x", 5)
        expect(b).toMatchObject({ ok: false, suggestion: "t5-x-2" })
        // a task without repos holds its branch everywhere
        expect((await id.checkBranch("any", "t5-norepo", 5)).ok).toBe(false)
        // another repo's branch does not conflict
        expect(await id.checkBranch("aws-lambda", "t5-other", 5)).toEqual({
            ok: true,
        })
        // the task's own branch is not a conflict
        expect((await id.checkBranch("aws-lambda", "t5-fix", 1)).ok).toBe(true)
        // suggestion keeps the prefix and skips used suffixes
        const c = await id.checkBranch("x", "feature/t5-y", 5)
        expect(c.suggestion).toBe("feature/t5-y-3")
    })

    test("checkBranch: suggestion adds t<id> when missing", async () => {
        const store = fakeStore([
            { id: 1, repos: [], branch: "fix-it" },
            { id: 2, repos: [], branch: "feature/fix-it" },
        ])
        const id = createIdentity({
            store,
            treeDir: tree,
            exec: async () => ({ stdout: "" }),
        })
        expect((await id.checkBranch("r", "fix-it", 9)).suggestion).toBe(
            "t9-fix-it"
        )
        expect(
            (await id.checkBranch("r", "feature/fix-it", 9)).suggestion
        ).toBe("feature/t9-fix-it")
    })

    test("checkBranch: invalid names", async () => {
        const id = createIdentity({ store: fakeStore([]), treeDir: tree })
        expect(await id.checkBranch("r", "bad name", 1)).toMatchObject({
            ok: false,
            suggestion: null,
        })
    })

    test("checkBranch: remote branch exists / remote check fails", async () => {
        const exec = jest.fn(async () => ({
            stdout: "abc123\trefs/heads/t5-fix\n",
        }))
        const id = createIdentity({
            store: fakeStore([]),
            treeDir: tree,
            exec,
            org: "acme",
        })
        const r = await id.checkBranch("repo", "t5-fix", 5)
        expect(r).toMatchObject({ ok: false, suggestion: "t5-fix-2" })
        expect(r.reason).toMatch(/acme\/repo/)
        expect(exec).toHaveBeenCalledWith("git", [
            "ls-remote",
            "--heads",
            "git@github.com:acme/repo.git",
            "t5-fix",
        ])
        exec.mockResolvedValueOnce({ stdout: "abc\trefs/heads/t5-fix-x\n" })
        expect(await id.checkBranch("repo", "t5-fix", 5)).toEqual({ ok: true })
        exec.mockResolvedValueOnce(null)
        expect(await id.checkBranch("repo", "t5-fix", 5)).toEqual({ ok: true })
        exec.mockRejectedValueOnce(new Error("offline"))
        expect(await id.checkBranch("repo", "t5-fix", 5)).toEqual({
            ok: true,
            warning: "remote check failed: offline",
        })
        exec.mockRejectedValueOnce("weird")
        expect((await id.checkBranch("repo", "t5-fix", 5)).warning).toBe(
            "remote check failed: weird"
        )
    })

    test("checkBranch: own deliverable branch skips the remote check", async () => {
        const exec = jest.fn()
        const store = fakeStore([
            {
                id: 5,
                repos: [{ name: "repo", role: "main" }],
                branch: "t5-fix",
                deliverables: [{ repo: "repo", branch: "t5-fix" }],
            },
        ])
        const id = createIdentity({ store, treeDir: tree, exec, org: "acme" })
        expect(await id.checkBranch("repo", "t5-fix", 5)).toEqual({ ok: true })
        expect(exec).not.toHaveBeenCalled()
    })

    test("scanFolders reads notes and roles", () => {
        mkFolder(
            "aws-lambda--t1-fix--k7q2",
            [
                "repo: aws-lambda",
                "branch: t1-fix",
                "folders: aws-lambda--t1-fix--k7q2 (main), infrastructure--t1-fix--k7q2 (ref)",
                "status: pr-open https://github.com/x/pull/1",
            ].join("\n")
        )
        mkFolder("infrastructure--t1-fix--k7q2")
        mkFolder("weird--k7q2")
        mkFolder("other--b--zzzz")
        fs.writeFileSync(path.join(tree, "file--k7q2"), "not a dir")
        const id = createIdentity({ store: fakeStore([]), treeDir: tree })
        expect(id.scanFolders("k7q2")).toEqual([
            {
                folder: "aws-lambda--t1-fix--k7q2",
                repo: "aws-lambda",
                branch: "t1-fix",
                role: "main",
                status: "pr-open",
                pr: "https://github.com/x/pull/1",
            },
            {
                folder: "infrastructure--t1-fix--k7q2",
                repo: "infrastructure",
                branch: "t1-fix",
                role: "ref",
            },
            { folder: "weird--k7q2", repo: "weird", branch: null },
        ])
        expect(id.scanFolders("../x")).toEqual([])
        expect(id.scanFolders(null)).toEqual([])
    })

    test("scanFolders: an unreadable tree is empty, or throws when strict", () => {
        const id = createIdentity({
            store: fakeStore([]),
            treeDir: path.join(tree, "missing"),
        })
        expect(id.scanFolders("k7q2")).toEqual([])
        expect(() => id.scanFolders("k7q2", { strict: true })).toThrow(/ENOENT/)
    })
})
