/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Comment anchoring: W3C text-quote selector + section hint.
//
// Text space: the concatenation of every text node under the rendered
// artifact root (markdown-it emits "\n" text nodes between blocks, which act
// as separators). Pure helpers work on (text, sections); DOM helpers build that
// text index from the rendered artifact and wrap located ranges in
// <mark data-comment-id>.

import DiffMatchPatch from "diff-match-patch"

export const CONTEXT_CHARS = 32
export const FUZZY_THRESHOLD = 0.3
const FUZZY_MIN_LENGTH = 4

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

function commonSuffixLength(a, b) {
    let n = 0
    while (
        n < a.length &&
        n < b.length &&
        a[a.length - 1 - n] === b[b.length - 1 - n]
    )
        n++
    return n
}

function commonPrefixLength(a, b) {
    let n = 0
    while (n < a.length && n < b.length && a[n] === b[n]) n++
    return n
}

/** Build an anchor from offsets into `text`. Trims surrounding whitespace. */
export function anchorFromOffsets(text, start, end, sections = []) {
    let s = Math.max(0, Math.min(start, end))
    let e = Math.min(text.length, Math.max(start, end))
    while (s < e && /\s/.test(text[s])) s++
    while (e > s && /\s/.test(text[e - 1])) e--
    if (s >= e) return null
    return {
        section: sectionAt(sections, s),
        exact: text.slice(s, e),
        prefix: text.slice(Math.max(0, s - CONTEXT_CHARS), s),
        suffix: text.slice(e, e + CONTEXT_CHARS),
    }
}

/** Name of the section containing `offset`, or null. */
export function sectionAt(sections, offset) {
    for (const sec of sections || []) {
        if (offset >= sec.start && offset < sec.end) return sec.name
    }
    return null
}

function findAll(haystack, needle, from = 0, to = haystack.length) {
    const out = []
    if (!needle) return out
    let i = haystack.indexOf(needle, from)
    while (i !== -1 && i + needle.length <= to) {
        out.push(i)
        i = haystack.indexOf(needle, i + 1)
    }
    return out
}

/** How well the text around [start,end) matches the anchor's context. */
export function contextScore(text, start, end, anchor) {
    const before = text.slice(Math.max(0, start - CONTEXT_CHARS), start)
    const after = text.slice(end, end + CONTEXT_CHARS)
    return (
        commonSuffixLength(before, anchor.prefix || "") +
        commonPrefixLength(after, anchor.suffix || "")
    )
}

function bestByContext(text, starts, anchor) {
    let best = null
    let bestScore = -1
    for (const s of starts) {
        const score = contextScore(text, s, s + anchor.exact.length, anchor)
        if (score > bestScore) {
            best = s
            bestScore = score
        }
    }
    return best
}

function makeDmp(textLength) {
    const dmp = new DiffMatchPatch()
    dmp.Match_Threshold = FUZZY_THRESHOLD
    dmp.Match_Distance = Math.max(1000, textLength)
    return dmp
}

/** Fuzzy match of `exact` (any length) near `expected`. */
function fuzzyLocate(text, exact, expected) {
    if (exact.length < FUZZY_MIN_LENGTH || !text) return null
    const dmp = makeDmp(text.length)
    const bits = dmp.Match_MaxBits
    const loc = Math.max(0, Math.min(expected, text.length))
    const head = exact.slice(0, bits)
    const start = dmp.match_main(text, head, loc)
    if (start < 0) return null
    let end
    if (exact.length <= bits) {
        end = start + exact.length
    } else {
        const tail = exact.slice(-bits)
        const tailLoc = start + exact.length - bits
        const t = dmp.match_main(text, tail, Math.min(tailLoc, text.length))
        end = t >= start ? t + tail.length : start + exact.length
    }
    end = Math.min(end, text.length)
    const len = end - start
    if (len < exact.length * 0.5 || len > exact.length * 1.5) return null
    return { start, end, strategy: "fuzzy" }
}

/**
 * Locate an anchor in `text`. Strategy:
 *   1. prefix+exact+suffix inside the anchor's section (or the whole doc
 *      when the section is unknown),
 *   2. exact alone (section first, then the whole doc), best context wins,
 *   3. fuzzy (diff-match-patch match_main, threshold 0.3) across the doc,
 *      expected near the section start.
 * Returns { start, end, strategy } or null (orphaned).
 */
export function locate(text, anchor, { sections = [] } = {}) {
    if (!anchor || !anchor.exact || typeof text !== "string") return null
    const exact = anchor.exact
    const prefix = anchor.prefix || ""
    const suffix = anchor.suffix || ""
    const sec = anchor.section
        ? (sections || []).find((s) => s.name === anchor.section)
        : null
    const from = sec ? sec.start : 0
    const to = sec ? sec.end : text.length

    // 1. full quote within the section (or doc)
    if (prefix || suffix) {
        const full = prefix + exact + suffix
        const hits = findAll(
            text,
            full,
            Math.max(0, from - prefix.length),
            Math.min(text.length, to + suffix.length)
        )
        if (hits.length) {
            const start = hits[0] + prefix.length
            return { start, end: start + exact.length, strategy: "quote" }
        }
    }

    // 2. exact alone
    let starts = sec ? findAll(text, exact, from, to) : []
    if (!starts.length) starts = findAll(text, exact)
    if (starts.length) {
        const start = bestByContext(text, starts, anchor)
        return { start, end: start + exact.length, strategy: "exact" }
    }

    // 3. fuzzy
    return fuzzyLocate(text, exact, from)
}

