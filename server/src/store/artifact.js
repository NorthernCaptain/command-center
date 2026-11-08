/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Pure helpers for artifact.md: the v1 template, "## " section parsing and
// section replace/append. Section names are stable ids; lookup ignores case.

import { taskKey } from "../contracts/schemas.js"

export const SOC2_AREAS = ["infra", "access", "security", "soc2"]
const SOC2_SECTION = "Change record (SOC2)"
const RESULT_SECTION = "Result"

const HEADING_RE = /^## +(.+?)[ \t]*#*[ \t]*$/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const TITLE_RE = /^# T-\d+ — .*$/
const LIST_ITEM_RE = /^\s*([-*+]|\d+[.)])\s/

/** First line of the artifact: "# T-123 — <title>". */
export function titleLine(id, title) {
    return `# ${taskKey(id)} — ${String(title).replace(/\s+/g, " ").trim()}`
}

/**
 * Split into "## " sections, ignoring headings inside fenced code blocks.
 * Returns [{ name, start, end, line }] where start/end are character offsets
 * ([start, end) covers the heading line and the body) and line is the
 * 1-based line number of the heading.
 */
export function parseSections(content) {
    const sections = []
    let offset = 0
    let fence = null
    const lines = content.split("\n")
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const fm = FENCE_RE.exec(line)
        if (fm) {
            const marker = fm[1]
            if (!fence) fence = marker
            else if (marker[0] === fence[0] && marker.length >= fence.length)
                fence = null
        } else if (!fence) {
            // "## Plan <!-- note -->" and "## Plan ##" are both "Plan".
            const hm = HEADING_RE.exec(line.replace(/<!--.*?-->/g, ""))
            if (hm) {
                if (sections.length) sections[sections.length - 1].end = offset
                sections.push({
                    name: hm[1].trim(),
                    start: offset,
                    end: content.length,
                    line: i + 1,
                })
            }
        }
        offset += line.length + 1
    }
    return sections
}

const norm = (s) => String(s).trim().toLowerCase()

export function findSection(content, name) {
    return parseSections(content).find((s) => norm(s.name) === norm(name))
}

/** Body text of a section (without its heading), or null when missing. */
export function getSectionBody(content, name) {
    const sec = findSection(content, name)
    if (!sec) return null
    const nl = content.indexOf("\n", sec.start)
    const bodyStart = nl === -1 || nl >= sec.end ? sec.end : nl + 1
    return content.slice(bodyStart, sec.end).trim()
}

function cleanBody(name, body) {
    let text = String(body ?? "").replace(/\r\n/g, "\n")
    const lines = text.split("\n")
    // Tolerate callers (LLMs) that repeat the heading.
    const first = lines.findIndex((l) => l.trim() !== "")
    if (first !== -1) {
        const hm = HEADING_RE.exec(lines[first])
        if (hm && norm(hm[1]) === norm(name)) lines.splice(0, first + 1)
    }
    text = lines.join("\n")
    return text.replace(/^\s*\n/, "").trimEnd()
}

function joinAppend(existing, addition) {
    if (!existing) return addition
    if (!addition) return existing
    const lastLine = existing.split("\n").pop()
    const firstLine = addition.split("\n")[0]
    const sep =
        LIST_ITEM_RE.test(lastLine) && LIST_ITEM_RE.test(firstLine)
            ? "\n"
            : "\n\n"
    return existing + sep + addition
}

/**
 * Replace or append the body of section `name`. A missing section is created
 * at the end of the document, before "## Result" when that exists.
 * @param {"replace"|"append"} op
 */
export function setSection(content, name, body, op = "replace") {
    const sectionName = String(name).trim()
    const text = cleanBody(sectionName, body)
    const sections = parseSections(content)
    const found = sections.find((s) => norm(s.name) === norm(sectionName))
    if (found) {
        const nl = content.indexOf("\n", found.start)
        const headEnd = nl === -1 || nl >= found.end ? found.end : nl
        const heading = content.slice(found.start, headEnd)
        const existing = content.slice(headEnd, found.end).trim()
        const nextBody = op === "append" ? joinAppend(existing, text) : text
        const isLast = found.end === content.length
        const block =
            `${heading}\n` +
            (nextBody ? `${nextBody}\n` : "") +
            (isLast ? "" : "\n")
        return content.slice(0, found.start) + block + content.slice(found.end)
    }
    const block = `## ${sectionName}\n${text ? `${text}\n` : ""}`
    const result =
        norm(sectionName) !== norm(RESULT_SECTION) &&
        sections.find((s) => norm(s.name) === norm(RESULT_SECTION))
    if (result) {
        return (
            content.slice(0, result.start) +
            block +
            "\n" +
            content.slice(result.start)
        )
    }
    const head = content.trimEnd()
    return (head ? `${head}\n\n` : "") + block
}

/** Rewrite the "# T-123 — title" line when present. */
export function setTitleLine(content, id, title) {
    const nl = content.indexOf("\n")
    const first = nl === -1 ? content : content.slice(0, nl)
    if (!TITLE_RE.test(first)) return content
    return titleLine(id, title) + (nl === -1 ? "" : content.slice(nl))
}

/** Artifact template v1 (docs/05-center-agent.md#artifact-template-v1). */
export function buildArtifactTemplate(task) {
    const src = task.source || {}
    const header = [
        `> **Source:** ${src.url || src.type || "manual"}` +
            ` · **Area:** ${task.area}`,
    ]
    const context =
        src.text && src.text.trim() !== task.title
            ? src.text
                  .trim()
                  .split("\n")
                  .map((l) => (l ? `> ${l}` : ">"))
                  .join("\n")
            : ""
    const sections = [
        ["Summary", ""],
        ["Context", context],
        ["Acceptance", ""],
        ["Plan", ""],
        ["Decisions", "<!-- date · author · decision · why -->"],
        ["Progress", "<!-- worker appends -->"],
        ["Links", "<!-- rendered from task links -->"],
    ]
    if (SOC2_AREAS.includes(task.area)) {
        sections.push([
            SOC2_SECTION,
            // Labels checked before done (phase3/soc2.js): What, Why, Risk,
            // Rollback, Tested must have a value.
            [
                "- What:",
                "- Why:",
                "- Risk:",
                "- Rollback:",
                "- Tested:",
                "- Approved by:",
                "- Evidence:",
            ].join("\n"),
        ])
    }
    sections.push(["PR feedback", "<!-- per PR and round -->"])
    sections.push([RESULT_SECTION, "<!-- filled by close_out -->"])

    const parts = [titleLine(task.id, task.title), "", ...header, ""]
    for (const [name, body] of sections) {
        parts.push(`## ${name}`)
        if (body) parts.push(body)
        parts.push("")
    }
    return parts.join("\n")
}
