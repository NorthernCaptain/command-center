/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Worker routes on the /api router (owner only; the core router enforces
// roles) plus the task/board extras. See phase2-contracts.md (C).

import { z } from "zod"
import { WORKER_KINDS } from "../contracts/schemas.js"
import { ACTIONS } from "./workerService.js"

const StartBody = z
    .object({ kind: z.enum(WORKER_KINDS).optional() })
    .passthrough()
const ActionBody = z
    .object({
        text: z.string().max(20000).optional(),
        quote: z.string().max(5000).optional(),
        id: z.coerce.number().int().positive().optional(),
        // close-agent: clean the folders first, close when that is done
        clean: z.boolean().optional(),
    })
    .passthrough()
const ActionName = z.enum(ACTIONS)

/**
 * POST /tasks/:id/start            { kind? }               -> 202 { session, warnings }
 * POST /tasks/:id/actions/:name    { text?, quote?, id? }  -> { ok, delivery?, ... }
 * GET  /tasks/:id/agent                                    -> agentState | null
 */
export function mountWorkers(api, helpers, { workerService }) {
    const { parse, parseTaskId, ACTOR = "me" } = helpers

    api.post("/tasks/:id/start", async (req, res) => {
        const id = parseTaskId(req.params.id)
        const body = parse(StartBody, req.body ?? {}, "start")
        const r = await workerService.startTask(id, {
            kind: body.kind,
            actor: ACTOR,
        })
        res.status(202).json(r)
    })

    api.post("/tasks/:id/actions/:name", async (req, res) => {
        const id = parseTaskId(req.params.id)
        const name = parse(ActionName, req.params.name, "action")
        const body = parse(ActionBody, req.body ?? {}, "action body")
        res.json(await workerService.action(id, name, body, { actor: ACTOR }))
    })

    api.get("/tasks/:id/agent", async (req, res) => {
        const id = parseTaskId(req.params.id)
        res.json(await workerService.agentState(id))
    })
}

/** taskExtras entry: { agent, outbox } for the owner's task view. */
export function workerTaskExtras(workerService) {
    return async (id) => {
        const [agent, outbox] = await Promise.all([
            workerService.agentState(id),
            // pending + failed (Retry) prompts
            typeof workerService.outboxView === "function"
                ? workerService.outboxView(id)
                : workerService.queued(id),
        ])
        return { agent, outbox }
    }
}

/** boardExtras entry: { agents: { [taskId]: state } }. */
export function workerBoardExtras(workerService) {
    return async () => ({ agents: await workerService.states() })
}