/** Locate many anchored items: -> { located: Map(id->range), orphaned: [id] }. */
export function locateAll(text, items, { sections = [] } = {}) {
    const located = new Map()
    const orphaned = []
    for (const item of items || []) {
        const r = locate(text, item.anchor, { sections })
        if (r) located.set(item.id, r)
        else orphaned.push(item.id)
    }
    return { located, orphaned }
}

// ---------------------------------------------------------------------------
// DOM functions
// ---------------------------------------------------------------------------

/**
 * Text index of a rendered artifact: { text, nodes: [{node, start, end}],
 * sections: [{name, start, end}] }.
 */
export function buildTextIndex(root) {
    const doc = root.ownerDocument || document
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */)
    const nodes = []
    const sectionMap = new Map()
    let text = ""
    let node
    while ((node = walker.nextNode())) {
        const value = node.nodeValue || ""
        const start = text.length
        text += value
        const end = text.length
        nodes.push({ node, start, end })
        const host =
            node.parentElement && node.parentElement.closest("[data-section]")
        if (host && root.contains(host)) {
            const name = host.getAttribute("data-section")
            const sec = sectionMap.get(name)
            if (sec) sec.end = Math.max(sec.end, end)
            else sectionMap.set(name, { name, start, end })
        }
    }
    return { text, nodes, sections: [...sectionMap.values()] }
}

/** Offset in the index text of a DOM (container, offset) boundary point. */
export function offsetOf(index, container, offset) {
    if (container.nodeType === 3) {
        const entry = index.nodes.find((n) => n.node === container)
        return entry
            ? entry.start + Math.min(offset, entry.end - entry.start)
            : null
    }
    // Element boundary: offset counts child nodes. Find the first text node
    // at/after the boundary in document order.
    const child = container.childNodes[offset]
    for (const entry of index.nodes) {
        if (child) {
            const pos = child.compareDocumentPosition(entry.node)
            if (child === entry.node || child.contains(entry.node) || pos & 4) {
                return entry.start
            }
        } else if (
            container.compareDocumentPosition(entry.node) & 4 &&
            !container.contains(entry.node)
        ) {
            return entry.start
        }
    }
    return index.text.length
}

/** Anchor for a DOM Range inside `root`, or null when outside/empty. */
export function createAnchor(root, range) {
    if (!root || !range || range.collapsed) return null
    if (!root.contains(range.commonAncestorContainer)) return null
    const index = buildTextIndex(root)
    const start = offsetOf(index, range.startContainer, range.startOffset)
    const end = offsetOf(index, range.endContainer, range.endOffset)
    if (start === null || end === null) return null
    return anchorFromOffsets(index.text, start, end, index.sections)
}

/** Wrap [start,end) of the index text in <mark> elements. Returns marks. */
export function highlightRange(root, start, end, attrs = {}) {
    const index = buildTextIndex(root)
    const doc = root.ownerDocument || document
    const marks = []
    const targets = index.nodes.filter((n) => n.end > start && n.start < end)
    for (const entry of targets) {
        let node = entry.node
        const s = Math.max(start, entry.start) - entry.start
        const e = Math.min(end, entry.end) - entry.start
        if (e <= s) continue
        // Skip whitespace-only gaps between blocks: wrapping them inside
        // <ul>/<table> would produce invalid markup.
        const slice = node.nodeValue.slice(s, e)
        if (
            !slice.trim() &&
            node.parentElement &&
            /^(UL|OL|TABLE|TBODY|THEAD|TR)$/.test(node.parentElement.tagName)
        )
            continue
        if (node.parentElement === root && !slice.trim()) continue
        if (s > 0) node = node.splitText(s)
        if (e - s < node.nodeValue.length) node.splitText(e - s)
        const mark = doc.createElement("mark")
        mark.className = "cc-hl"
        for (const [k, v] of Object.entries(attrs)) mark.setAttribute(k, v)
        node.parentNode.insertBefore(mark, node)
        mark.appendChild(node)
        marks.push(mark)
    }
    return marks
}

/** Remove every highlight mark under root and merge the split text nodes. */
export function clearHighlights(root) {
    const marks = root.querySelectorAll("mark[data-comment-id]")
    for (const mark of marks) {
        const parent = mark.parentNode
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
        parent.removeChild(mark)
    }
    root.normalize()
}

/**
 * Re-anchor and highlight `items` ([{id, anchor}]) in the rendered root.
 * Returns { located: Map, orphaned: [id] }.
 */
export function applyHighlights(root, items) {
    clearHighlights(root)
    const index = buildTextIndex(root)
    const result = locateAll(index.text, items, { sections: index.sections })
    for (const [id, range] of result.located) {
        highlightRange(root, range.start, range.end, {
            "data-comment-id": String(id),
        })
    }
    return result
}
