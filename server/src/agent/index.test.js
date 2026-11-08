/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { createBus } from "../events/bus.js"
import { createFakeClock } from "../util/clock.js"
import { createCenterAgent, lazySdkQuery } from "./index.js"
import {
    createFakeStore,
    createMemoryJobsRepo,
    createMemorySettingsRepo,
    fakeSpawn,
    makeTask,
} from "./testing/fakes.js"

describe("createCenterAgent", () => {
    test("wires default providers, registry and runner (sdk query injected)", async () => {
        const clock = createFakeClock()
        const store = createFakeStore({ tasks: [makeTask({ id: 1 })] })
        const calls = []
        const query = (args) => {
            calls.push(args)
            return (async function* gen() {
                yield {
                    type: "result",
                    subtype: "success",
                    is_error: false,
                    structured_output: {
                        kind: "todo",
                        title: "T",
                        due_at: null,
                    },
                    usage: {},
                }
            })()
        }
        const spawn = fakeSpawn((child) => child.finish(1))
        const agent = createCenterAgent({
            jobsRepo: createMemoryJobsRepo(),
            settingsRepo: createMemorySettingsRepo(),
            store,
            bus: createBus({ clock }),
            clock,
            query,
            spawn,
            tmpDir: "/tmp",
            config: {
                concurrency: { interactive: 1, background: 1 },
                jobTimeoutMs: 5000,
            },
            pollMs: 0,
        })
        expect(agent.registry.current().name).toBe("claude-sdk")
        expect(agent.registry.get("claude-cli").name).toBe("claude-cli")
        expect(agent.registry.get("codex").name).toBe("codex")
        expect([...agent.jobs.keys()]).toContain("enrich")
        agent.runner.start()
        const job = agent.runner.enqueue(
            "parse_quick",
            { text: "x" },
            { task_id: 1 }
        )
        await agent.runner.idle()
        expect(agent.runner.get(job.id)).toMatchObject({
            status: "done",
            summary: "todo: T",
        })
        expect(calls[0].options.model).toBe("claude-haiku-5-5")
        agent.runner.stop()
    })

    test("defaults with custom providers", () => {
        const agent = createCenterAgent({
            jobsRepo: createMemoryJobsRepo(),
            providers: [{ name: "codex", run: async () => ({}) }],
        })
        expect(agent.registry.current().name).toBe("codex")
        expect(createCenterAgent().registry.current().name).toBe("claude-sdk")
    })

    test("lazySdkQuery loads the SDK on first iteration", async () => {
        const seen = []
        const q = lazySdkQuery(async () => ({
            query: (args) =>
                (async function* gen() {
                    seen.push(args)
                    yield { type: "result" }
                })(),
        }))
        const out = []
        for await (const m of q({ prompt: "p" })) out.push(m)
        expect(out).toEqual([{ type: "result" }])
        expect(seen).toEqual([{ prompt: "p" }])
    })
})
