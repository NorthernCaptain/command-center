/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useRef, useState } from "react"
import { ConfirmButton } from "./ConfirmDialog.jsx"
import { fileHref, formatSize } from "../lib/files.js"
import { relativeTime } from "../lib/time.js"

const KIND_GLYPH = {
    video: "▶",
    audio: "♪",
    markdown: "M↓",
    pdf: "PDF",
    text: "txt",
    other: "◆",
}

/**
 * The task's attachments: add (button or drop here; the task page also
 * takes drops and pasted screenshots), open in the viewer, download,
 * delete. files: entries from the task payload; onUpload(File[]),
 * onOpen(file), onDelete(file) -> Promise. canEdit: owner.
 */
export default function FilesPanel({
    taskId,
    files,
    onUpload,
    onOpen,
    onDelete,
    uploading = 0,
    canEdit = true,
}) {
    const list = files || []
    const input = useRef(null)
    const [over, setOver] = useState(false)

    function pick(e) {
        const chosen = [...(e.target.files || [])]
        e.target.value = ""
        if (chosen.length) onUpload(chosen)
    }

    const hasFiles = (e) =>
        [...((e.dataTransfer && e.dataTransfer.types) || [])].includes("Files")

    return (
        <div className="files">
            {canEdit ? (
                <div
                    className={`files-drop${over ? " is-over" : ""}`}
                    onDragOver={(e) => {
                        if (!hasFiles(e)) return
                        e.preventDefault()
                        setOver(true)
                    }}
                    onDragLeave={() => setOver(false)}
                    onDrop={(e) => {
                        setOver(false)
                        if (!hasFiles(e)) return
                        // handled: the task page (which also takes drops)
                        // only clears its drop hint
                        e.preventDefault()
                        const dropped = [...e.dataTransfer.files]
                        if (dropped.length) onUpload(dropped)
                    }}
                >
                    <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => input.current && input.current.click()}
                        disabled={uploading > 0}
                    >
                        {uploading > 0
                            ? `Uploading ${uploading}…`
                            : "Attach files"}
                    </button>
                    <span className="muted">
                        or drop them here, anywhere on the page, or paste a
                        screenshot
                    </span>
                    <input
                        ref={input}
                        type="file"
                        multiple
                        hidden
                        data-testid="file-input"
                        onChange={pick}
                    />
                </div>
            ) : null}
            {list.length ? (
                <ul className="file-list">
                    {list.map((f) => (
                        <li
                            key={f.name}
                            className={`file file-${f.kind}${f.missing ? " is-missing" : ""}`}
                        >
                            <button
                                type="button"
                                className="file-open"
                                onClick={() => onOpen(f)}
                                disabled={f.missing}
                                title={`Open ${f.label}`}
                            >
                                {f.kind === "image" && !f.missing ? (
                                    <img
                                        className="file-thumb"
                                        src={fileHref(taskId, f.name)}
                                        alt=""
                                        loading="lazy"
                                    />
                                ) : (
                                    <span
                                        className="file-glyph"
                                        aria-hidden="true"
                                    >
                                        {KIND_GLYPH[f.kind] || KIND_GLYPH.other}
                                    </span>
                                )}
                                <span className="file-label">{f.label}</span>
                            </button>
                            <span className="file-meta">
                                {f.missing
                                    ? "missing on disk"
                                    : formatSize(f.size)}
                                {f.at ? ` · ${relativeTime(f.at)}` : ""}
                                {f.added_by && f.added_by !== "me"
                                    ? ` · ${f.added_by}`
                                    : ""}
                            </span>
                            <span className="file-actions">
                                {f.missing ? null : (
                                    <a
                                        className="btn btn-ghost btn-xs"
                                        href={fileHref(taskId, f.name, {
                                            download: true,
                                        })}
                                        download={f.name}
                                    >
                                        Download
                                    </a>
                                )}
                                {canEdit ? (
                                    <ConfirmButton
                                        label="Delete"
                                        className="btn btn-ghost btn-xs"
                                        title={`Delete ${f.label}?`}
                                        confirmLabel="Delete"
                                        danger
                                        onConfirm={() => onDelete(f)}
                                    >
                                        <p>
                                            The file and its line in the
                                            artifact&apos;s Attachments section
                                            are removed. The task history keeps
                                            it.
                                        </p>
                                    </ConfirmButton>
                                ) : null}
                            </span>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="muted">No files yet.</p>
            )}
        </div>
    )
}
