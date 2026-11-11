/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { createBus } from "../events/bus.js"
import { openDb } from "../store/db.js"
import { getSectionBody } from "../store/artifact.js"
import { createStore } from "../store/store.js"
import { createFakeClock } from "../util/clock.js"
import {
    attachmentLine,
    createTaskFiles,
    fileKind,
    fileNameOfUrl,
    isFileName,
    mimeOf,
    safeFileName,
    uniqueName,
} from "./taskFiles.js"

let root
let db
let store
let files
let id

const bytes = (s) => Readable.from([Buffer.from(s)])
const attachments = async () =>
    getSectionBody((await store.getArtifact(id)).content, "Attachments")

beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-files-"))
    db = openDb(":memory:")
    const clock = createFakeClock()
    store = createStore({
        tasksDir: path.join(root, "tasks"),
        db,
        bus: createBus({ clock }),
        clock,
    })
    fs.mkdirSync(path.join(root, "tree", "repo"), { recursive: true })
    files = createTaskFiles({
        tasksDir: path.join(root, "tasks"),
        store,
        maxBytes: 64,
        allowedRoots: [path.join(root, "tree"), path.join(root, "nope")],
        clock,
    })
    id = (await store.createTask({ title: "Task" }, "me")).task.id
})

afterEach(async () => {
    await store.close()
    fs.rmSync(root, { recursive: true, force: true })
})

describe("helpers", () => {
    test("safeFileName keeps a readable ASCII name and the extension", () => {
        expect(safeFileName("My Screen Shot (2).PNG")).toBe(
            "My-Screen-Shot-2.png"
        )
        expect(safeFileName("../../etc/passwd")).toBe("passwd")
        expect(safeFileName("C:\\x\\Отчёт.md")).toBe("file.md")
        expect(safeFileName(".env")).toBe("file.env")
        expect(safeFileName("")).toBe("file")
        expect(safeFileName("Café notes.txt")).toBe("Cafe-notes.txt")
        expect(safeFileName(`${"a".repeat(300)}.md`)).toBe(
            `${"a".repeat(100)}.md`
        )
    })

    test("uniqueName adds a counter before the extension", () => {
        const taken = new Set(["a.png", "a-2.png", "notes"])
        expect(uniqueName("A.png", taken)).toBe("A-3.png")
        expect(uniqueName("b.png", taken)).toBe("b.png")
        expect(uniqueName("notes", taken)).toBe("notes-2")
    })

    test("types, kinds and names", () => {
        expect(mimeOf("a.PNG")).toBe("image/png")
        expect(mimeOf("a.bin")).toBe("application/octet-stream")
        expect(fileKind("a.mov")).toBe("video")
        expect(fileKind("a.md")).toBe("markdown")
        expect(fileKind("a.pdf")).toBe("pdf")
        expect(fileKind("a.json")).toBe("text")
        expect(fileKind("a.html")).toBe("other")
        expect(fileKind("noext")).toBe("other")
        expect(isFileName("a.png")).toBe(true)
        expect(isFileName(".upload-1.cctmp")).toBe(false)
        expect(isFileName("x.cctmp")).toBe(false)
        expect(isFileName("../a")).toBe(false)
        expect(isFileName(null)).toBe(false)
        expect(fileNameOfUrl("files/a.png")).toBe("a.png")
        expect(fileNameOfUrl("https://x")).toBeNull()
    })

    test("attachmentLine embeds images and videos, links the rest", () => {
        expect(attachmentLine("shot [1].png", "shot-1.png")).toBe(
            "- ![shot \\[1\\].png](files/shot-1.png)"
        )
        expect(attachmentLine("demo.mp4", "demo.mp4")).toBe(
            "- ![demo.mp4](files/demo.mp4)"
        )
        expect(attachmentLine(null, "spec.md")).toBe(
            "- [spec.md](files/spec.md)"
        )
    })
})

