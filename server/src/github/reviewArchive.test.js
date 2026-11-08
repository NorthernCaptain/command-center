/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
    contextDirName,
    createReviewArchive,
    workFolder,
} from "./reviewArchive.js"

let dir
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-reviews-"))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function write(ctx, name, data) {
    const d = path.join(dir, ctx)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(
        path.join(d, name),
        typeof data === "string" ? data : JSON.stringify(data)
    )
}

describe("names", () => {
    test("workFolder replaces slashes in the branch with dashes", () => {
        expect(workFolder("aws-lambda", "t1-fix", "k7q2")).toBe(
            "aws-lambda--t1-fix--k7q2"
        )
        expect(workFolder("web", "feature/upload", "ab12")).toBe(
            "web--feature-upload--ab12"
        )
    })
    test("contextDirName uses __ for slashes", () => {
        expect(
            contextDirName("web--feature-upload--ab12", "feature/upload")
        ).toBe("web--feature-upload--ab12:feature__upload")
    })
})

describe("createReviewArchive", () => {
    test("returns the newest parseable entry for a slashed branch", async () => {
        const branch = "feature/upload"
        const folder = workFolder("web", branch, "ab12")
        const ctx = contextDirName(folder, branch)
        write(ctx, "2026-11-07T10-00-00-000Z.json", {
            timestamp: "2026-11-07T10:00:00.000Z",
            result: { status: "ISSUES" },
        })
        write(ctx, "2026-11-07T11-00-00-000Z.json", {
            timestamp: "2026-11-07T11:00:00.000Z",
            context: { repo: "web", branch },
            result: { status: "GOOD_TO_GO" },
        })
        write(ctx, "2026-11-07T12-00-00-000Z.md", "# notes")
        write(ctx, "2026-11-07T13-00-00-000Z.json", "{ broken")
        write(ctx, "2026-11-07T14-00-00-000Z.json", { result: {} })
        const archive = createReviewArchive({
            dir,
            dashboardUrl: "http://127.0.0.1:7777/",
        })
        expect(await archive.latest({ folder, branch })).toEqual({
            status: "GOOD_TO_GO",
            timestamp: "2026-11-07T11:00:00.000Z",
            file: path.join(dir, ctx, "2026-11-07T11-00-00-000Z.json"),
            dashboardUrl: "http://127.0.0.1:7777/",
        })
    })

    test("missing timestamp, no entries, missing dir, bad args", async () => {
        write("a:b", "1.json", { result: { status: "GOOD_TO_GO" } })
        write("c:d", "1.json", { result: { status: null } })
        const archive = createReviewArchive({ dir })
        expect(await archive.latest({ folder: "a", branch: "b" })).toEqual({
            status: "GOOD_TO_GO",
            timestamp: null,
            file: path.join(dir, "a:b", "1.json"),
            dashboardUrl: null,
        })
        expect(await archive.latest({ folder: "c", branch: "d" })).toBeNull()
        expect(await archive.latest({ folder: "x", branch: "y" })).toBeNull()
        expect(await archive.latest({ folder: "", branch: "y" })).toBeNull()
        expect(
            await createReviewArchive({ dir: "" }).latest({
                folder: "a",
                branch: "b",
            })
        ).toBeNull()
        expect(
            await createReviewArchive().latest({ folder: "a", branch: "b" })
        ).toBeNull()
    })

    test("expands ~ in the archive dir", async () => {
        const reads = []
        const fakeFs = {
            promises: {
                readdir: async (p) => {
                    reads.push(p)
                    return []
                },
                readFile: async () => "{}",
            },
        }
        await createReviewArchive({ dir: "~/x", fs: fakeFs }).latest({
            folder: "f",
            branch: "b",
        })
        await createReviewArchive({ dir: "~", fs: fakeFs }).latest({
            folder: "f",
            branch: "b",
        })
        expect(reads).toEqual([
            path.join(os.homedir(), "x", "f:b"),
            path.join(os.homedir(), "f:b"),
        ])
    })
})
