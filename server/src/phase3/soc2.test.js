/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { buildArtifactTemplate } from "../store/artifact.js"
import { createFakeClock } from "../util/clock.js"
import {
    assertChangeRecord,
    assertTaskChangeRecord,
    changeRecordState,
    createSoc2,
    parseBound,
    parseChangeRecord,
    requiresChangeRecord,
    toMarkdown,
} from "./soc2.js"

const FULL = [
    "# T-5 — Rotate keys",
    "",
    "## Decisions",
    "<!-- date · author · decision · why -->",
    "- 2026-11-01 · Leo · use KMS · audit",
    "",
    "## Change record (SOC2)",
    "- What: rotate IAM keys",
    "- **Why:** quarterly policy",
    "* **Risk**: low <!-- note -->",
    "Rollback: restore old key: from vault",
    "- tested : staging run",
    "- Approved by: Leo",
    "- Evidence:",
    "- Ticket: SEC-1",
    "",
    "## Result",
    "",
].join("\n")

describe("parseChangeRecord", () => {
    test("reads labels case-insensitively with bullets and bold", () => {
        const r = parseChangeRecord({ content: FULL })
        expect(r.present).toBe(true)
        expect(r.missing).toEqual([])
        expect(r.fields).toEqual({
            what: "rotate IAM keys",
            why: "quarterly policy",
            risk: "low",
            rollback: "restore old key: from vault",
            tested: "staging run",
            approved_by: "Leo",
            evidence: "",
            ticket: "SEC-1",
        })
    })

    test("the v1 template counts as empty", () => {
        const content = buildArtifactTemplate({
            id: 1,
            title: "x",
            area: "infra",
            source: { type: "manual" },
        })
        const r = parseChangeRecord(content)
        expect(r.present).toBe(true)
        expect(r.missing).toEqual(["what", "why", "risk", "rollback", "tested"])
    })

    test("placeholders are missing; first non-empty duplicate wins", () => {
        const body = [
            "## Change record (SOC2)",
            "- What: …",
            "- What: real",
            "- Why: ...",
            "- Risk: TBD",
            "- Rollback: -",
            "- Tested: todo",
            "not a label line",
            "- : nothing",
        ].join("\n")
        const r = parseChangeRecord(body)
        expect(r.fields.what).toBe("real")
        expect(r.missing).toEqual(["why", "risk", "rollback", "tested"])
    })

    test("missing section and empty artifacts", () => {
        expect(parseChangeRecord("# T-1\n\n## Plan\n- What: x")).toEqual({
            present: false,
            fields: {},
            missing: ["what", "why", "risk", "rollback", "tested"],
        })
        expect(parseChangeRecord(null).present).toBe(false)
        expect(parseChangeRecord(undefined).present).toBe(false)
    })
})

describe("changeRecordState", () => {
    test("null outside SOC2 areas, else section, presence and gaps", () => {
        expect(changeRecordState({ area: "backend" }, FULL)).toBeNull()
        expect(changeRecordState({ area: "infra" }, FULL)).toEqual({
            section: "Change record (SOC2)",
            present: true,
            missing: [],
        })
        expect(changeRecordState({ area: "access" }, "# T-1\n")).toEqual({
            section: "Change record (SOC2)",
            present: false,
            missing: ["what", "why", "risk", "rollback", "tested"],
        })
    })
})

describe("assertChangeRecord", () => {
    test("only SOC2 areas are checked", () => {
        expect(requiresChangeRecord({ area: "backend" })).toBe(false)
        expect(requiresChangeRecord(null)).toBe(false)
        expect(requiresChangeRecord({ area: "soc2" })).toBe(true)
        expect(() =>
            assertChangeRecord({ id: 1, area: "web" }, "")
        ).not.toThrow()
        expect(() =>
            assertChangeRecord({ id: 5, area: "access" }, FULL)
        ).not.toThrow()
    })

    test("throws 409 change_record_missing listing the fields", () => {
        let err
        try {
            assertChangeRecord(
                { id: 7, area: "infra" },
                "## Change record (SOC2)\n- What: x\n- Why: y\n"
            )
        } catch (e) {
            err = e
        }
        expect(err).toMatchObject({
            code: "change_record_missing",
            status: 409,
            details: {
                missing: ["risk", "rollback", "tested"],
                section: "Change record (SOC2)",
            },
        })
        expect(err.message).toBe(
            'T-7 (infra) needs a SOC2 change record before done: fill Risk, Rollback, Tested in "Change record (SOC2)"'
        )
        expect(() =>
            assertChangeRecord({ id: 7, area: "infra" }, "# nothing")
        ).toThrow(/\(section missing\)$/)
    })

    test("assertTaskChangeRecord loads the artifact only when needed", async () => {
        const store = { getArtifact: jest.fn(async () => ({ content: "" })) }
        await assertTaskChangeRecord(store, { id: 1, area: "web" })
        expect(store.getArtifact).not.toHaveBeenCalled()
        await expect(
            assertTaskChangeRecord(store, { id: 2, area: "soc2" })
        ).rejects.toMatchObject({ code: "change_record_missing" })
        expect(store.getArtifact).toHaveBeenCalledWith(2)
    })
})

