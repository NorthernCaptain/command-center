/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useState } from "react"
import { api as defaultApi } from "../lib/api.js"
import { localDate } from "../lib/digest.js"

/** Default range: the last 90 days up to today (local dates). */
export function defaultRange(now = new Date()) {
    const from = new Date(now)
    from.setDate(from.getDate() - 90)
    return { from: localDate(from), to: localDate(now) }
}

/**
 * SOC2 evidence export: a date range and a format, opened from
 * GET /api/soc2/export?from&to&format in a new tab (the browser downloads
 * or shows it; the session cookie authenticates it).
 */
export default function Soc2Export({ api = defaultApi, open }) {
    const [range, setRange] = useState(() => defaultRange())
    const [format, setFormat] = useState("md")
    const invalid = !range.from || !range.to || range.from > range.to

    function exportNow(e) {
        e.preventDefault()
        if (invalid) return
        const url = api.soc2ExportUrl({ ...range, format })
        const openFn = open || ((u) => window.open(u, "_blank", "noopener"))
        openFn(url)
    }

    return (
        <form className="soc2-export" onSubmit={exportNow}>
            <p className="muted">
                Change records, PRs and decisions of SOC2-area tasks finished in
                the range.
            </p>
            <div className="field-grid">
                <label className="field">
                    <span>From</span>
                    <input
                        className="input"
                        type="date"
                        value={range.from}
                        max={range.to || undefined}
                        onChange={(e) =>
                            setRange((r) => ({ ...r, from: e.target.value }))
                        }
                    />
                </label>
                <label className="field">
                    <span>To</span>
                    <input
                        className="input"
                        type="date"
                        value={range.to}
                        min={range.from || undefined}
                        onChange={(e) =>
                            setRange((r) => ({ ...r, to: e.target.value }))
                        }
                    />
                </label>
                <label className="field">
                    <span>Format</span>
                    <select
                        className="input"
                        value={format}
                        onChange={(e) => setFormat(e.target.value)}
                    >
                        <option value="md">Markdown</option>
                        <option value="json">JSON</option>
                    </select>
                </label>
            </div>
            {invalid ? (
                <p className="field-hint error-text" role="alert">
                    Pick a start date on or before the end date.
                </p>
            ) : null}
            <div className="form-actions">
                <button
                    type="submit"
                    className="btn btn-accent"
                    disabled={invalid}
                >
                    Export evidence
                </button>
            </div>
        </form>
    )
}
