/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { StaleRevisionError } from "../util/errors.js"
import {
    applySectionEdits,
    isValidSectionName,
    normalizeEdit,
} from "./artifactEdits.js"
import { sectionBody } from "./sections.js"
import { createFakeStore, makeCtx, makeTask } from "./testing/fakes.js"

const ART = `# T-1 — Thing

## Summary
old summary

## Plan
old plan

## Notes
`

async function setup() {
    const store = createFakeStore({ tasks: [makeTask({ id: 1 })] })
    await store.setArtifact(1, ART)
    const artifact = await store.getArtifact(1)
    return { store, context: { artifact } }
}

const humanEdit = (store, section, body) =>
    store.setArtifact(
        1,
        store.state
            .get(1)
            .artifact.replace(
                `## ${section}\n${sectionBody(store.state.get(1).artifact, section)}`,
                `## ${section}\n${body}`
            )
    )

describe("normalizeEdit / isValidSectionName", () => {
    test("strips a repeated heading and trims", () => {
        expect(
            normalizeEdit({
                section: "## Plan",
                op: "replace",
                content: "## Plan\n step one \n",
            })
        ).toEqual({ section: "Plan", op: "replace", content: "step one" })
    })
    test("keeps a first line that is not the section heading", () => {
        expect(
            normalizeEdit({ section: "Plan", op: "append", content: null })
        ).toEqual({ section: "Plan", op: "append", content: "" })
    })
    test("section names", () => {
        expect(isValidSectionName("Plan")).toBe(true)
        expect(isValidSectionName("")).toBe(false)
        expect(isValidSectionName("a#b")).toBe(false)
        expect(isValidSectionName("x".repeat(81))).toBe(false)
    })
})