describe("parseBound", () => {
    test("date-only is local midnight; end-of-day adds a day", () => {
        expect(parseBound("2026-11-01", "from").getTime()).toBe(
            new Date(2026, 10, 1).getTime()
        )
        expect(
            parseBound("2026-11-01", "to", { endOfDay: true }).getTime()
        ).toBe(new Date(2026, 10, 2).getTime())
        expect(parseBound("2026-11-01T10:00:00Z", "from").toISOString()).toBe(
            "2026-11-01T10:00:00.000Z"
        )
        expect(parseBound("", "from")).toBeNull()
        expect(parseBound(null, "from")).toBeNull()
        expect(() => parseBound("nope", "from")).toThrow("invalid from")
    })
})

function task(id, over = {}) {
    return {
        id,
        title: `Task ${id}`,
        area: "infra",
        status: "done",
        done_at: "2026-11-03T10:00:00.000Z",
        deliverables: [],
        links: [],
        asana: { gid: null, url: null },
        ...over,
    }
}

function fakeStore(tasks, artifacts = {}) {
    return {
        query: jest.fn(async ({ area, done_since, limit, offset }) => {
            const all = tasks.filter(
                (t) =>
                    t.status === "done" &&
                    area.includes(t.area) &&
                    t.done_at >= done_since
            )
            return {
                tasks: all.slice(offset, offset + Math.min(limit, 2)),
                total: all.length,
            }
        }),
        getTask: jest.fn(async (id) => ({
            task: tasks.find((t) => t.id === id),
        })),
        getArtifact: jest.fn(async (id) => ({ content: artifacts[id] || "" })),
    }
}

