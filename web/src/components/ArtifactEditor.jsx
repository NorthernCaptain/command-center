/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

/**
 * Markdown editor with the 409 conflict flow.
 * editing = { text, baseRevision, baseContent, conflict: {content, revision}|null,
 *             saving, note, mine }
 * `mine` is my text from before a merge/overwrite; while it is set (until a
 * save succeeds) "Restore my text" brings it back.
 */
export default function ArtifactEditor({
    editing,
    onChange,
    onSave,
    onCancel,
    onReload,
    onMerge,
    onKeepMine,
    onRestoreMine,
}) {
    const { conflict } = editing
    const blocked = editing.saving || Boolean(conflict)
    const canRestore =
        typeof editing.mine === "string" && editing.mine !== editing.text
    return (
        <div className="editor">
            {conflict ? (
                <div className="conflict" role="alert">
                    <p className="conflict-title">
                        The artifact changed while you were editing.
                    </p>
                    <p className="muted">
                        Someone (usually an agent) saved revision{" "}
                        <code>{conflict.revision || "?"}</code>. Merge replays
                        your edits on top of it; where both changed the same
                        lines, both versions are kept between conflict markers.
                        Nothing is saved until you press Save.
                    </p>
                    <details className="conflict-current">
                        <summary>Show the current version</summary>
                        <pre>{conflict.content}</pre>
                    </details>
                    <div className="conflict-actions">
                        <button
                            type="button"
                            className="btn btn-accent btn-sm"
                            onClick={onMerge}
                        >
                            Merge my edits
                        </button>
                        <button
                            type="button"
                            className="btn btn-sm"
                            onClick={onKeepMine}
                        >
                            Keep mine (overwrite)
                        </button>
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={onReload}
                        >
                            Discard mine &amp; reload
                        </button>
                    </div>
                </div>
            ) : null}
            {editing.note || canRestore ? (
                <div className="editor-note" role="status">
                    {editing.note ? <span>{editing.note}</span> : null}
                    {canRestore ? (
                        <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={onRestoreMine}
                        >
                            Restore my text
                        </button>
                    ) : null}
                </div>
            ) : null}
            <textarea
                className="editor-text"
                aria-label="Artifact markdown"
                spellCheck
                value={editing.text}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        if (!blocked) onSave()
                    }
                }}
            />
            <div className="editor-actions">
                <span className="muted">
                    base <code>{editing.baseRevision || "—"}</code> · ⌘S saves
                </span>
                <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={onCancel}
                >
                    Cancel
                </button>
                <button
                    type="button"
                    className="btn btn-accent btn-sm"
                    onClick={onSave}
                    disabled={blocked}
                >
                    {editing.saving ? "Saving…" : "Save"}
                </button>
            </div>
        </div>
    )
}