describe("applySectionEdits", () => {
    test("chains replaces on its own revisions", async () => {
        const { store, context } = await setup()
        const ctx = makeCtx({ store })
        const res = await applySectionEdits(ctx, context, [
            { section: "Summary", op: "replace", content: "new summary" },
            { section: "Plan", op: "replace", content: "new plan" },
        ])
        expect(res).toEqual({
            applied: ["Summary", "Plan"],
            conflicts: [],
            skipped: [],
        })
        const art = store.state.get(1).artifact
        expect(sectionBody(art, "Summary")).toContain("new summary")
        expect(sectionBody(art, "Plan")).toContain("new plan")
    })

    /** Attempt 1 (stale -> throws), then the runner's attempt 2. */
    async function withRetry(store, context, edits) {
        await expect(
            applySectionEdits(makeCtx({ store }), context, edits)
        ).rejects.toBeInstanceOf(StaleRevisionError)
        return applySectionEdits(makeCtx({ store, attempt: 2 }), context, edits)
    }

    test("appends carry the base revision too: a human edit makes them stale", async () => {
        const { store, context } = await setup()
        await humanEdit(store, "Plan", "human plan\n")
        await expect(
            applySectionEdits(makeCtx({ store }), context, [
                { section: "Notes", op: "append", content: "agent note" },
            ])
        ).rejects.toBeInstanceOf(StaleRevisionError)
        expect(store.state.get(1).artifact).not.toContain("agent note")
    })

    test("a replace after an append never clobbers a human edit", async () => {
        const { store, context } = await setup()
        await humanEdit(store, "Plan", "human plan\n")
        const res = await withRetry(store, context, [
            { section: "Notes", op: "append", content: "agent note" },
            { section: "Plan", op: "replace", content: "agent plan" },
        ])
        expect(res.applied).toEqual(["Notes"])
        expect(res.conflicts).toEqual(["Plan"])
        const art = store.state.get(1).artifact
        expect(sectionBody(art, "Plan")).toContain("human plan")
        expect(sectionBody(art, "Plan")).not.toContain("agent plan")
        expect(sectionBody(art, "Notes")).toContain("agent note")
    })

    test("append then replace of the same human-edited section conflicts", async () => {
        const { store, context } = await setup()
        await humanEdit(store, "Plan", "human plan\n")
        const res = await withRetry(store, context, [
            { section: "Plan", op: "append", content: "agent step" },
            { section: "Plan", op: "replace", content: "agent plan" },
        ])
        expect(res.applied).toEqual(["Plan"])
        expect(res.conflicts).toEqual(["Plan"])
        const body = sectionBody(store.state.get(1).artifact, "Plan")
        expect(body).toContain("human plan")
        expect(body).toContain("agent step")
        expect(body).not.toContain("agent plan")
    })

    test("in verify mode our own earlier write is not a conflict", async () => {
        const { store, context } = await setup()
        await humanEdit(store, "Summary", "human summary\n")
        const res = await withRetry(store, context, [
            { section: "Notes", op: "append", content: "agent note" },
            { section: "Plan", op: "replace", content: "agent plan" },
            { section: "Notes", op: "replace", content: "rewritten notes" },
            { section: "Plan", op: "append", content: "and more" },
        ])
        expect(res.applied).toEqual(["Notes", "Plan", "Notes", "Plan"])
        expect(res.conflicts).toEqual([])
        const art = store.state.get(1).artifact
        expect(sectionBody(art, "Summary")).toContain("human summary")
        expect(sectionBody(art, "Plan")).toBe("agent plan\n\nand more")
        expect(sectionBody(art, "Notes")).toBe("rewritten notes")
    })

    test("verify mode: a human edit between two of our writes is kept", async () => {
        const { store, context } = await setup()
        await humanEdit(store, "Summary", "human summary\n")
        const realUpdate = store.updateArtifactSection.bind(store)
        let n = 0
        const edits = [
            { section: "Plan", op: "replace", content: "agent plan" },
            { section: "Plan", op: "replace", content: "agent plan v2" },
        ]
        await expect(
            applySectionEdits(makeCtx({ store }), context, edits)
        ).rejects.toBeInstanceOf(StaleRevisionError)
        store.updateArtifactSection = async (id, args, actor) => {
            const out = await realUpdate(id, args, actor)
            if (++n === 1) await humanEdit(store, "Plan", "human plan\n")
            return out
        }
        const res = await applySectionEdits(
            makeCtx({ store, attempt: 2 }),
            context,
            edits
        )
        expect(res.applied).toEqual(["Plan"])
        expect(res.conflicts).toEqual(["Plan"])
        expect(sectionBody(store.state.get(1).artifact, "Plan")).toBe(
            "human plan"
        )
    })

    test("without foreign edits appends and replaces chain on attempt 1", async () => {
        const { store, context } = await setup()
        let reads = 0
        const realGet = store.getArtifact.bind(store)
        store.getArtifact = async (id) => {
            reads++
            return realGet(id)
        }
        const res = await applySectionEdits(makeCtx({ store }), context, [
            { section: "Notes", op: "append", content: "agent note" },
            { section: "Plan", op: "replace", content: "agent plan" },
            { section: "Plan", op: "append", content: "more" },
        ])
        expect(res).toEqual({
            applied: ["Notes", "Plan", "Plan"],
            conflicts: [],
            skipped: [],
        })
        expect(reads).toBe(0)
        for (const c of store.calls.filter(
            (x) => x[0] === "updateArtifactSection"
        ))
            expect(c[2].baseRevision).toBeTruthy()
    })

    test("a plain replace on a stale snapshot throws for the runner retry", async () => {
        const { store, context } = await setup()
        await humanEdit(store, "Summary", "human summary\n")
        const ctx = makeCtx({ store })
        await expect(
            applySectionEdits(ctx, context, [
                { section: "Plan", op: "replace", content: "agent plan" },
            ])
        ).rejects.toBeInstanceOf(StaleRevisionError)
    })

    test("retry applies unchanged sections and reports changed ones", async () => {
        const { store, context } = await setup()
        const edits = [
            { section: "Summary", op: "replace", content: "agent summary" },
            { section: "Plan", op: "replace", content: "agent plan" },
            { section: "Notes", op: "append", content: "note" },
        ]
        // first attempt: Summary written, then a human edits Plan and
        // Summary-after-us, making the Plan write stale
        const realUpdate = store.updateArtifactSection.bind(store)
        let n = 0
        store.updateArtifactSection = async (id, args, actor) => {
            const out = await realUpdate(id, args, actor)
            if (++n === 1) await humanEdit(store, "Plan", "human plan\n")
            return out
        }
        await expect(
            applySectionEdits(makeCtx({ store }), context, edits)
        ).rejects.toBeInstanceOf(StaleRevisionError)
        const res = await applySectionEdits(
            makeCtx({ store, attempt: 2 }),
            context,
            edits
        )
        expect(res.applied).toEqual(["Summary", "Notes"])
        expect(res.conflicts).toEqual(["Plan"])
        const art = store.state.get(1).artifact
        expect(sectionBody(art, "Summary")).toContain("agent summary")
        expect(sectionBody(art, "Plan")).toContain("human plan")
        expect(art.match(/agent summary/g)).toHaveLength(1)
    })

    test("stale retry sees a human edit under a heading with closing hashes", async () => {
        const store = createFakeStore({ tasks: [makeTask({ id: 1 })] })
        await store.setArtifact(1, "# T-1 — x\n\n## Plan ##\nold plan\n")
        const context = { artifact: await store.getArtifact(1) }
        await store.setArtifact(1, "# T-1 — x\n\n## Plan ##\nhuman plan\n")
        const edits = [{ section: "Plan", op: "replace", content: "agent" }]
        await expect(
            applySectionEdits(makeCtx({ store }), context, edits)
        ).rejects.toBeInstanceOf(StaleRevisionError)
        const res = await applySectionEdits(
            makeCtx({ store, attempt: 2 }),
            context,
            edits
        )
        expect(res.conflicts).toEqual(["Plan"])
        expect(res.applied).toEqual([])
        expect(store.state.get(1).artifact).toContain("human plan")
        expect(store.state.get(1).artifact).not.toContain("agent")
    })

    test("skips invalid edits and works without a snapshot", async () => {
        const { store } = await setup()
        const ctx = makeCtx({ store })
        const context = {}
        const res = await applySectionEdits(ctx, context, [
            { section: "", op: "replace", content: "x" },
            { section: "Plan", op: "delete", content: "x" },
            { section: "Brand New", op: "replace", content: "fresh" },
            { section: "Plan", op: "replace", content: "no snapshot" },
        ])
        expect(res.skipped).toEqual(["(empty)", "Plan"])
        // without a snapshot only sections absent from it (empty) match
        expect(res.applied).toEqual(["Brand New"])
        expect(res.conflicts).toEqual(["Plan"])
    })
})
