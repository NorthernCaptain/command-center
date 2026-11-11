/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    fileEntry,
    fileHref,
    fileKind,
    fileNameOfUrl,
    formatSize,
    pastedFile,
} from "./files.js"

describe("files helpers", () => {
    it("fileKind by extension", () => {
        expect(fileKind("a.PNG")).toBe("image")
        expect(fileKind("a.mov")).toBe("video")
        expect(fileKind("a.m4a")).toBe("audio")
        expect(fileKind("a.md")).toBe("markdown")
        expect(fileKind("a.pdf")).toBe("pdf")
        expect(fileKind("a.json")).toBe("text")
        expect(fileKind("a.zip")).toBe("other")
        expect(fileKind(null)).toBe("other")
    })

    it("fileHref and fileNameOfUrl", () => {
        expect(fileHref(5, "a b.png")).toBe("/api/tasks/5/files/a%20b.png")
        expect(fileHref(5, "a.png", { download: true })).toBe(
            "/api/tasks/5/files/a.png?download=1"
        )
        expect(fileNameOfUrl("files/a.png")).toBe("a.png")
        expect(fileNameOfUrl("files/../x")).toBeNull()
        expect(fileNameOfUrl("https://x/files/a.png")).toBeNull()
        expect(fileNameOfUrl(null)).toBeNull()
    })

    it("formatSize", () => {
        expect(formatSize(512)).toBe("512 B")
        expect(formatSize(1536)).toBe("1.5 KB")
        expect(formatSize(20 * 1024 * 1024)).toBe("20 MB")
        expect(formatSize(3 * 1024 ** 4)).toBe("3072 GB")
        expect(formatSize(null)).toBe("")
        expect(formatSize(-1)).toBe("")
    })

    it("pastedFile gives a dated name", () => {
        const at = new Date(2026, 10, 10, 21, 30, 45)
        const png = pastedFile(
            new File(["x"], "image.png", { type: "image/png" }),
            at
        )
        expect(png.name).toBe("pasted-20261110-213045.png")
        expect(png.type).toBe("image/png")
        const noExt = pastedFile(
            new File(["x"], "", { type: "image/jpeg" }),
            at
        )
        expect(noExt.name).toBe("pasted-20261110-213045.jpeg")
        const unknown = pastedFile(new File(["x"], ""), at)
        expect(unknown.name).toBe("pasted-20261110-213045.bin")
        expect(pastedFile(new File(["x"], "image.png")).name).toMatch(
            /^pasted-\d{8}-\d{6}\.png$/
        )
    })

    it("fileEntry finds the entry or makes a stub", () => {
        const files = [{ name: "a.png", label: "Shot", kind: "image" }]
        expect(fileEntry(files, "a.png")).toBe(files[0])
        expect(fileEntry(null, "b.md")).toEqual({
            name: "b.md",
            label: "b.md",
            kind: "markdown",
        })
    })
})
