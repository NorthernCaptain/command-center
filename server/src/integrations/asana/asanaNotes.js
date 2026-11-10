/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Asana rich text (html_notes) builders. Output uses only the tags Asana
// accepts (body strong em u s code a ul ol li blockquote pre h1 h2 hr), no
// HTML comments, and escapes &, <, > and quotes everywhere.

import { createHash } from "node:crypto"
import { taskKey } from "../../contracts/schemas.js"

// The managed block starts with this (a divider, then a small italic
// reference line). Asana rich text has no small font; italics after a
// divider is the closest to a reference note.
export const MANAGED_MARKER = "<hr/><em>Command Center:"
// Also matches the earlier "<hr/><h2>Command Center</h2>" block, so that
// one is replaced (not duplicated) on the next sync.
const MARKER_RE =
    /<hr\s*\/?>\s*(?:<h2>\s*Command Center\s*<\/h2>|<em>\s*Command Center:)/i
// Bumped when the block layout changes: every linked task re-syncs once.
const BLOCK_VERSION = 2

/** Escape text or attribute values for Asana rich text. */
export function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

function link(url, label = url) {
    return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`
}

/** decodeURIComponent that never throws (stray "%" stays as is). */
export function safeDecode(value) {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

function isHttpUrl(value) {
    return typeof value === "string" && /^https?:\/\//i.test(value)
}

/** https://github.com/<org>/<repo>/tree/<branch> (null without an org) */
export function branchUrl(repo, branch, org) {
    if (!org) return null
    const b = String(branch).split("/").map(encodeURIComponent).join("/")
    return `https://github.com/${org}/${encodeURIComponent(repo)}/tree/${b}`
}

export function repoUrl(repo, org) {
    if (!org) return null
    return `https://github.com/${org}/${encodeURIComponent(repo)}`
}

/** "https://github.com/org/repo/pull/12" -> "repo#12", else null. */
export function prLabel(url) {
    const m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/i.exec(String(url))
    return m ? `${m[1]}#${m[2]}` : null
}

// a Markdown link or a bare URL (trailing punctuation stays outside)
const LINK_RE =
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s<>()"'`]*[^\s<>()"'`.,;:!?]/g

function boldHtml(text) {
    return escapeHtml(text).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
}

/**
 * One line of the center agent's text -> Asana rich text: `code`,
 * **bold**, [label](url) and bare URLs as links; everything else escaped.
 */
export function inlineHtml(text) {
    return String(text ?? "")
        .split(/(`[^`\n]+`)/)
        .map((part) => {
            if (/^`[^`\n]+`$/.test(part))
                return `<code>${escapeHtml(part.slice(1, -1))}</code>`
            let out = ""
            let last = 0
            for (const m of part.matchAll(LINK_RE)) {
                out += boldHtml(part.slice(last, m.index))
                out += m[2] ? link(m[2], m[1]) : link(m[0])
                last = m.index + m[0].length
            }
            return out + boldHtml(part.slice(last))
        })
        .join("")
}

const clean = (items) =>
    (items || []).map((s) => String(s ?? "").trim()).filter(Boolean)

/**
 * The conclusion posted on the Asana task at close-out, as rich text
 * (`html_text`) or plain text. Empty string when there is nothing to say.
 * @param {{ outcome?: string, points?: string[], open_items?: string[] }} c
 * @returns {{ html: string, text: string }}
 */
export function buildConclusion(c = {}) {
    const outcome = String(c.outcome ?? "").trim()
    const points = clean(c.points)
    const open = clean(c.open_items)
    if (!outcome && !points.length) return { html: "", text: "" }
    const list = (items) =>
        `<ul>${items.map((i) => `<li>${inlineHtml(i)}</li>`).join("")}</ul>`
    const blocks = [
        ["Done", outcome, []],
        ["Details", "", points],
        ["Still open", "", open],
    ].filter(([, t, items]) => t || items.length)
    const html = blocks
        .map(
            ([title, t, items]) =>
                `<strong>${title}</strong>\n${t ? inlineHtml(t) : list(items)}`
        )
        .join("\n\n")
    const text = blocks
        .map(
            ([title, t, items]) =>
                `${title}\n${t || items.map((i) => `- ${i}`).join("\n")}`
        )
        .join("\n\n")
    return { html: `<body>${html}</body>`, text }
}

