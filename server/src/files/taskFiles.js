/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Task attachments: files copied into <tasksDir>/T-NNNN/files/ next to the
// artifact (committed with the task folder). Each one is a "file" link
// (url "files/<name>", label = the original file name) and a line in the
// artifact's "Attachments" section: images and videos embedded, other
// files linked. Names are sanitized to [A-Za-z0-9._-] and made unique.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { taskDirName } from "../contracts/schemas.js"
import { newLinkId } from "../agent/jobs/util.js"
import { TEMP_SUFFIX } from "../store/fsutil.js"
import { AppError, NotFoundError, ValidationError } from "../util/errors.js"
import { systemClock } from "../util/clock.js"
import { nullLogger } from "../util/logger.js"

export const FILES_DIR = "files"
export const ATTACHMENTS_SECTION = "Attachments"
export const DEFAULT_MAX_BYTES = 250 * 1024 * 1024
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/
const MAX_STEM = 100

// extension -> [MIME type, how the task page shows it]
const TYPES = {
    png: ["image/png", "image"],
    jpg: ["image/jpeg", "image"],
    jpeg: ["image/jpeg", "image"],
    gif: ["image/gif", "image"],
    webp: ["image/webp", "image"],
    avif: ["image/avif", "image"],
    bmp: ["image/bmp", "image"],
    svg: ["image/svg+xml", "image"],
    heic: ["image/heic", "other"],
    mp4: ["video/mp4", "video"],
    m4v: ["video/mp4", "video"],
    mov: ["video/quicktime", "video"],
    webm: ["video/webm", "video"],
    mp3: ["audio/mpeg", "audio"],
    m4a: ["audio/mp4", "audio"],
    wav: ["audio/wav", "audio"],
    ogg: ["audio/ogg", "audio"],
    md: ["text/markdown", "markdown"],
    markdown: ["text/markdown", "markdown"],
    pdf: ["application/pdf", "pdf"],
    txt: ["text/plain", "text"],
    log: ["text/plain", "text"],
    csv: ["text/csv", "text"],
    tsv: ["text/tab-separated-values", "text"],
    json: ["application/json", "text"],
    yaml: ["text/yaml", "text"],
    yml: ["text/yaml", "text"],
    xml: ["application/xml", "text"],
}

const extOf = (name) => {
    const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name || ""))
    return m ? m[1].toLowerCase() : ""
}

/** MIME type by extension (application/octet-stream when unknown). */
export function mimeOf(name) {
    const t = TYPES[extOf(name)]
    return t ? t[0] : "application/octet-stream"
}

/**
 * How the task page shows a file: image | video | audio | markdown | pdf |
 * text | other.
 */
export function fileKind(name) {
    const t = TYPES[extOf(name)]
    return t ? t[1] : "other"
}

/** A file name safe on disk and in a Markdown link: [A-Za-z0-9._-]. */
export function safeFileName(original) {
    const base = path.basename(String(original || "").replace(/\\/g, "/"))
    const ext = extOf(base)
    const stem = (ext ? base.slice(0, -(ext.length + 1)) : base)
        .normalize("NFKD")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^[-._]+|[-._]+$/g, "")
        .slice(0, MAX_STEM)
    return `${stem || "file"}${ext ? `.${ext}` : ""}`
}

/** The name with "-2", "-3"... before the extension until it is free. */
export function uniqueName(name, taken) {
    if (!taken.has(name.toLowerCase())) return name
    const ext = extOf(name)
    const stem = ext ? name.slice(0, -(ext.length + 1)) : name
    for (let n = 2; ; n++) {
        const next = `${stem}-${n}${ext ? `.${ext}` : ""}`
        if (!taken.has(next.toLowerCase())) return next
    }
}

