/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Read-only section helpers for the agent (prompt building, conflict checks
// in artifactEdits). They delegate to the store's parser so a heading such
// as "## Plan ##" or "## Plan <!-- note -->" means the same section here as
// in the store's writes.

import {
    getSectionBody,
    parseSections as parseStoreSections,
} from "../store/artifact.js"

/** Clean an LLM-given section name: no leading #s, no HTML comment. */
export function normalizeSectionName(name) {
    return String(name || "")
        .replace(/<!--.*?-->/g, "")
        .replace(/^#+\s*/, "")
        .trim()
}

/**
 * Split markdown into "## " sections (code fences are respected).
 * @returns {{ name: string, body: string }[]}
 */
export function parseSections(content) {
    const text = String(content || "")
    return parseStoreSections(text).map((s) => {
        const nl = text.indexOf("\n", s.start)
        const bodyStart = nl === -1 || nl >= s.end ? s.end : nl + 1
        return { name: s.name, body: text.slice(bodyStart, s.end).trim() }
    })
}

export function listSectionNames(content) {
    return parseSections(content).map((s) => s.name)
}

/** Body of a section (trimmed) or null when the section does not exist. */
export function sectionBody(content, name) {
    return getSectionBody(String(content || ""), normalizeSectionName(name))
}