function paragraph(title, text) {
    const t = String(text ?? "").trim()
    if (!t) return ""
    return `<strong>${escapeHtml(title)}</strong>\n${escapeHtml(t)}\n\n`
}

/**
 * Description part of the Asana task (written once at creation).
 * @param {{ prose: { summary?: string, context?: string, acceptance?: string[],
 *           approach?: string }, sourceUrl?: string|null }} input
 * @returns {string} `<body>...</body>`
 */
export function buildDescriptionHtml({ prose = {}, sourceUrl = null } = {}) {
    let html = ""
    html += paragraph("Summary", prose.summary)
    const context = String(prose.context ?? "").trim()
    if (context || isHttpUrl(sourceUrl)) {
        html += "<strong>Context</strong>\n"
        if (context) html += `${escapeHtml(context)}\n`
        if (isHttpUrl(sourceUrl)) html += `Source: ${link(sourceUrl)}\n`
        html += "\n"
    }
    const acceptance = (prose.acceptance || [])
        .map((a) => String(a ?? "").trim())
        .filter(Boolean)
    if (acceptance.length) {
        html += "<strong>Acceptance</strong>\n<ul>"
        html += acceptance.map((a) => `<li>${escapeHtml(a)}</li>`).join("")
        html += "</ul>\n"
    }
    html += paragraph("Approach", prose.approach)
    return `<body>${html.replace(/\n+$/, "")}</body>`
}

/**
 * Branches and PRs referenced by a task, deduplicated.
 * @returns {{ repos: string[], branches: {repo: string|null, branch: string,
 *            url: string}[], prs: {url: string, label: string}[] }}
 */
export function collectRefs(task, { org = null } = {}) {
    const branches = []
    const prs = []
    const seen = new Set()
    const addBranch = (repo, branch, url) => {
        if (!url || seen.has(url)) return
        seen.add(url)
        branches.push({ repo, branch, url })
    }
    const addPr = (url, label) => {
        if (!isHttpUrl(url) || seen.has(url)) return
        seen.add(url)
        prs.push({ url, label: label || prLabel(url) || url })
    }
    for (const d of task?.deliverables || []) {
        if (d?.repo && d?.branch) {
            addBranch(d.repo, d.branch, branchUrl(d.repo, d.branch, org))
        }
        if (d?.pr) addPr(d.pr)
    }
    for (const l of task?.links || []) {
        if (l?.type === "branch" && isHttpUrl(l.url)) {
            const m = /github\.com\/[^/]+\/([^/]+)\/tree\/(.+)$/i.exec(l.url)
            addBranch(
                m ? m[1] : null,
                m ? safeDecode(m[2]) : l.label || l.url,
                l.url
            )
        } else if (l?.type === "pr") {
            addPr(l.url, l.label)
        }
    }
    const repos = []
    for (const r of task?.repos || []) {
        if (r?.name && !repos.includes(r.name)) repos.push(r.name)
    }
    return { repos, branches, prs }
}

/**
 * Hash of what the managed tracking block and the link attachments show
 * (status, repos, branches, PRs and the artifact URL, which is unknown until
 * the tailnet URL is detected). The sync job stores it as
 * asana.tracking_hash after a successful sync and skips tasks whose hash is
 * unchanged, so its own write (and unrelated edits) cause no Asana traffic.
 * updated_at is deliberately left out.
 */
/**
 * The Asana "Status" option for a command-center status (keys of
 * config.asana.statusField.options), or null to leave Asana's value alone
 * (waiting, review: nothing changed on the Asana side).
 */
const ASANA_STATUS = {
    inbox: "initial",
    ready: "initial",
    active: "in_progress",
    ready_for_pr: "code_review",
    pr_open: "code_review",
    pr_feedback: "code_review",
    done: "released",
    cancelled: "cancelled",
}

export function asanaStatusKey(status) {
    return ASANA_STATUS[status] || null
}

