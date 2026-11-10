/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// PR feedback items (folded: the latest state per item) for the side panel
// and the artifact's "PR feedback" section. The artifact keeps only a
// placeholder there; the list is filled at display time from the items
// the server sent, like the Links section.

import { withSection } from "./links.js"

export const FB_KIND_LABELS = {
    review_comment: "inline",
    review: "review",
    issue_comment: "comment",
    ci_failure: "CI",
}

export const FB_STATUS_LABELS = {
    open: "open",
    fixed: "fixed",
    answered: "answered",
    declined: "declined",
    no_action: "no action",
}

const byTime = (a, b) => String(a.at || "").localeCompare(String(b.at || ""))

/** Feedback items grouped by round, newest round first. */
export function groupRounds(items) {
    const byRound = new Map()
    for (const it of items || []) {
        const r = it.round || 1
        if (!byRound.has(r)) byRound.set(r, [])
        byRound.get(r).push(it)
    }
    return [...byRound.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([round, list]) => ({ round, items: [...list].sort(byTime) }))
}

/** "3 items · 1 open, 2 fixed" */
export function roundSummary(items) {
    const counts = {}
    for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1
    const parts = Object.keys(FB_STATUS_LABELS)
        .filter((s) => counts[s])
        .map((s) => `${counts[s]} ${FB_STATUS_LABELS[s]}`)
    const n = items.length
    return `${n} item${n === 1 ? "" : "s"}${parts.length ? ` · ${parts.join(", ")}` : ""}`
}

/**
 * Where the feedback stands: "addressed" once every item that needed work
 * is resolved, "open" while some still wait, null when nothing needed work.
 * -> { state, open, total, label }
 */
export function feedbackState(items) {
    const work = (items || []).filter((it) => it && it.actionable)
    if (!work.length) return null
    const open = work.filter((it) => it.status === "open").length
    const total = work.length
    if (open)
        return {
            state: "open",
            open,
            total,
            label: `${open} of ${total} feedback item${total === 1 ? "" : "s"} open`,
        }
    return {
        state: "addressed",
        open,
        total,
        label: `All feedback addressed (${total} item${total === 1 ? "" : "s"})`,
    }
}

const PR_RE = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/

// one line of GitHub text inside a list item (it is rendered as Markdown;
// raw HTML is escaped by the renderer)
const oneLine = (s, n = 280) => {
    const t = String(s || "")
        .replace(/\s+/g, " ")
        .trim()
    return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const dest = (u) => `<${String(u).replace(/[\s<>]/g, encodeURIComponent)}>`
const code = (s) => `\`${String(s).replace(/`/g, "'")}\``

function itemMarkdown(it) {
    const head = [
        `**${FB_STATUS_LABELS[it.status] || it.status}**`,
        FB_KIND_LABELS[it.kind] || it.kind,
        it.author ? `@${it.author}` : null,
        it.path ? code(`${it.path}${it.line ? `:${it.line}` : ""}`) : null,
    ]
        .filter(Boolean)
        .join(" · ")
    const refs = [
        it.url
            ? `[${it.kind === "ci_failure" ? "check" : "comment"}](${dest(it.url)})`
            : null,
        it.reply_url ? `[reply](${dest(it.reply_url)})` : null,
        it.commit ? code(String(it.commit).slice(0, 7)) : null,
    ].filter(Boolean)
    const lines = [`- ${head}${it.summary ? `: ${oneLine(it.summary)}` : ""}`]
    if (refs.length) lines.push(`  ${refs.join(" · ")}`)
    if (it.note) lines.push(`  ↳ ${oneLine(it.note, 400)}`)
    return lines.join("\n")
}

/**
 * Markdown for the "PR feedback" section: per PR, its rounds oldest first
 * (a document reads top to bottom), each item with status, place, summary,
 * links, commit and the agent's note. "" when there are no items.
 */
export function feedbackMarkdown(items) {
    const byPr = new Map()
    for (const it of items || []) {
        if (!it) continue
        const key = it.pr || ""
        if (!byPr.has(key)) byPr.set(key, [])
        byPr.get(key).push(it)
    }
    const out = []
    const st = feedbackState(items)
    if (st)
        out.push(
            st.state === "addressed" ? `**✓ ${st.label}**` : `**${st.label}**`
        )
    for (const [pr, list] of byPr) {
        const m = PR_RE.exec(pr)
        const title = m ? `${m[1]}#${m[2]}` : pr || "PR"
        out.push(pr ? `### [${title}](${dest(pr)})` : `### ${title}`)
        for (const r of groupRounds(list).reverse()) {
            out.push(`**Round ${r.round}** · ${roundSummary(r.items)}`)
            // replies and acknowledgements that needed nothing: one line
            // (the PR feedback tab lists them)
            const real = r.items.filter((it) => it.status !== "no_action")
            const quiet = r.items.length - real.length
            const lines = real.map(itemMarkdown)
            if (quiet)
                lines.push(
                    `- ${quiet} ${quiet === 1 ? "reply" : "replies"} that needed no action`
                )
            out.push(lines.join("\n"))
        }
    }
    return out.join("\n\n")
}

/** The artifact with its "## PR feedback" section filled from the items. */
export function withFeedbackSection(content, items) {
    return withSection(content, "PR feedback", feedbackMarkdown(items))
}
