/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Applies LLM section edits to an artifact with optimistic concurrency.
//
// Concurrency rules (runner retries apply once on StaleRevisionError):
// - Every write (replace and append) carries a base revision. While all
//   writes so far were ours, that base is the revision the LLM saw, then the
//   revision our previous write returned, and we know the exact content
//   (snapshot + our edits). Any foreign edit makes the write stale.
// - On a retry (ctx.attempt > 1), or without a snapshot, each write first
//   re-reads the artifact and compares its target section with what we
//   expect there: the snapshot's body, or what our own earlier write left.
//   A "replace" of a section someone else changed is skipped and reported
//   as a conflict (never clobber a human edit). An "append" still lands
//   (it removes nothing), but that section is then marked foreign so a
//   later replace of it conflicts too.
// Progress lives in context.editState, so edits written before a stale error
// are not applied twice.

import { setSection } from "../store/artifact.js"
import { normalizeSectionName, sectionBody } from "./sections.js"

/** expect-map value: the section holds changes that are not ours. */
const FOREIGN = Symbol("foreign")

/** Clean an LLM edit: section name without "## ", body without the heading. */
export function normalizeEdit(edit) {
    const section = normalizeSectionName(edit.section)
    let content = String(edit.content ?? "")
    const lines = content.split("\n")
    if (
        lines.length &&
        normalizeSectionName(lines[0]).toLowerCase() ===
            section.toLowerCase() &&
        /^##\s/.test(lines[0])
    ) {
        content = lines.slice(1).join("\n")
    }
    return { section, op: edit.op, content: content.trim() }
}

export function isValidSectionName(name) {
    return Boolean(name) && name.length <= 80 && !/[\n\r#]/.test(name)
}

/**
 * @param ctx job ctx (store, task_id, actor, attempt)
 * @param context job context; context.artifact = { content, revision } seen
 *   by the LLM.
 * @param edits [{ section, op: "replace"|"append", content }]
 * @returns {Promise<{ applied: string[], conflicts: string[], skipped: string[] }>}
 */
export async function applySectionEdits(ctx, context, edits) {
    const seen = context.artifact ? context.artifact.content : ""
    const st = (context.editState ||= {
        revision: context.artifact ? context.artifact.revision : null,
        content: seen, // exact content while verify is off
        expect: new Map(), // section key -> body our writes left (or FOREIGN)
        done: new Set(),
        applied: [],
        conflicts: [],
        skipped: [],
        verify: !context.artifact,
    })
    const list = edits.map(normalizeEdit)
    if ((ctx.attempt || 1) > 1) st.verify = true
    const expected = (key, name) =>
        st.expect.has(key) ? st.expect.get(key) : sectionBody(seen, name)

    for (let i = 0; i < list.length; i++) {
        if (st.done.has(i)) continue
        const e = list[i]
        if (
            !isValidSectionName(e.section) ||
            !["replace", "append"].includes(e.op)
        ) {
            st.done.add(i)
            st.skipped.push(e.section || "(empty)")
            continue
        }
        const key = e.section.toLowerCase()
        let base = st.revision
        let content = st.content
        let foreign = false
        if (st.verify) {
            const current = await ctx.store.getArtifact(ctx.task_id)
            const want = expected(key, e.section)
            foreign =
                want === FOREIGN ||
                sectionBody(current.content, e.section) !== want
            if (foreign && e.op === "replace") {
                st.done.add(i)
                st.conflicts.push(e.section)
                continue
            }
            base = current.revision
            content = current.content
        }
        const res = await ctx.store.updateArtifactSection(
            ctx.task_id,
            {
                section: e.section,
                op: e.op,
                content: e.content,
                baseRevision: base,
            },
            ctx.actor
        )
        const next = setSection(content, e.section, e.content, e.op)
        st.expect.set(key, foreign ? FOREIGN : sectionBody(next, e.section))
        st.content = next
        if (res && res.revision) st.revision = res.revision
        st.done.add(i)
        st.applied.push(e.section)
    }
    return {
        applied: [...st.applied],
        conflicts: [...st.conflicts],
        skipped: [...st.skipped],
    }
}