export function trackingFingerprint(task, artifactUrl = null, org = null) {
    const { repos, branches, prs } = collectRefs(task, { org })
    const key = JSON.stringify([
        BLOCK_VERSION, // a new block layout re-syncs every linked task
        task?.asana?.gid || null, // a re-link to another Asana task re-syncs
        org || null, // the repo / branch links point into this org
        // deliverable repos/branches as such: a branch-only change re-syncs
        // even when no URL can be built (no github.org)
        (task?.deliverables || []).map((d) => [d.repo, d.branch || null]),
        task?.status || null,
        // the Asana Status it maps to (added later: changes every hash once,
        // so already-linked tasks re-sync and get their Status set)
        asanaStatusKey(task?.status),
        artifactUrl || null,
        repos,
        branches.map((b) => b.url),
        prs.map((p) => p.url),
    ])
    return createHash("sha256").update(key).digest("hex").slice(0, 16)
}

/** "2026-11-12T14:05:00Z" -> "2026-11-12 14:05" in `timeZone` (default local). */
export function formatUpdated(iso, timeZone) {
    const d = new Date(iso)
    if (!iso || Number.isNaN(d.getTime())) return null
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-CA", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        })
            .formatToParts(d)
            .map((p) => [p.type, p.value])
    )
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

/**
 * Managed tracking block (regenerated on every sync). Starts with the
 * marker and is meant to sit at the end of <body>.
 * @param {{ task: object, artifactUrl?: string|null, timeZone?: string,
 *           marker?: string|null }} input marker: idempotency line written at
 *           creation ("Command-Center-Task: T-123 <nonce>", see asanaService).
 */
export function buildTrackingBlockHtml({
    task,
    artifactUrl = null,
    timeZone,
    marker = null,
    org = null,
} = {}) {
    const { repos, branches, prs } = collectRefs(task, { org })
    // line 1: Command Center: T-2 · artifact · status · updated
    const head = []
    if (task?.id) head.push(escapeHtml(taskKey(task.id)))
    if (isHttpUrl(artifactUrl)) head.push(link(artifactUrl, "artifact"))
    const status = escapeHtml(task?.status || "unknown")
    const updated = formatUpdated(task?.updated_at, timeZone)
    head.push(updated ? `${status} · updated ${escapeHtml(updated)}` : status)
    let html = `${MANAGED_MARKER} ${head.join(" · ")}</em>\n`

    // line 2: Repos: mobile, aws-lambda @ branch · PRs: repo#1
    const branchRepos = new Set(branches.map((b) => b.repo))
    const refs = branches.map((b) =>
        b.repo
            ? `${escapeHtml(b.repo)} @ ${link(b.url, b.branch)}`
            : link(b.url, b.branch)
    )
    for (const r of repos)
        if (!branchRepos.has(r)) {
            const url = repoUrl(r, org)
            refs.push(url ? link(url, r) : escapeHtml(r))
        }
    const parts = []
    if (refs.length) parts.push(`Repos: ${refs.join(", ")}`)
    if (prs.length)
        parts.push(`PRs: ${prs.map((p) => link(p.url, p.label)).join(", ")}`)
    if (parts.length) html += `<em>${parts.join(" · ")}</em>\n`
    if (marker) html += `<em>${escapeHtml(marker)}</em>`
    return html.replace(/\n$/, "")
}

/**
 * Replace (or append) the managed block in existing html_notes. Everything
 * before the marker is preserved verbatim.
 * @param {string|null} existingHtmlNotes
 * @param {string} blockHtml output of buildTrackingBlockHtml
 * @returns {string}
 */
export function mergeManagedBlock(existingHtmlNotes, blockHtml) {
    let html = String(existingHtmlNotes ?? "").trim()
    if (!/<body[\s>]/i.test(html)) html = `<body>${html}</body>`
    const close = html.toLowerCase().lastIndexOf("</body>")
    const inner = close >= 0 ? html.slice(0, close) : html
    const marker = MARKER_RE.exec(inner)
    const before = marker ? inner.slice(0, marker.index) : inner
    return `${before}${blockHtml}</body>`
}
