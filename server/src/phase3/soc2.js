/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// SOC2 change records. Tasks in SOC2_AREAS (infra, access, security, soc2)
// cannot move to done until the artifact's "Change record (SOC2)" section
// has non-empty What / Why / Risk / Rollback / Tested lines. The evidence
// export collects the done tasks of a date range with their change record,
// PRs, Asana link and decisions (JSON or Markdown).

import { SOC2_AREAS, getSectionBody } from "../store/artifact.js"
import { systemClock } from "../util/clock.js"
import { AppError, ValidationError } from "../util/errors.js"
import { queryAll } from "./stale.js"

export const SOC2_SECTION = "Change record (SOC2)"
/** Required labels, in display order. */
export const REQUIRED_FIELDS = ["what", "why", "risk", "rollback", "tested"]
const LABELS = {
    what: "What",
    why: "Why",
    risk: "Risk",
    rollback: "Rollback",
    tested: "Tested",
    approved_by: "Approved by",
    evidence: "Evidence",
}
/** Values that only hold a template placeholder count as empty. */
const PLACEHOLDERS = new Set(["…", "...", "tbd", "-", "—", "todo"])
// "- What: x", "* **What:** x", "**What**: x", "What: x"
const LINE_RE =
    /^\s*(?:[-*+]\s+)?(?:\*\*|__)?([A-Za-z][A-Za-z /&]{0,40}?)\s*(?::\s*(?:\*\*|__)|(?:\*\*|__)\s*:|:)(.*)$/
const DAY_MS = 86400000

const fieldKey = (label) =>
    label
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[^a-z_]/g, "")

function cleanValue(raw) {
    const v = raw
        .replace(/<!--.*?-->/g, "")
        .trim()
        .replace(/^(\*\*|__)|(\*\*|__)$/g, "")
        .trim()
    return PLACEHOLDERS.has(v.toLowerCase()) ? "" : v
}

/** True when the task's area needs a change record before done. */
export function requiresChangeRecord(task) {
    return Boolean(task) && SOC2_AREAS.includes(task.area)
}

function contentOf(artifact) {
    if (typeof artifact === "string") return artifact
    return (artifact && artifact.content) || ""
}

/**
 * Parse the "Change record (SOC2)" section.
 * @param {string|{content:string}} artifact
 * @returns {{ present: boolean, fields: Record<string,string>,
 *             missing: string[] }} fields keyed by lower_snake label
 *   (what, why, risk, rollback, tested, approved_by, evidence, ...);
 *   missing lists the required labels without a value.
 */
export function parseChangeRecord(artifact) {
    const body = getSectionBody(contentOf(artifact), SOC2_SECTION)
    const fields = {}
    if (body !== null) {
        for (const line of body.split("\n")) {
            const m = LINE_RE.exec(line)
            if (!m) continue
            const key = fieldKey(m[1])
            if (!key) continue
            const value = cleanValue(m[2])
            // The first non-empty value wins (duplicate labels).
            if (!fields[key]) fields[key] = value
        }
    }
    const missing = REQUIRED_FIELDS.filter((k) => !fields[k])
    return { present: body !== null, fields, missing }
}

/**
 * Throw 409 change_record_missing when a SOC2-area task's artifact lacks a
 * complete change record. No-op for other areas.
 */
export function assertChangeRecord(task, artifact) {
    if (!requiresChangeRecord(task)) return
    const { present, missing } = parseChangeRecord(artifact)
    if (!missing.length) return
    const labels = missing.map((k) => LABELS[k])
    throw new AppError(
        "change_record_missing",
        `T-${task.id} (${task.area}) needs a SOC2 change record before done: ` +
            `fill ${labels.join(", ")} in "${SOC2_SECTION}"` +
            (present ? "" : " (section missing)"),
        { status: 409, details: { missing, section: SOC2_SECTION } }
    )
}

/**
 * Load the artifact and assert. Used by the done paths that only hold a
 * store (app, close_out, command).
 */
export async function assertTaskChangeRecord(store, task) {
    if (!requiresChangeRecord(task)) return
    assertChangeRecord(task, await store.getArtifact(task.id))
}

// ---- evidence export ----------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** Parse a range bound: ISO datetime, or YYYY-MM-DD (local midnight). */
export function parseBound(value, name, { endOfDay = false } = {}) {
    if (value === undefined || value === null || value === "") return null
    const s = String(value).trim()
    let d
    if (DATE_ONLY.test(s)) {
        const [y, m, day] = s.split("-").map(Number)
        d = new Date(y, m - 1, day + (endOfDay ? 1 : 0))
    } else {
        d = new Date(s)
    }
    if (Number.isNaN(d.getTime()))
        throw new ValidationError(`invalid ${name}`, { [name]: value })
    return d
}

