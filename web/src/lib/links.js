/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// One list of a task's links for the Links tab and the artifact's "Links"
// section: the capture source (e.g. the Slack thread) first, then
// task.links, without duplicate URLs. The artifact keeps only a placeholder
// in that section; it is filled here at display time, so a viewer only ever
// sees the links the server sent to them.

const SOURCE_LINK = {
    slack: { type: "slack", label: "Slack thread" },
    asana: { type: "asana", label: "Asana task" },
    github: { type: "other", label: "GitHub" },
}

const isWebUrl = (u) => /^https?:\/\//i.test(String(u || ""))

/** file:///… URL of an absolute local path (each segment encoded). */
export function fileUrl(p) {
    return `file://${String(p)
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/")}`
}

/**
 * Where a link points in the browser: web URLs as they are, absolute local
 * paths (repo folders) as file:// URLs, anything else null (not a link).
 */
export function hrefFor(url) {
    const u = String(url || "")
    if (isWebUrl(u) || /^file:\/\/\//i.test(u)) return u
    if (u.startsWith("/")) return fileUrl(u)
    return null
}

/** The capture source as a link, or null when it has no URL. */
export function sourceLink(task) {
    const src = task && task.source
    if (!src || !src.url) return null
    const kind = SOURCE_LINK[src.type] || { type: "other", label: "Source" }
    return {
        id: "source",
        type: kind.type,
        url: src.url,
        label: kind.label,
        role: null,
        source: true,
    }
}

/** Source link + task.links, first occurrence of each URL kept. */
export function allLinks(task) {
    const out = []
    const seen = new Set()
    const src = sourceLink(task)
    for (const l of [...(src ? [src] : []), ...((task && task.links) || [])]) {
        if (!l || !l.url || seen.has(l.url)) continue
        seen.add(l.url)
        out.push(l)
    }
    return out
}

const escLabel = (s) => String(s).replace(/([\\[\]*_`])/g, "\\$1")
const escCode = (s) => String(s).replace(/`/g, "'")
// <...> link destination: no "<", ">" or line breaks inside
const escDest = (u) =>
    String(u)
        .replace(/[\r\n]/g, "")
        .replace(/</g, "%3C")
        .replace(/>/g, "%3E")

/**
 * Markdown list of links: web URLs as links, local folders as file:// links
 * with the path shown as code, anything else as code; each with its type
 * (and role when set).
 */
export function linksMarkdown(links) {
    return (links || [])
        .map((l) => {
            const label = l.label || l.url
            const what = [l.type, l.role].filter(Boolean).join(" · ")
            const href = hrefFor(l.url)
            const text = href
                ? `[${escLabel(label)}](<${escDest(href)}>)` +
                  (href === l.url ? "" : ` \`${escCode(l.url)}\``)
                : `${escLabel(label)}: \`${escCode(l.url)}\``
            return `- ${text}${what ? ` · ${what}` : ""}`
        })
        .join("\n")
}

const LINKS_HEADING_RE = /^##[ \t]+Links[ \t]*$/m
const NEXT_H2_RE = /^##[ \t]+\S/m

/**
 * The artifact with its "## Links" section filled from `links` (display
 * only). Text already in the section stays (the template comment is not
 * rendered). Without such a section the list is added at the end; without
 * links the content is unchanged.
 */
export function withLinksSection(content, links) {
    const src = String(content || "")
    const list = linksMarkdown(links)
    if (!list) return src
    const m = LINKS_HEADING_RE.exec(src)
    if (!m) return `${src.replace(/\s*$/, "")}\n\n## Links\n\n${list}\n`
    const bodyStart = m.index + m[0].length
    const rest = src.slice(bodyStart)
    const next = NEXT_H2_RE.exec(rest)
    const bodyEnd = next ? bodyStart + next.index : src.length
    const body = src.slice(bodyStart, bodyEnd).replace(/\s*$/, "")
    const tail = src.slice(bodyEnd)
    return `${src.slice(0, bodyStart)}${body}\n\n${list}\n${tail ? `\n${tail}` : ""}`
}

const PR_URL_RE = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/

/**
 * The task's PRs (header, board rows): claimed deliverable PRs (with merged
 * state) plus any other "pr" links, one per URL.
 * -> [{ url, label: "repo#123", merged }]
 */
export function taskPrs(task) {
    const out = []
    const seen = new Set()
    const add = (url, merged) => {
        if (!url || seen.has(url)) return
        const m = PR_URL_RE.exec(url)
        if (!m) return
        seen.add(url)
        out.push({ url, label: `${m[1]}#${m[2]}`, merged: Boolean(merged) })
    }
    for (const d of (task && task.deliverables) || []) add(d.pr, d.merged_at)
    for (const l of (task && task.links) || [])
        if (l && l.type === "pr") add(l.url, false)
    return out
}
