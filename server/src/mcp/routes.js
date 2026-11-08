/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// REST mirror of the worker tools for the `cc` CLI and hooks:
// POST /api/agent/:tool with the tool args as the JSON body. The /api
// router already enforces auth and owner-only writes.

import { NotFoundError } from "../util/errors.js"
import { contextFromHeaders, TOOL_NAMES } from "./tools.js"

/**
 * @param {object} api      the /api express router
 * @param {object} _helpers createApp helpers (unused)
 * @param {{ tools: object }} deps tools from createAgentTools
 */
export function mountAgentTools(api, _helpers, { tools }) {
    api.post("/agent/:tool", async (req, res) => {
        const name = req.params.tool
        if (!TOOL_NAMES.includes(name) || typeof tools[name] !== "function")
            throw new NotFoundError(`tool ${name}`)
        const result = await tools[name](
            req.body || {},
            contextFromHeaders(req.headers)
        )
        res.json(result)
    })
}
