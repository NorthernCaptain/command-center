/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useRef, useState } from "react"
import { api } from "../lib/api.js"
import { AREAS, KIND_LABELS, KINDS, taskKey } from "../lib/constants.js"
import { localInputToIso } from "../lib/time.js"
import { useToast } from "./Toasts.jsx"
import TextBox, { submitHint } from "./TextBox.jsx"

const URL_RE = /^https?:\/\/\S+$/i

/** Build the POST /api/tasks body from the capture text + optional form. */
export function buildCreatePayload(text, form) {
    const trimmed = text.trim()
    const payload = { text: trimmed }
    if (URL_RE.test(trimmed)) payload.url = trimmed
    if (form) {
        if (form.area) payload.area = form.area
        if (form.kind) payload.kind = form.kind
        const due = localInputToIso(form.due)
        if (due) payload.due_at = due
        if (form.wants_asana) payload.wants_asana = true
    }
    return payload
}

const EMPTY_FORM = { area: "", kind: "", due: "", wants_asana: false }

/**
 * Capture box. Enter creates a task, Shift+Enter opens the full form,
 * a ">" prefix or Cmd/Ctrl+Enter sends the text to the center agent.
 */
export default function CaptureBox({ onCreated, onCommand }) {
    const toast = useToast()
    const [text, setText] = useState("")
    const [busy, setBusy] = useState(false)
    const [expanded, setExpanded] = useState(false)
    const [form, setForm] = useState(EMPTY_FORM)
    const ref = useRef(null)
    const isCommand = text.trimStart().startsWith(">")

    async function create() {
        if (!text.trim() || busy) return
        setBusy(true)
        try {
            const res = await api.createTask(
                buildCreatePayload(text, expanded ? form : null)
            )
            const task = res && res.task
            toast.success(
                task
                    ? `Captured ${taskKey(task.id)} · ${task.title}`
                    : "Captured"
            )
            setText("")
            setForm(EMPTY_FORM)
            setExpanded(false)
            if (onCreated) onCreated(task)
        } catch (err) {
            toast.error(err)
        } finally {
            setBusy(false)
        }
    }

    async function command() {
        const body = text.trim().replace(/^>\s*/, "")
        if (!body || busy) return
        setBusy(true)
        try {
            const res = await api.command(body)
            setText("")
            if (onCommand) onCommand(res && res.job, body)
        } catch (err) {
            toast.error(err)
        } finally {
            setBusy(false)
        }
    }

    // Enter = newline; Cmd/Ctrl+Enter submits (a leading ">" = command).
    function submit() {
        if (isCommand) command()
        else create()
    }

    return (
        <form
            className={`capture${isCommand ? " is-command" : ""}${expanded ? " is-expanded" : ""}`}
            onSubmit={(e) => {
                e.preventDefault()
                if (isCommand) command()
                else create()
            }}
        >
            <div className="capture-line">
                <span className="capture-prompt" aria-hidden="true">
                    {isCommand ? "›" : "+"}
                </span>
                <TextBox
                    ref={ref}
                    className="capture-input"
                    aria-label="Capture a task"
                    placeholder="Paste a Slack link, or type a task or reminder…"
                    value={text}
                    disabled={busy}
                    onChange={(e) => setText(e.target.value)}
                    onSubmit={submit}
                />
                <button
                    type="submit"
                    className="btn btn-accent capture-send"
                    disabled={busy || !text.trim()}
                    aria-label={
                        isCommand ? "Send to center agent" : "Create task"
                    }
                >
                    {busy ? (
                        <span className="spinner" aria-hidden="true" />
                    ) : (
                        "⏎"
                    )}
                </button>
            </div>
            <div className="capture-hints" aria-hidden="true">
                {isCommand ? (
                    <span className="hint hint-command">
                        Command · the center agent acts on the whole board
                    </span>
                ) : (
                    <>
                        <span className="hint">
                            <kbd>{submitHint()}</kbd> capture
                        </span>
                        <span className="hint">
                            <kbd>&gt;</kbd> command
                        </span>
                        <button
                            type="button"
                            className="hint-link"
                            onClick={() => setExpanded((v) => !v)}
                        >
                            {expanded ? "fewer options" : "more options"}
                        </button>
                    </>
                )}
            </div>
            {expanded && !isCommand ? (
                <div className="capture-form">
                    <label className="field">
                        <span>Area</span>
                        <select
                            className="input"
                            value={form.area}
                            onChange={(e) =>
                                setForm({ ...form, area: e.target.value })
                            }
                        >
                            <option value="">auto</option>
                            {AREAS.map((a) => (
                                <option key={a} value={a}>
                                    {a}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>Kind</span>
                        <select
                            className="input"
                            value={form.kind}
                            onChange={(e) =>
                                setForm({ ...form, kind: e.target.value })
                            }
                        >
                            <option value="">auto</option>
                            {KINDS.map((k) => (
                                <option key={k} value={k}>
                                    {KIND_LABELS[k]}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>Due</span>
                        <input
                            type="datetime-local"
                            className="input"
                            value={form.due}
                            onChange={(e) =>
                                setForm({ ...form, due: e.target.value })
                            }
                        />
                    </label>
                    <label className="field field-check">
                        <input
                            type="checkbox"
                            checked={form.wants_asana}
                            onChange={(e) =>
                                setForm({
                                    ...form,
                                    wants_asana: e.target.checked,
                                })
                            }
                        />
                        <span>Create in Asana</span>
                    </label>
                    <div className="capture-form-actions">
                        <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => setExpanded(false)}
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className="btn btn-accent"
                            disabled={busy || !text.trim()}
                        >
                            Create task
                        </button>
                    </div>
                </div>
            ) : null}
        </form>
    )
}