describe("exportEvidence", () => {
    const clock = createFakeClock("2026-11-07T12:00:00.000Z")

    test("collects done SOC2 tasks of the range with records and PRs", async () => {
        const tasks = [
            task(5, {
                title: "Rotate keys",
                area: "security",
                done_at: "2026-11-04T09:00:00.000Z",
                asana: { gid: "9", url: "https://app.asana.com/0/1/9" },
                deliverables: [
                    {
                        repo: "infra",
                        branch: "b",
                        pr: "https://github.com/o/infra/pull/1",
                        merged_at: "2026-11-04T08:00:00.000Z",
                    },
                    { repo: "x", branch: "b", pr: null },
                    {
                        repo: "dup",
                        branch: "b",
                        pr: "https://github.com/o/infra/pull/1",
                    },
                ],
                links: [
                    { type: "pr", url: "https://github.com/o/infra/pull/1" },
                    { type: "pr", url: "https://github.com/o/tf/pull/2" },
                    { type: "slack", url: "https://slack.com/x" },
                ],
            }),
            task(6, { done_at: "2026-11-02T09:00:00.000Z" }),
            task(7, { done_at: "2026-11-02T09:00:00.000Z" }),
            task(8, { done_at: "2026-11-09T09:00:00.000Z" }),
            task(9, { area: "backend" }),
            task(10, { status: "active" }),
        ]
        const store = fakeStore(tasks, { 5: FULL })
        const { exportEvidence } = createSoc2({ store, clock })
        const ev = await exportEvidence({
            from: "2026-11-01T00:00:00.000Z",
            to: "2026-11-08T00:00:00.000Z",
        })
        expect(ev.generated_at).toBe("2026-11-07T12:00:00.000Z")
        expect(ev.areas).toEqual(["infra", "access", "security", "soc2"])
        expect(ev.tasks.map((t) => t.id)).toEqual([6, 7, 5])
        expect(store.query).toHaveBeenCalledTimes(2) // paged
        const t5 = ev.tasks[2]
        expect(t5).toMatchObject({
            id: 5,
            title: "Rotate keys",
            area: "security",
            status: "done",
            asana_url: "https://app.asana.com/0/1/9",
            prs: [
                {
                    url: "https://github.com/o/infra/pull/1",
                    merged_at: "2026-11-04T08:00:00.000Z",
                },
                { url: "https://github.com/o/tf/pull/2", merged_at: null },
            ],
            decisions: "- 2026-11-01 · Leo · use KMS · audit",
        })
        expect(t5.change_record).toMatchObject({
            what: "rotate IAM keys",
            missing: [],
        })
        expect(ev.tasks[0]).toMatchObject({
            asana_url: null,
            decisions: "",
            change_record: {
                missing: ["what", "why", "risk", "rollback", "tested"],
            },
        })
    })

    test("defaults, area filter and validation", async () => {
        const store = fakeStore([task(1, { area: "access" }), task(2)])
        const { exportEvidence } = createSoc2({ store })
        const all = await exportEvidence()
        // default range: 90 days back from now (real clock)
        expect(Date.parse(all.to) - Date.parse(all.from)).toBe(90 * 86400000)

        const fixed = createSoc2({ store, clock })
        const ev = await fixed.exportEvidence({
            from: "2026-11-01",
            to: "2026-11-07",
            areas: ["access", "backend"],
        })
        expect(ev.areas).toEqual(["access"])
        expect(ev.tasks.map((t) => t.id)).toEqual([1])
        await expect(
            fixed.exportEvidence({ areas: ["backend"] })
        ).rejects.toMatchObject({ code: "validation" })
        await expect(
            fixed.exportEvidence({ from: "2026-11-08", to: "2026-11-01" })
        ).rejects.toThrow("from must be before to")
    })

    test("empty pages stop the loop", async () => {
        const store = {
            query: jest.fn(async () => ({ tasks: [], total: 5 })),
        }
        const { exportEvidence } = createSoc2({ store, clock })
        expect((await exportEvidence({})).tasks).toEqual([])
        expect(store.query).toHaveBeenCalledTimes(1)
    })
})

describe("toMarkdown", () => {
    test("renders tasks, records, PRs and decisions", () => {
        const md = toMarkdown({
            generated_at: "G",
            from: "F",
            to: "T",
            areas: ["infra"],
            tasks: [
                {
                    id: 5,
                    title: "Rotate\r\nkeys",
                    area: "infra",
                    status: "done",
                    done_at: "D",
                    asana_url: "https://asana/9",
                    change_record: {
                        what: "w",
                        why: "y",
                        risk: "r",
                        rollback: "b",
                        tested: "t",
                        evidence: "",
                        ticket: "SEC-1",
                        other: "",
                        missing: [],
                    },
                    prs: [
                        { url: "https://pr/1", merged_at: "M" },
                        { url: "https://pr/2", merged_at: null },
                    ],
                    decisions: "- use KMS",
                },
                {
                    id: 6,
                    title: "Bare",
                    area: "soc2",
                    status: "done",
                    done_at: null,
                    asana_url: null,
                    change_record: { what: "w", missing: ["why"] },
                    prs: [],
                    decisions: "",
                },
                {
                    id: 7,
                    title: "No record",
                    area: "soc2",
                    status: "done",
                    done_at: "D",
                    asana_url: null,
                    change_record: null,
                    prs: [],
                    decisions: "",
                },
            ],
        })
        expect(md).toContain("# SOC2 change evidence")
        expect(md).toContain("- Range: F → T")
        expect(md).toContain("- Changes: 3")
        expect(md).toContain("## T-5 — Rotate\nkeys")
        expect(md).toContain("- Asana: https://asana/9")
        expect(md).toContain("- What: w\n- Why: y\n- Risk: r")
        expect(md).toContain("- Evidence: —")
        expect(md).not.toContain("- Approved by:")
        expect(md).toContain("- ticket: SEC-1")
        expect(md).toContain("- other: —")
        expect(md).toContain("- https://pr/1 (merged M)")
        expect(md).toContain("- https://pr/2 (not merged)")
        expect(md).toContain("### Decisions\n\n- use KMS")
        expect(md).toContain("- Done: —")
        expect(md).toContain("- Why: —")
        expect(md).toContain("- **Missing:** Why")
        expect(md).toContain("- none")
    })
})
