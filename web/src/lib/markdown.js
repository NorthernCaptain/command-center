/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Artifact rendering. Every top-level block from an h2 up to the next h2 gets
// data-section="<h2 text>" so DOM selections map to an artifact section.
// Raw HTML is never rendered: markdown-it tokenizes HTML so that HTML
// comments (the artifact template's hints) can be dropped at token level,
// and every other HTML token is escaped and shown as text. Code spans and
// fences are tokenized first, so a literal `<!--` there is left alone.
// Remote images are not loaded (agents edit artifacts and could exfiltrate
// data through an image URL): they render as links instead.

import MarkdownIt from "markdown-it"

const TASK_RE = /^\[([ xX])\]\s+/
const LEADING_COMMENTS_RE = /^(?:\s*<!--[\s\S]*?-->)+/
const COMMENT_START_RE = /^ {0,3}<!--/
const SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i

/**
 * What an HTML block shows: its text with leading comments removed (null
 * when nothing is left). The rest is rendered as Markdown with HTML off.
 */
function htmlBlockText(content) {
    if (!COMMENT_START_RE.test(content)) return content
    const rest = content.replace(LEADING_COMMENTS_RE, "")
    return rest.trim() ? rest : null
}

/**
 * Core rule: data-section attributes and "- [ ]" task list items. HTML
 * blocks are parsed here (as escaped Markdown, see plain below) so a "## "
 * heading inside one still starts a section for the blocks after it.
 */
function sectionsRule(state) {
    const tokens = state.tokens
    let section = (state.env && state.env.ccSection) || null
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]
        if (tok.type === "html_block") {
            const text = htmlBlockText(tok.content)
            const env = { ccSection: section }
            tok.meta = { ccTokens: text === null ? [] : plain.parse(text, env) }
            if (text !== null) section = env.ccSectionEnd
        } else if (tok.type === "heading_open" && tok.tag === "h2") {
            const inline = tokens[i + 1]
            section = inline && inline.content ? inline.content.trim() : ""
        } else if (tok.type === "heading_open" && tok.tag === "h1") {
            section = null
        }
        if (tok.level === 0 && tok.nesting !== -1 && tok.block && section) {
            tok.attrSet("data-section", section)
        }
        if (tok.type === "list_item_open") {
            // tight list: list_item_open, paragraph_open, inline
            const inline = tokens[i + 2]
            if (inline && inline.type === "inline" && inline.children) {
                const first = inline.children[0]
                const m =
                    first &&
                    first.type === "text" &&
                    first.content.match(TASK_RE)
                if (m) {
                    const done = m[1].toLowerCase() === "x"
                    first.content =
                        (done ? "☑ " : "☐ ") + first.content.slice(m[0].length)
                    tok.attrJoin("class", done ? "task-item done" : "task-item")
                }
            }
        }
    }
    if (state.env) state.env.ccSectionEnd = section
}

/**
 * Inline rule (HTML off): drop complete "<!-- ... -->" comments instead of
 * showing them as text. Code spans are tokenized before this, so a literal
 * comment inside backticks stays visible.
 */
function commentRule(state, silent) {
    const { src, pos } = state
    if (!src.startsWith("<!--", pos)) return false
    const end = src.indexOf("-->", pos + 4)
    if (end < 0) return false
    if (!silent) state.push("cc_comment", "", 0)
    state.pos = end + 3
    return true
}

/** Same-origin URLs and data:image URLs may load; anything else may not. */
export function isLocalImageSrc(src) {
    const s = String(src || "").trim()
    if (!s) return false
    if (/^data:image\//i.test(s)) return true
    const loc = typeof window !== "undefined" ? window.location : null
    if (!loc || !loc.origin || loc.origin === "null") return !SCHEME_RE.test(s)
    try {
        return new URL(s, loc.href).origin === loc.origin
    } catch {
        return false
    }
}

/** Shared rules: safe links, images as links, sections and task items. */
function configure(md) {
    const esc = md.utils.escapeHtml
    // file:// links (local repo folders in the Links section) are allowed;
    // markdown-it's other blocked schemes (javascript:, vbscript:, data:)
    // stay blocked.
    const defaultValidate = md.validateLink.bind(md)
    md.validateLink = (url) =>
        /^file:\/\/\//i.test(String(url).trim()) || defaultValidate(url)
    const defaultLinkOpen =
        md.renderer.rules.link_open ||
        ((tokens, idx, options, env, self) =>
            self.renderToken(tokens, idx, options))
    md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        token.attrSet("target", "_blank")
        token.attrSet("rel", "noopener noreferrer")
        return defaultLinkOpen(tokens, idx, options, env, self)
    }

    const defaultImage = md.renderer.rules.image
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        const src = token.attrGet("src") || ""
        if (isLocalImageSrc(src))
            return defaultImage(tokens, idx, options, env, self)
        const alt = self.renderInlineAsText(token.children || [], options, env)
        const label = alt ? `${alt} (${src})` : src
        return (
            `<a href="${esc(src)}" class="img-link" target="_blank" ` +
            `rel="noopener noreferrer" title="Remote image (not loaded)">` +
            `${esc(label)}</a>`
        )
    }

    md.core.ruler.push("cc_sections", sectionsRule)
    return md
}

// Renders HTML tags as text; used for the content of HTML blocks so they
// look exactly like they would with HTML parsing disabled (minus comments).
const plain = configure(
    new MarkdownIt({ html: false, linkify: true, typographer: false })
)
plain.inline.ruler.before("autolink", "cc_comment", commentRule)
plain.renderer.rules.cc_comment = () => ""

const md = configure(
    new MarkdownIt({ html: true, linkify: true, typographer: false })
)

md.renderer.rules.html_inline = (tokens, idx) => {
    const content = tokens[idx].content
    if (content.startsWith("<!--") && content.endsWith("-->")) return ""
    return md.utils.escapeHtml(content)
}

// The block was parsed (as plain Markdown) by the sections rule.
md.renderer.rules.html_block = (tokens, idx, options, env) => {
    const meta = tokens[idx].meta
    if (!meta || !meta.ccTokens) return md.utils.escapeHtml(tokens[idx].content)
    return plain.renderer.render(meta.ccTokens, plain.options, env)
}

/** Markdown -> HTML string with section attributes. */
export function renderMarkdown(src) {
    return md.render(String(src || ""))
}

/** "## " section names in document order. */
export function sectionNames(src) {
    const names = []
    const collect = (tokens) => {
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i]
            if (tok.type === "html_block" && tok.meta && tok.meta.ccTokens)
                collect(tok.meta.ccTokens)
            else if (tok.type === "heading_open" && tok.tag === "h2")
                names.push(tokens[i + 1].content.trim())
        }
    }
    collect(md.parse(String(src || ""), {}))
    return names
}