describe("add / list / open / remove", () => {
    test("add copies the file, links it and lists it in Attachments", async () => {
        const f = await files.add(id, {
            name: "Screen Shot.png",
            stream: bytes("png-bytes"),
            actor: "me",
        })
        expect(f).toMatchObject({
            name: "Screen-Shot.png",
            label: "Screen Shot.png",
            url: "files/Screen-Shot.png",
            size: 9,
            mime: "image/png",
            kind: "image",
            added_by: "me",
            missing: false,
        })
        expect(fs.readFileSync(f.path, "utf8")).toBe("png-bytes")
        const { task } = await store.getTask(id)
        expect(task.links.at(-1)).toMatchObject({
            type: "file",
            url: "files/Screen-Shot.png",
            label: "Screen Shot.png",
            size: 9,
            mime: "image/png",
        })
        expect(await attachments()).toBe(
            "- ![Screen Shot.png](files/Screen-Shot.png)"
        )
        // same name again: a second file
        const g = await files.add(id, {
            name: "Screen Shot.png",
            stream: bytes("other"),
            actor: "me",
            label: "Second",
        })
        expect(g.name).toBe("Screen-Shot-2.png")
        expect(g.label).toBe("Second")
        expect(await attachments()).toContain(
            "- ![Second](files/Screen-Shot-2.png)"
        )
        const listed = await files.list(id)
        expect(listed.map((x) => x.name)).toEqual([
            "Screen-Shot.png",
            "Screen-Shot-2.png",
        ])
        const events = await store.listEvents(id)
        expect(events.some((e) => e.type === "file_attached")).toBe(true)
        // no temp files left
        expect(fs.readdirSync(files.dirOf(id)).sort()).toEqual([
            "Screen-Shot-2.png",
            "Screen-Shot.png",
        ])
    })

    test("too large: refused up front or while streaming, nothing kept", async () => {
        await expect(
            files.add(id, {
                name: "a.txt",
                stream: bytes("x"),
                actor: "me",
                size: 65,
            })
        ).rejects.toMatchObject({ code: "file_too_large", status: 413 })
        await expect(
            files.add(id, {
                name: "a.txt",
                stream: bytes("x".repeat(65)),
                actor: "me",
            })
        ).rejects.toMatchObject({ code: "file_too_large" })
        expect(fs.readdirSync(files.dirOf(id))).toEqual([])
        expect(await files.list(id)).toEqual([])
    })

    test("add needs a name and a known task", async () => {
        await expect(
            files.add(id, { name: " ", stream: bytes("x"), actor: "me" })
        ).rejects.toMatchObject({ code: "validation" })
        await expect(
            files.add(99, { name: "a.txt", stream: bytes("x"), actor: "me" })
        ).rejects.toMatchObject({ status: 404 })
    })

    test("a failed link update removes the copied file", async () => {
        const real = store.updateTask
        store.updateTask = async () => {
            throw new Error("disk full")
        }
        await expect(
            files.add(id, { name: "a.txt", stream: bytes("x"), actor: "me" })
        ).rejects.toThrow("disk full")
        store.updateTask = real
        expect(fs.readdirSync(files.dirOf(id))).toEqual([])
    })

    test("a failed Attachments line keeps the attachment (no error)", async () => {
        const real = store.updateArtifactSection
        store.updateArtifactSection = async () => {
            throw new Error("artifact too large")
        }
        const f = await files.add(id, {
            name: "a.txt",
            stream: bytes("x"),
            actor: "me",
        })
        store.updateArtifactSection = real
        expect(f.name).toBe("a.txt")
        expect((await files.list(id)).map((x) => x.name)).toEqual(["a.txt"])
        expect(await attachments()).toBeNull()
    })

    test("addFromPath only takes files under the allowed roots", async () => {
        const ok = path.join(root, "tree", "repo", "report.md")
        fs.writeFileSync(ok, "# Report")
        const f = await files.addFromPath(id, ok, { actor: "agent:x" })
        expect(f).toMatchObject({ name: "report.md", kind: "markdown" })
        expect(await attachments()).toBe("- [report.md](files/report.md)")

        const outside = path.join(root, "secret.txt")
        fs.writeFileSync(outside, "s")
        await expect(
            files.addFromPath(id, outside, { actor: "agent:x" })
        ).rejects.toMatchObject({ code: "path_not_allowed", status: 403 })
        // a symlink inside a root that points outside is refused too
        const link = path.join(root, "tree", "link.txt")
        fs.symlinkSync(outside, link)
        await expect(
            files.addFromPath(id, link, { actor: "agent:x" })
        ).rejects.toMatchObject({ code: "path_not_allowed" })
        await expect(
            files.addFromPath(id, "relative.txt", { actor: "agent:x" })
        ).rejects.toMatchObject({ code: "validation" })
        await expect(
            files.addFromPath(id, path.join(root, "tree", "missing"), {
                actor: "agent:x",
            })
        ).rejects.toMatchObject({ status: 404 })
        await expect(
            files.addFromPath(id, path.join(root, "tree", "repo"), {
                actor: "agent:x",
            })
        ).rejects.toMatchObject({ code: "validation" })
    })

    test("open resolves stored files only", async () => {
        await files.add(id, { name: "a.md", stream: bytes("x"), actor: "me" })
        const o = await files.open(id, "a.md")
        expect(o).toMatchObject({ mime: "text/markdown", kind: "markdown" })
        expect(o.path).toBe(path.join(files.dirOf(id), "a.md"))
        await expect(files.open(id, "../task.json")).rejects.toMatchObject({
            status: 404,
        })
        await expect(files.open(id, "b.md")).rejects.toMatchObject({
            status: 404,
        })
        fs.mkdirSync(path.join(files.dirOf(id), "sub"))
        await expect(files.open(id, "sub")).rejects.toMatchObject({
            status: 404,
        })
    })

    test("list flags a missing file", async () => {
        const f = await files.add(id, {
            name: "a.md",
            stream: bytes("x"),
            actor: "me",
        })
        fs.rmSync(f.path)
        const [only] = await files.list(id)
        expect(only).toMatchObject({ name: "a.md", missing: true, size: 1 })
    })

    test("remove deletes the file, its link and its line", async () => {
        await files.add(id, { name: "a.png", stream: bytes("x"), actor: "me" })
        await files.add(id, { name: "b.md", stream: bytes("y"), actor: "me" })
        const res = await files.remove(id, "a.png", "me")
        expect(res).toEqual({ removed: "a.png" })
        expect(await attachments()).toBe("- [b.md](files/b.md)")
        expect((await files.list(id)).map((f) => f.name)).toEqual(["b.md"])
        expect(fs.existsSync(path.join(files.dirOf(id), "a.png"))).toBe(false)
        await expect(files.remove(id, "a.png", "me")).rejects.toMatchObject({
            status: 404,
        })
        await expect(files.remove(id, "../x", "me")).rejects.toMatchObject({
            status: 404,
        })
        // an unlinked file on disk can still be removed
        fs.writeFileSync(path.join(files.dirOf(id), "stray.txt"), "z")
        await files.remove(id, "stray.txt", "me")
        expect(fs.existsSync(path.join(files.dirOf(id), "stray.txt"))).toBe(
            false
        )
    })
})