function decisionsOf(content) {
    const body = getSectionBody(content, "Decisions")
    if (!body) return ""
    return body.replace(/<!--[\s\S]*?-->/g, "").trim()
}

function prsOf(task) {
    const out = []
    const seen = new Set()
    for (const d of task.deliverables || []) {
        if (!d.pr || seen.has(d.pr)) continue
        seen.add(d.pr)
        out.push({ url: d.pr, merged_at: d.merged_at || null })
    }
    for (const l of task.links || []) {
        if (l.type !== "pr" || seen.has(l.url)) continue
        seen.add(l.url)
        out.push({ url: l.url, merged_at: null })
    }
    return out
}

/**
 * @param {{ store: object, clock?: object }} deps
 */
export function createSoc2({ store, clock = systemClock }) {
    function doneTasks(from, areas) {
        return queryAll(store, {
            status: "done",
            area: areas,
            done_since: from.toISOString(),
        })
    }

    /**
     * Evidence for the done tasks of [from, to).
     * @param {{ from?: string, to?: string, areas?: string[] }} opts
     *   from defaults to 90 days before `to`; to defaults to now.
     */
    async function exportEvidence({ from, to, areas } = {}) {
        const now = clock.now()
        const toDate = parseBound(to, "to", { endOfDay: true }) || now
        const fromDate =
            parseBound(from, "from") || new Date(toDate.getTime() - 90 * DAY_MS)
        if (fromDate > toDate)
            throw new ValidationError("from must be before to", { from, to })
        const wanted =
            Array.isArray(areas) && areas.length
                ? areas.filter((a) => SOC2_AREAS.includes(a))
                : SOC2_AREAS
        if (!wanted.length)
            throw new ValidationError("no SOC2 area selected", { areas })

        const rows = (await doneTasks(fromDate, wanted)).filter((t) => {
            const at = new Date(t.done_at).getTime()
            return at >= fromDate.getTime() && at < toDate.getTime()
        })
        const tasks = []
        for (const row of rows) {
            const { task } = await store.getTask(row.id)
            const { content } = await store.getArtifact(row.id)
            const record = parseChangeRecord(content)
            tasks.push({
                id: task.id,
                title: task.title,
                area: task.area,
                status: task.status,
                done_at: task.done_at,
                change_record: { ...record.fields, missing: record.missing },
                prs: prsOf(task),
                asana_url: (task.asana && task.asana.url) || null,
                decisions: decisionsOf(content),
            })
        }
        tasks.sort(
            (a, b) =>
                String(a.done_at).localeCompare(String(b.done_at)) ||
                a.id - b.id
        )
        return {
            generated_at: now.toISOString(),
            from: fromDate.toISOString(),
            to: toDate.toISOString(),
            areas: wanted,
            tasks,
        }
    }

    return { exportEvidence }
}

function mdText(value) {
    return String(value ?? "")
        .replace(/\r\n?/g, "\n")
        .trim()
}

/** Markdown rendering of exportEvidence() output. */
export function toMarkdown(evidence) {
    const lines = [
        "# SOC2 change evidence",
        "",
        `- Generated: ${evidence.generated_at}`,
        `- Range: ${evidence.from} → ${evidence.to}`,
        `- Areas: ${evidence.areas.join(", ")}`,
        `- Changes: ${evidence.tasks.length}`,
        "",
    ]
    for (const t of evidence.tasks) {
        lines.push(`## T-${t.id} — ${mdText(t.title)}`, "")
        lines.push(`- Area: ${t.area} · Status: ${t.status}`)
        lines.push(`- Done: ${t.done_at || "—"}`)
        if (t.asana_url) lines.push(`- Asana: ${t.asana_url}`)
        lines.push("", "### Change record", "")
        const rec = t.change_record || {}
        for (const key of Object.keys(LABELS)) {
            if (key in rec || REQUIRED_FIELDS.includes(key))
                lines.push(`- ${LABELS[key]}: ${mdText(rec[key]) || "—"}`)
        }
        for (const [key, value] of Object.entries(rec)) {
            if (key === "missing" || key in LABELS) continue
            lines.push(`- ${key}: ${mdText(value) || "—"}`)
        }
        if (rec.missing && rec.missing.length)
            lines.push(
                `- **Missing:** ${rec.missing.map((k) => LABELS[k]).join(", ")}`
            )
        lines.push("", "### Pull requests", "")
        if (t.prs.length) {
            for (const pr of t.prs)
                lines.push(
                    `- ${pr.url}${pr.merged_at ? ` (merged ${pr.merged_at})` : " (not merged)"}`
                )
        } else lines.push("- none")
        if (t.decisions) lines.push("", "### Decisions", "", t.decisions)
        lines.push("")
    }
    return lines.join("\n")
}
