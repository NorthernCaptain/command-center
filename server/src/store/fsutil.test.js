/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
    CORRUPT_SUFFIX,
    appendLine,
    atomicWrite,
    hashBytes,
    isTempFile,
    readJsonl,
    readOrNull,
    repairJsonlTail,
} from "./fsutil.js"

let dir
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-fsutil-"))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

test("hashBytes = first 16 hex of sha256", () => {
    const full = crypto.createHash("sha256").update("abc").digest("hex")
    expect(hashBytes("abc")).toBe(full.slice(0, 16))
    expect(hashBytes(Buffer.from("abc"))).toBe(full.slice(0, 16))
})

test("isTempFile", () => {
    expect(isTempFile(".task.json.ab12.cctmp")).toBe(true)
    expect(isTempFile("task.json")).toBe(false)
    expect(isTempFile("x.cctmp")).toBe(false)
})

test("atomicWrite replaces content and leaves no temp files", async () => {
    const f = path.join(dir, "a.txt")
    await atomicWrite(f, "one")
    await atomicWrite(f, "two")
    expect(fs.readFileSync(f, "utf8")).toBe("two")
    expect(fs.readdirSync(dir)).toEqual(["a.txt"])
})

test("atomicWrite cleans the temp file when rename fails", async () => {
    const target = path.join(dir, "sub")
    fs.mkdirSync(path.join(target, "inner"), { recursive: true })
    // Renaming a file over a non-empty directory fails.
    await expect(atomicWrite(target, "x")).rejects.toThrow()
    expect(fs.readdirSync(dir)).toEqual(["sub"])
})

test("atomicWrite fails when the directory is missing", async () => {
    await expect(
        atomicWrite(path.join(dir, "nope", "a.txt"), "x")
    ).rejects.toThrow()
})

test("appendLine adds a newline when missing", async () => {
    const f = path.join(dir, "log.jsonl")
    await appendLine(f, '{"a":1}')
    await appendLine(f, '{"a":2}\n')
    expect(fs.readFileSync(f, "utf8")).toBe('{"a":1}\n{"a":2}\n')
})

test("appendLine never joins a torn last line (regression)", async () => {
    const f = path.join(dir, "torn.jsonl")
    fs.writeFileSync(f, '{"a":1}\n{"a":2,"b"')
    await appendLine(f, '{"a":3}')
    expect(fs.readFileSync(f, "utf8")).toBe('{"a":1}\n{"a":2,"b"\n{"a":3}\n')
    const bad = []
    expect(await readJsonl(f, (line) => bad.push(line))).toEqual([
        { a: 1 },
        { a: 3 },
    ])
    expect(bad).toEqual(['{"a":2,"b"'])
})

test("repairJsonlTail: nothing to do", async () => {
    const f = path.join(dir, "ok.jsonl")
    expect(await repairJsonlTail(f)).toBeNull()
    fs.writeFileSync(f, "")
    expect(await repairJsonlTail(f)).toBeNull()
    fs.writeFileSync(f, '{"a":1}\n')
    expect(await repairJsonlTail(f)).toBeNull()
    expect(fs.readFileSync(f, "utf8")).toBe('{"a":1}\n')
})

test("repairJsonlTail completes a valid tail missing its newline", async () => {
    const f = path.join(dir, "c.jsonl")
    fs.writeFileSync(f, '{"a":1}\n{"a":2}')
    expect(await repairJsonlTail(f)).toBe("completed")
    expect(fs.readFileSync(f, "utf8")).toBe('{"a":1}\n{"a":2}\n')
    expect(fs.existsSync(f + CORRUPT_SUFFIX)).toBe(false)
})

test("repairJsonlTail moves a torn tail to the .corrupt sidecar", async () => {
    const f = path.join(dir, "t.jsonl")
    fs.writeFileSync(f, '{"a":1}\n{"a":')
    expect(await repairJsonlTail(f)).toBe("truncated")
    expect(fs.readFileSync(f, "utf8")).toBe('{"a":1}\n')
    expect(fs.readFileSync(f + CORRUPT_SUFFIX, "utf8")).toBe('{"a":\n')
    // A torn single line (no newline at all) empties the file.
    fs.writeFileSync(f, "{oops")
    expect(await repairJsonlTail(f)).toBe("truncated")
    expect(fs.readFileSync(f, "utf8")).toBe("")
    expect(fs.readFileSync(f + CORRUPT_SUFFIX, "utf8")).toBe('{"a":\n{oops\n')
})

test("readOrNull and readJsonl", async () => {
    const f = path.join(dir, "x.jsonl")
    expect(await readOrNull(f)).toBeNull()
    expect(await readJsonl(f)).toEqual([])
    fs.writeFileSync(f, '{"a":1}\n\n{broken\n{"a":2}\n')
    const bad = []
    expect(await readJsonl(f, (line) => bad.push(line))).toEqual([
        { a: 1 },
        { a: 2 },
    ])
    expect(bad).toEqual(["{broken"])
    expect(await readJsonl(f)).toHaveLength(2)
    await expect(readOrNull(dir)).rejects.toThrow()
})
