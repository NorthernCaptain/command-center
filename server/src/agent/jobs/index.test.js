/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { toProviderSchema } from "../jsonSchema.js"
import { createJobRegistry, DEFAULT_JOBS } from "./index.js"
import { asanaGidFromUrl, checklist, isoOrNull, sourceKind } from "./util.js"

describe("job registry", () => {
    test("default jobs are registered", () => {
        const reg = createJobRegistry()
        expect([...reg.keys()].sort()).toEqual([
            "asana_create",
            "assist",
            "close_out",
            "command",
            "enrich",
            "parse_quick",
        ])
    })

    test("every output schema converts to a strict JSON schema", () => {
        const walk = (node) => {
            if (!node || typeof node !== "object") return
            // keywords strict validators reject
            for (const k of ["default", "format", "pattern", "$schema"])
                expect(node).not.toHaveProperty([k])
            if (node.type === "object") {
                expect(node.additionalProperties).toBe(false)
                expect(node.required.sort()).toEqual(
                    Object.keys(node.properties).sort()
                )
            }
            Object.values(node).forEach(walk)
        }
        for (const m of DEFAULT_JOBS) walk(toProviderSchema(m.outputSchema))
    })

    test("validates module contract", () => {
        expect(() => createJobRegistry([{ type: "x" }])).toThrow(/missing lane/)
        const base = {
            type: "x",
            lane: "nope",
            weight: "light",
            outputSchema: {},
            buildPrompt() {},
            apply() {},
        }
        expect(() => createJobRegistry([base])).toThrow(/invalid lane/)
        const ok = { ...base, lane: "background" }
        expect(() => createJobRegistry([ok, ok])).toThrow(/duplicate/)
        expect(() => createJobRegistry([{}])).toThrow(/job module \?/)
    })
})

describe("job utils", () => {
    test("asanaGidFromUrl", () => {
        expect(asanaGidFromUrl("https://app.asana.com/0/111/222")).toBe("222")
        expect(
            asanaGidFromUrl(
                "https://app.asana.com/1/77/project/12/task/345?focus=true"
            )
        ).toBe("345")
        expect(asanaGidFromUrl("https://app.asana.com/0/111/222/f")).toBe("222")
        expect(asanaGidFromUrl(null)).toBeNull()
    })

    test("sourceKind", () => {
        expect(
            sourceKind({
                source: {
                    type: "manual",
                    url: "https://x.slack.com/archives/1",
                },
            })
        ).toBe("slack")
        expect(sourceKind({ source: { type: "slack", url: null } })).toBeNull()
        expect(
            sourceKind({
                source: { type: "other", url: "https://app.asana.com/0/1/2" },
            })
        ).toBe("asana")
        expect(sourceKind({ source: { type: "asana" } })).toBeNull()
        expect(sourceKind({})).toBeNull()
    })

    test("isoOrNull and checklist", () => {
        expect(isoOrNull("")).toBeNull()
        expect(isoOrNull(5)).toBeNull()
        expect(isoOrNull("2026-01-01T00:00:00+02:00")).toBe(
            "2025-12-31T22:00:00.000Z"
        )
        expect(checklist(["a", "- [x] b", "", null])).toBe(
            "- [ ] a\n- [ ] b\n- [ ] null"
        )
        expect(checklist(null)).toBe("")
    })
})
