/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { fileHref, fileKind } from "../lib/files.js"
import { renderMarkdown } from "../lib/markdown.js"

/** Text of a stored file (markdown / text kinds), or an error. */
function useFileText(url, enabled, fetchImpl) {
    const [state, setState] = useState({ text: null, error: null })
    useEffect(() => {
        if (!enabled) return undefined
        let live = true
        setState({ text: null, error: null })
        const doFetch = fetchImpl || globalThis.fetch
        doFetch(url, { credentials: "same-origin" })
            .then(async (res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                const text = await res.text()
                if (live) setState({ text, error: null })
            })
            .catch((err) => {
                if (live)
                    setState({
                        text: null,
                        error: String((err && err.message) || err),
                    })
            })
        return () => {
            live = false
        }
    }, [url, enabled, fetchImpl])
    return state
}

/**
 * An attachment shown over the task page: images, videos and audio
 * inline, Markdown rendered, PDFs in the browser's viewer, text as text,
 * anything else as a download. Escape or the backdrop closes it.
 * file: { name, label?, kind? }
 */
export default function FileViewer({ taskId, file, onClose, fetchImpl }) {
    const kind = file.kind || fileKind(file.name)
    const src = fileHref(taskId, file.name)
    const textual = kind === "markdown" || kind === "text"
    const { text, error } = useFileText(src, textual, fetchImpl)
    const html = useMemo(
        () =>
            kind === "markdown" && text !== null
                ? renderMarkdown(text, {
                      filesBase: `/api/tasks/${encodeURIComponent(taskId)}/files/`,
                  })
                : null,
        [kind, text, taskId]
    )

    useEffect(() => {
        const onKey = (e) => {
            if (e.key === "Escape") onClose()
        }
        document.addEventListener("keydown", onKey)
        return () => document.removeEventListener("keydown", onKey)
    }, [onClose])

    let body
    if (kind === "image")
        body = <img className="fv-image" src={src} alt={file.label || ""} />
    else if (kind === "video")
        body = <video className="fv-video" src={src} controls autoPlay />
    else if (kind === "audio")
        body = <audio className="fv-audio" src={src} controls />
    else if (kind === "pdf")
        body = (
            <iframe
                className="fv-pdf"
                src={src}
                title={file.label || file.name}
            />
        )
    else if (textual) {
        if (error) body = <p className="muted">Can&apos;t load it: {error}</p>
        else if (text === null) body = <p className="muted">Loading…</p>
        else if (html !== null)
            body = (
                <article
                    className="artifact prose fv-markdown"
                    dangerouslySetInnerHTML={{ __html: html }}
                />
            )
        else body = <pre className="fv-text">{text}</pre>
    } else
        body = (
            <p className="muted">
                No preview for this file type. Download it to open it.
            </p>
        )

    return createPortal(
        <>
            <button
                type="button"
                className="fv-backdrop"
                aria-label="Close"
                tabIndex={-1}
                onClick={onClose}
            />
            <div
                className={`fv fv-${kind}`}
                role="dialog"
                aria-modal="true"
                aria-label={file.label || file.name}
            >
                <div className="fv-head">
                    <span className="fv-title">{file.label || file.name}</span>
                    <a
                        className="btn btn-ghost btn-sm"
                        href={src}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Open ↗
                    </a>
                    <a
                        className="btn btn-ghost btn-sm"
                        href={fileHref(taskId, file.name, { download: true })}
                        download={file.name}
                    >
                        Download
                    </a>
                    <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={onClose}
                        autoFocus
                    >
                        Close
                    </button>
                </div>
                <div className="fv-body">{body}</div>
            </div>
        </>,
        document.body
    )
}
