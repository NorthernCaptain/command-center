/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// /api/tasks/:id/files: upload, list, serve (owner, and viewers of shared
// tasks), delete. taskFiles is faked; served files are real temp files.

import { jest } from "@jest/globals"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { NotFoundError } from "../util/errors.js"
import { createHarness, request, seedTasks, TOKEN } from "./testing/fakes.js"

const bearer = (r) => r.set("Authorization", `Bearer ${TOKEN}`)
const asViewer = (r) => r.set("Tailscale-User-Login", "bob@example.com")

let root
let dir
let taskFiles
let h

const KINDS = {
    "a.png": ["image/png", "image"],
    "a.svg": ["image/svg+xml", "image"],
    "a.md": ["text/markdown", "markdown"],
    "a.pdf": ["application/pdf", "pdf"],
    "a.html": ["text/html", "other"],
}

beforeEach(() => {
    // under a dot-folder: only the stored name is checked for dotfiles
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-app-files-"))
    dir = path.join(root, ".data", "files")
    fs.mkdirSync(dir, { recursive: true })
    for (const name of Object.keys(KINDS))
        fs.writeFileSync(path.join(dir, name), `body of ${name}`)
    taskFiles = {
        list: jest.fn(async () => [{ name: "a.png" }]),
        add: jest.fn(async (id, f) => {
            const chunks = []
            for await (const c of f.stream) chunks.push(c)
            return {
                name: f.name,
                label: f.label || f.name,
                size: f.size,
                body: Buffer.concat(chunks).toString(),
            }
        }),
        open: jest.fn(async (id, name) => {
            if (!KINDS[name]) throw new NotFoundError("file")
            return {
                path: path.join(dir, name),
                mime: KINDS[name][0],
                kind: KINDS[name][1],
            }
        }),
        remove: jest.fn(async (id, name) => ({ removed: name })),
    }
    h = createHarness({ deps: { taskFiles } })
    seedTasks(h.store)
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe("task files", () => {
    test("task detail lists the files", async () => {
        const res = await bearer(request(h.local).get("/api/tasks/2"))
        expect(res.body.files).toEqual([{ name: "a.png" }])
        const list = await bearer(request(h.local).get("/api/tasks/2/files"))
        expect(list.body).toEqual({ files: [{ name: "a.png" }] })
    })

    test("upload streams the raw body with the name and length", async () => {
        const res = await bearer(
            request(h.local)
                .post("/api/tasks/2/files?name=My%20Shot.png&label=Shot")
                .set("Content-Type", "application/octet-stream")
                .send(Buffer.from("PNGDATA"))
        )
        expect(res.status).toBe(201)
        expect(res.body.file).toEqual({
            name: "My Shot.png",
            label: "Shot",
            size: 7,
            body: "PNGDATA",
        })
        expect(taskFiles.add.mock.calls[0][1]).toMatchObject({ actor: "me" })
    })

    test("upload needs octet-stream and a name", async () => {
        const json = await bearer(
            request(h.local)
                .post("/api/tasks/2/files?name=a.json")
                .send({ a: 1 })
        )
        expect(json.status).toBe(415)
        const noName = await bearer(
            request(h.local)
                .post("/api/tasks/2/files")
                .set("Content-Type", "application/octet-stream")
                .send(Buffer.from("x"))
        )
        expect(noName.status).toBe(400)
        expect(taskFiles.add).not.toHaveBeenCalled()
    })

    test("images are inline and sandboxed", async () => {
        const res = await bearer(
            request(h.local).get("/api/tasks/2/files/a.png")
        )
        expect(res.status).toBe(200)
        expect(res.headers["content-type"]).toBe("image/png")
        expect(res.headers["content-disposition"]).toBe(
            'inline; filename="a.png"'
        )
        expect(res.headers["content-security-policy"]).toContain("sandbox")
        expect(res.headers["x-content-type-options"]).toBe("nosniff")
        expect(res.body.toString()).toBe("body of a.png")
        const svg = await bearer(
            request(h.local).get("/api/tasks/2/files/a.svg")
        )
        expect(svg.headers["content-security-policy"]).toContain("sandbox")
    })

    test("markdown is plain text, HTML a sandboxed download", async () => {
        const md = await bearer(request(h.local).get("/api/tasks/2/files/a.md"))
        expect(md.headers["content-type"]).toBe("text/plain; charset=utf-8")
        expect(md.text).toBe("body of a.md")
        const html = await bearer(
            request(h.local).get("/api/tasks/2/files/a.html")
        )
        expect(html.headers["content-disposition"]).toBe(
            'attachment; filename="a.html"'
        )
        expect(html.headers["content-security-policy"]).toContain("sandbox")
        const dl = await bearer(
            request(h.local).get("/api/tasks/2/files/a.png?download=1")
        )
        expect(dl.headers["content-disposition"]).toMatch(/^attachment/)
    })

    test("PDFs can be framed by the task page", async () => {
        const res = await bearer(
            request(h.local).get("/api/tasks/2/files/a.pdf")
        )
        expect(res.headers["content-type"]).toBe("application/pdf")
        expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN")
        expect(res.headers["content-security-policy"]).toBe(
            "frame-ancestors 'self'"
        )
    })

    test("ranges work (video seeking)", async () => {
        const res = await bearer(
            request(h.local)
                .get("/api/tasks/2/files/a.png")
                .set("Range", "bytes=0-3")
        )
        expect(res.status).toBe(206)
        expect(res.body.toString()).toBe("body")
    })

    test("bad or unknown names are 404", async () => {
        const bad = await bearer(
            request(h.local).get("/api/tasks/2/files/.hidden")
        )
        expect(bad.status).toBe(404)
        expect(taskFiles.open).not.toHaveBeenCalled()
        const missing = await bearer(
            request(h.local).get("/api/tasks/2/files/b.png")
        )
        expect(missing.status).toBe(404)
        const task = await bearer(
            request(h.local).get("/api/tasks/99/files/a.png")
        )
        expect(task.status).toBe(404)
    })

    test("viewers get files of shared tasks only, and can't change them", async () => {
        const ok = await asViewer(
            request(h.tailnet).get("/api/tasks/1/files/a.png")
        )
        expect(ok.status).toBe(200)
        const priv = await asViewer(
            request(h.tailnet).get("/api/tasks/2/files/a.png")
        )
        expect(priv.status).toBe(404)
        const list = await asViewer(
            request(h.tailnet).get("/api/tasks/1/files")
        )
        expect(list.status).toBe(403)
        const del = await asViewer(
            request(h.tailnet).delete("/api/tasks/1/files/a.png")
        )
        expect(del.status).toBe(403)
        expect(taskFiles.remove).not.toHaveBeenCalled()
    })

    test("delete removes the file", async () => {
        const res = await bearer(
            request(h.local).delete("/api/tasks/2/files/a.png")
        )
        expect(res.body).toEqual({ removed: "a.png" })
        expect(taskFiles.remove).toHaveBeenCalledWith(2, "a.png", "me")
        const bad = await bearer(
            request(h.local).delete("/api/tasks/2/files/..x")
        )
        expect(bad.status).toBe(404)
    })

    test("no routes without taskFiles", async () => {
        const plain = createHarness()
        seedTasks(plain.store)
        const res = await bearer(request(plain.local).get("/api/tasks/2/files"))
        expect(res.status).toBe(404)
        const detail = await bearer(request(plain.local).get("/api/tasks/2"))
        expect(detail.body).not.toHaveProperty("files")
    })
})