const escLabel = (s) =>
    String(s)
        .replace(/[\r\n]+/g, " ")
        .replace(/([\\[\]*_`])/g, "\\$1")

/** The artifact line: images and videos embedded, other files linked. */
export function attachmentLine(label, name) {
    const kind = fileKind(name)
    const bang = kind === "image" || kind === "video" ? "!" : ""
    return `- ${bang}[${escLabel(label || name)}](${FILES_DIR}/${name})`
}

/** Matches the attachment line(s) of `name`, as attachmentLine writes them. */
const lineRe = (name) =>
    new RegExp(
        `^\\s*[-*+]\\s+!?\\[.*\\]\\(<?${FILES_DIR}/${name.replace(/\./g, "\\.")}>?\\)\\s*$`
    )

/** True for a stored file name (no paths, no temp files). */
export function isFileName(name) {
    return (
        typeof name === "string" &&
        NAME_RE.test(name) &&
        !name.endsWith(TEMP_SUFFIX)
    )
}

const urlOf = (name) => `${FILES_DIR}/${name}`

/** "files/<name>" -> name, else null. */
export function fileNameOfUrl(url) {
    const u = String(url || "")
    return u.startsWith(`${FILES_DIR}/`) ? u.slice(FILES_DIR.length + 1) : null
}

/**
 * @param {{ tasksDir: string, store: object, maxBytes?: number,
 *           allowedRoots?: string[], clock?: object, log?: object }} deps
 *   allowedRoots: folders a local file may be attached from (cc_attach_file)
 */
export function createTaskFiles({
    tasksDir,
    store,
    maxBytes = DEFAULT_MAX_BYTES,
    allowedRoots = [],
    clock = systemClock,
    log = nullLogger,
}) {
    const dirOf = (id) => path.join(tasksDir, taskDirName(id), FILES_DIR)

    function tooLarge() {
        return new AppError(
            "file_too_large",
            `file is larger than ${Math.round(maxBytes / 1048576)} MB`,
            { status: 413, details: { max_bytes: maxBytes } }
        )
    }

    /** Stream into `tmp`, failing past maxBytes; returns the size. */
    async function receive(stream, tmp) {
        let size = 0
        const counter = new Transform({
            transform(chunk, enc, cb) {
                size += chunk.length
                if (size > maxBytes) cb(tooLarge())
                else cb(null, chunk)
            },
        })
        await pipeline(stream, counter, fs.createWriteStream(tmp))
        return size
    }

    async function takenNames(id, task) {
        let onDisk = []
        try {
            onDisk = await fs.promises.readdir(dirOf(id))
        } catch {
            // no files yet
        }
        const linked = (task.links || [])
            .map((l) => (l.type === "file" ? fileNameOfUrl(l.url) : null))
            .filter(Boolean)
        return new Set([...onDisk, ...linked].map((n) => n.toLowerCase()))
    }

    function entry(id, link, size) {
        const name = fileNameOfUrl(link.url)
        return {
            name,
            label: link.label || name,
            url: link.url,
            path: path.join(dirOf(id), name),
            size: size ?? link.size ?? null,
            mime: mimeOf(name),
            kind: fileKind(name),
            added_by: link.added_by,
            at: link.at,
        }
    }

    /**
     * Attach a file from a stream.
     * @param {number} id
     * @param {{ name: string, stream: import("node:stream").Readable,
     *           actor: string, size?: number, label?: string }} file
     *   size: the announced length (Content-Length), checked up front;
     *   label: shown instead of the original name
     * @returns {Promise<object>} the file entry (as list() returns it)
     */
    async function add(id, { name, stream, actor, size: announced, label }) {
        const original = String(name || "").trim()
        if (!original) throw new ValidationError("file name is required")
        if (Number.isFinite(announced) && announced > maxBytes) throw tooLarge()
        await store.getTask(id) // 404 for an unknown task
        const dir = dirOf(id)
        await fs.promises.mkdir(dir, { recursive: true })
        // a dot-name ending in TEMP_SUFFIX: never committed, removed by
        // store.recover() after a crash
        const tmp = path.join(
            dir,
            `.upload-${crypto.randomBytes(6).toString("hex")}${TEMP_SUFFIX}`
        )
        try {
            const size = await receive(stream, tmp)
            return await store.withTaskLock(id, async () => {
                const { task } = await store.getTask(id)
                const stored = uniqueName(
                    safeFileName(original),
                    await takenNames(id, task)
                )
                const final = path.join(dir, stored)
                await fs.promises.rename(tmp, final)
                const link = {
                    id: newLinkId(),
                    type: "file",
                    url: urlOf(stored),
                    label: (
                        String(label || "").trim() || path.basename(original)
                    ).slice(0, 200),
                    role: null,
                    size,
                    mime: mimeOf(stored),
                    added_by: actor,
                    at: clock.now().toISOString(),
                }
                try {
                    await store.updateTask(
                        id,
                        { links: [...(task.links || []), link] },
                        { actor, reason: `attached ${stored}` }
                    )
                } catch (err) {
                    // not recorded: don't leave an unlisted file behind
                    await fs.promises.rm(final, { force: true })
                    throw err
                }
                // The file and its link are saved: the attachment exists. A
                // failed Attachments line or event is logged, not an error
                // (a retried upload would only make a second copy).
                try {
                    await store.updateArtifactSection(
                        id,
                        {
                            section: ATTACHMENTS_SECTION,
                            op: "append",
                            content: attachmentLine(link.label, stored),
                        },
                        actor
                    )
                    await store.appendEvent(
                        id,
                        {
                            type: "file_attached",
                            data: { name: stored, label: link.label, size },
                        },
                        actor
                    )
                } catch (err) {
                    log.warn(
                        { task_id: id, name: stored, err: err.message },
                        "file attached, but not listed in the artifact"
                    )
                }
                log.info({ task_id: id, name: stored, size }, "file attached")
                return { ...entry(id, link, size), missing: false }
            })
        } finally {
            await fs.promises.rm(tmp, { force: true })
        }
    }

    const within = (file, root) =>
        file === root || file.startsWith(root.endsWith("/") ? root : `${root}/`)

    /**
     * Attach a local file (worker agents). Its real path must be a regular
     * file under one of allowedRoots, so an agent can't copy any of the
     * user's files into a (possibly shared) task.
     */
    async function addFromPath(id, srcPath, { actor, label } = {}) {
        if (typeof srcPath !== "string" || !path.isAbsolute(srcPath))
            throw new ValidationError("path must be an absolute path")
        let real
        try {
            real = await fs.promises.realpath(srcPath)
        } catch {
            throw new NotFoundError(`file ${srcPath}`)
        }
        const roots = []
        for (const r of allowedRoots) {
            try {
                roots.push(await fs.promises.realpath(r))
            } catch {
                // a root that does not exist allows nothing
            }
        }
        if (!roots.some((r) => within(real, r)))
            throw new AppError(
                "path_not_allowed",
                `only files under ${allowedRoots.join(", ")} can be attached`,
                { status: 403 }
            )
        const st = await fs.promises.stat(real)
        if (!st.isFile()) throw new ValidationError("path is not a file")
        return add(id, {
            name: path.basename(real),
            label,
            stream: fs.createReadStream(real),
            actor,
            size: st.size,
        })
    }

    /** The task's attachments in link order; missing ones flagged. */
    async function list(id, task) {
        const t = task || (await store.getTask(id)).task
        const out = []
        for (const l of t.links || []) {
            const name = l.type === "file" ? fileNameOfUrl(l.url) : null
            if (!isFileName(name)) continue
            let size = null
            let missing = false
            try {
                size = (await fs.promises.stat(path.join(dirOf(id), name))).size
            } catch {
                missing = true
            }
            out.push({ ...entry(id, l, size), missing })
        }
        return out
    }

    /** Path and type of one stored file (404 when it is not there). */
    async function open(id, name) {
        if (!isFileName(name)) throw new NotFoundError("file")
        const file = path.join(dirOf(id), name)
        let st
        try {
            st = await fs.promises.stat(file)
        } catch {
            throw new NotFoundError("file")
        }
        if (!st.isFile()) throw new NotFoundError("file")
        return { path: file, mime: mimeOf(name), kind: fileKind(name) }
    }

    /** Delete the file, its link and its Attachments line(s). */
    async function remove(id, name, actor) {
        if (!isFileName(name)) throw new NotFoundError("file")
        return store.withTaskLock(id, async () => {
            const { task } = await store.getTask(id)
            const url = urlOf(name)
            const all = task.links || []
            const links = all.filter(
                (l) => !(l.type === "file" && l.url === url)
            )
            const file = path.join(dirOf(id), name)
            const exists = fs.existsSync(file)
            if (links.length === all.length && !exists)
                throw new NotFoundError("file")
            if (links.length !== all.length)
                await store.updateTask(
                    id,
                    { links },
                    { actor, reason: `removed ${name}` }
                )
            const art = await store.getArtifact(id)
            const re = lineRe(name)
            const next = art.content
                .split("\n")
                .filter((line) => !re.test(line))
                .join("\n")
            if (next !== art.content)
                await store.writeArtifact(id, next, {
                    actor,
                    baseRevision: art.revision,
                })
            await fs.promises.rm(file, { force: true })
            await store.appendEvent(
                id,
                { type: "file_removed", data: { name } },
                actor
            )
            log.info({ task_id: id, name }, "file removed")
            return { removed: name }
        })
    }

    return { add, addFromPath, list, open, remove, dirOf }
}
