/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Task attachments in the browser: where a stored file is served, how it is
// shown (same kinds as server/src/files/taskFiles.js), sizes and names.

const KINDS = {
    image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"],
    video: ["mp4", "m4v", "mov", "webm"],
    audio: ["mp3", "m4a", "wav", "ogg"],
    markdown: ["md", "markdown"],
    pdf: ["pdf"],
    text: ["txt", "log", "csv", "tsv", "json", "yaml", "yml", "xml"],
}
const BY_EXT = Object.fromEntries(
    Object.entries(KINDS).flatMap(([kind, exts]) => exts.map((e) => [e, kind]))
)

/** image | video | audio | markdown | pdf | text | other */
export function fileKind(name) {
    const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name || ""))
    return (m && BY_EXT[m[1].toLowerCase()]) || "other"
}

/** Where the server serves a stored file (download=true: as a download). */
export function fileHref(taskId, name, { download = false } = {}) {
    return (
        `/api/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(name)}` +
        (download ? "?download=1" : "")
    )
}

/** "files/<name>" (an artifact or link URL) -> name, else null. */
export function fileNameOfUrl(url) {
    const m = /^files\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(String(url || ""))
    return m ? m[1] : null
}

/** 1536 -> "1.5 KB". */
export function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return ""
    if (bytes < 1024) return `${bytes} B`
    const units = ["KB", "MB", "GB"]
    let v = bytes / 1024
    let i = 0
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i++
    }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

const pad = (n) => String(n).padStart(2, "0")

/**
 * A pasted clipboard file (screenshots come as "image.png") gets a dated
 * name: "pasted-20261110-213045.png".
 */
export function pastedFile(file, now = new Date()) {
    const ext = (/\.([A-Za-z0-9]{1,10})$/.exec(file.name || "") || [])[1]
    const type = String(file.type || "").split("/")[1]
    const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
        `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const name = `pasted-${stamp}.${(ext || type || "bin").toLowerCase()}`
    return new File([file], name, { type: file.type })
}

/** The file entry for a name (from the task payload's files), or a stub. */
export function fileEntry(files, name) {
    return (
        (files || []).find((f) => f.name === name) || {
            name,
            label: name,
            kind: fileKind(name),
        }
    )
}
