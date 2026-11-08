/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Line-based three-way merge (diff3) for artifact edits that hit a 409:
// replay my changes (base -> mine) on top of the server's current text
// (base -> theirs). Regions both sides changed differently are kept in the
// output between conflict markers, so none of my text is ever dropped.

import DiffMatchPatch from "diff-match-patch"

export const MARK_MINE = "<<<<<<< mine"
export const MARK_SPLIT = "======="
export const MARK_THEIRS = ">>>>>>> current"

/**
 * Text with CRLF / CR line ends turned into LF (a textarea always yields LF,
 * so a CRLF artifact would otherwise differ on every line).
 */
export function normalizeEol(text) {
    return String(text || "").replace(/\r\n?/g, "\n")
}

/** Encode the lines of several texts as one char per distinct line. */
function encodeLines(texts) {
    const index = new Map()
    const lines = texts.map((t) => normalizeEol(t).split("\n"))
    const encoded = lines.map((arr) =>
        arr
            .map((line) => {
                if (!index.has(line)) index.set(line, index.size)
                return String.fromCharCode(index.get(line))
            })
            .join("")
    )
    return { lines, encoded }
}

/**
 * Hunks turning base into other: [{ start, end, lines }] where base lines
 * [start, end) are replaced by `lines` (start === end for a pure insert).
 */
function hunks(dmp, baseEnc, otherEnc, otherLines) {
    const diffs = dmp.diff_main(baseEnc, otherEnc, false)
    const out = []
    let b = 0 // index into base lines
    let o = 0 // index into other lines
    let cur = null
    const close = () => {
        if (cur) out.push(cur)
        cur = null
    }
    for (const [op, chunk] of diffs) {
        const n = chunk.length
        if (op === DiffMatchPatch.DIFF_EQUAL) {
            close()
            b += n
            o += n
            continue
        }
        if (!cur) cur = { start: b, end: b, lines: [] }
        if (op === DiffMatchPatch.DIFF_DELETE) {
            b += n
            cur.end = b
        } else {
            cur.lines.push(...otherLines.slice(o, o + n))
            o += n
        }
    }
    close()
    return out
}

/** Base lines [start, end) with the given side's hunks applied. */
function sideRegion(baseLines, start, end, sideHunks) {
    const out = []
    let i = start
    for (const h of sideHunks) {
        out.push(...baseLines.slice(i, h.start))
        out.push(...h.lines)
        i = h.end
    }
    out.push(...baseLines.slice(i, end))
    return out
}

const sameLines = (a, b) =>
    a.length === b.length && a.every((line, i) => line === b[i])

/**
 * -> { text, clean, conflicts, failed }. On conflicts `text` holds both
 * versions of each clashing region between MARK_MINE / MARK_SPLIT /
 * MARK_THEIRS lines; `failed` is kept as an alias of `conflicts`.
 */
export function threeWayMerge(base, mine, theirs) {
    const dmp = new DiffMatchPatch()
    dmp.Diff_Timeout = 2
    const { lines, encoded } = encodeLines([base, mine, theirs])
    const [baseLines, mineLines, theirLines] = lines
    const all = [
        ...hunks(dmp, encoded[0], encoded[1], mineLines).map((h) => ({
            ...h,
            side: "mine",
        })),
        ...hunks(dmp, encoded[0], encoded[2], theirLines).map((h) => ({
            ...h,
            side: "theirs",
        })),
    ].sort((a, b) => a.start - b.start || a.end - b.end)

    // Group hunks that overlap or touch (like git, adjacent edits clash).
    const groups = []
    for (const h of all) {
        const g = groups[groups.length - 1]
        if (g && h.start <= g.end) {
            g.end = Math.max(g.end, h.end)
            g.items.push(h)
        } else {
            groups.push({ start: h.start, end: h.end, items: [h] })
        }
    }

    const out = []
    let conflicts = 0
    let i = 0
    for (const g of groups) {
        out.push(...baseLines.slice(i, g.start))
        const mineH = g.items.filter((h) => h.side === "mine")
        const theirH = g.items.filter((h) => h.side === "theirs")
        const mineR = sideRegion(baseLines, g.start, g.end, mineH)
        const theirR = sideRegion(baseLines, g.start, g.end, theirH)
        if (!theirH.length || sameLines(mineR, theirR)) out.push(...mineR)
        else if (!mineH.length) out.push(...theirR)
        else {
            conflicts++
            out.push(MARK_MINE, ...mineR, MARK_SPLIT, ...theirR, MARK_THEIRS)
        }
        i = g.end
    }
    out.push(...baseLines.slice(i))
    return {
        text: out.join("\n"),
        clean: conflicts === 0,
        conflicts,
        failed: conflicts,
    }
}

/** True if the text still contains merge conflict markers. */
export function hasConflictMarkers(text) {
    const lines = String(text || "").split("\n")
    return lines.includes(MARK_MINE) && lines.includes(MARK_THEIRS)
}
