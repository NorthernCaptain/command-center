/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Small filesystem helpers for the store: content-hash revisions, atomic
// writes (temp file in the same dir + fsync + rename) and O_APPEND appends.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/** Suffix of temp files. Recovery deletes them; git never adds them. */
export const TEMP_SUFFIX = ".cctmp"

/** Revision = first 16 hex chars of sha256 of the file bytes. */
export function hashBytes(data) {
    return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16)
}

/** Suffix of sidecars holding torn JSONL tails. Never committed. */
export const CORRUPT_SUFFIX = ".corrupt"

const NL = 0x0a

export function isTempFile(name) {
    return name.startsWith(".") && name.endsWith(TEMP_SUFFIX)
}

/**
 * Atomically replace `file` with `data`: write a temp file next to it,
 * fsync, rename over the target, then fsync the directory (best effort).
 */
export async function atomicWrite(file, data) {
    const dir = path.dirname(file)
    const rand = crypto.randomBytes(6).toString("hex")
    const tmp = path.join(dir, `.${path.basename(file)}.${rand}${TEMP_SUFFIX}`)
    const fh = await fs.promises.open(tmp, "wx", 0o644)
    try {
        await fh.writeFile(data)
        await fh.sync()
    } finally {
        await fh.close()
    }
    try {
        await fs.promises.rename(tmp, file)
    } catch (err) {
        await fs.promises.rm(tmp, { force: true })
        throw err
    }
    await fsyncDir(dir)
}

async function fsyncDir(dir) {
    let fh
    try {
        fh = await fs.promises.open(dir, "r")
        await fh.sync()
    } catch {
        // Directory fsync is not supported everywhere; the rename is atomic.
    } finally {
        if (fh) await fh.close()
    }
}

/**
 * Append one line (a JSON record) with O_APPEND and fsync. If the file does
 * not end with "\n" (a torn last line after a crash or ENOSPC), a newline is
 * written first so the new record never joins the partial one. Callers hold
 * the per-file lock (the store's task lock).
 */
export async function appendLine(file, line) {
    const fh = await fs.promises.open(file, "a+", 0o644)
    try {
        const { size } = await fh.stat()
        let sep = ""
        if (size > 0) {
            const last = Buffer.alloc(1)
            await fh.read(last, 0, 1, size - 1)
            if (last[0] !== NL) sep = "\n"
        }
        await fh.write(`${sep}${line.endsWith("\n") ? line : `${line}\n`}`)
        await fh.sync()
    } finally {
        await fh.close()
    }
}

/**
 * Repair a JSONL file whose last line is incomplete (no trailing "\n").
 * A tail that is still valid JSON just gets its newline; anything else is
 * appended to `<file>.corrupt` (never committed) and truncated
 * from the file. Returns null (nothing to do), "completed" or "truncated".
 */
export async function repairJsonlTail(file) {
    const buf = await readOrNull(file)
    if (!buf || !buf.length || buf[buf.length - 1] === NL) return null
    const cut = buf.lastIndexOf(NL) + 1
    const tail = buf.subarray(cut)
    let valid = false
    try {
        JSON.parse(tail.toString("utf8"))
        valid = true
    } catch {
        // torn record
    }
    if (valid) {
        await fs.promises.appendFile(file, "\n")
        return "completed"
    }
    await fs.promises.appendFile(
        `${file}${CORRUPT_SUFFIX}`,
        Buffer.concat([tail, Buffer.from("\n")])
    )
    await fs.promises.truncate(file, cut)
    return "truncated"
}

/** Read a file, returning null when it does not exist. */
export async function readOrNull(file) {
    try {
        return await fs.promises.readFile(file)
    } catch (err) {
        if (err.code === "ENOENT") return null
        throw err
    }
}

/**
 * Parse a JSONL file into records. Missing file -> []. Lines that are not
 * valid JSON (e.g. a torn last line after a crash) are skipped via onBad.
 */
export async function readJsonl(file, onBad = () => {}) {
    const buf = await readOrNull(file)
    if (!buf) return []
    const out = []
    for (const line of buf.toString("utf8").split("\n")) {
        if (!line.trim()) continue
        try {
            out.push(JSON.parse(line))
        } catch (err) {
            onBad(line, err)
        }
    }
    return out
}
