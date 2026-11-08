/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// /mcp handler: the worker tools over MCP Streamable HTTP, stateless (a new
// McpServer + transport per POST, no session ids). Mounted by createApp on
// the local listener behind the bearer token. X-CC-Task / X-CC-Agent
// headers become the tool ctx (wrong-task check, actor).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { mapError } from "../http/app.js"
import { nullLogger } from "../util/logger.js"
import { contextFromHeaders, TOOL_DESCRIPTIONS, TOOL_SCHEMAS } from "./tools.js"

export const SERVER_INFO = { name: "command-center", version: "1.0.0" }

/** Tool result -> MCP content. */
export function toResult(value) {
    return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

/** Error -> MCP error result ({ error, message, details }). */
export function toErrorResult(err, log = nullLogger) {
    const { status, body } = mapError(err)
    if (status >= 500)
        log.error(
            { err: err && err.message, stack: err && err.stack },
            "agent tool failed"
        )
    return { ...toResult(body), isError: true }
}

/** A fresh McpServer exposing every tool, bound to one request's ctx. */
export function buildMcpServer({ tools, ctx, log = nullLogger }) {
    const server = new McpServer(SERVER_INFO)
    for (const [name, schema] of Object.entries(TOOL_SCHEMAS)) {
        server.registerTool(
            name,
            { description: TOOL_DESCRIPTIONS[name], inputSchema: schema.shape },
            async (args) => {
                try {
                    return toResult(await tools[name](args, ctx))
                } catch (err) {
                    return toErrorResult(err, log)
                }
            }
        )
    }
    return server
}

/**
 * Express handler for /mcp.
 * @param {{ tools: object, log?: object }} deps tools from createAgentTools
 */
export function createMcpHandler({ tools, log = nullLogger }) {
    return async function mcpHandler(req, res) {
        if (req.method !== "POST") {
            res.setHeader("Allow", "POST")
            res.status(405).json({
                jsonrpc: "2.0",
                error: { code: -32000, message: "Method not allowed." },
                id: null,
            })
            return
        }
        const ctx = contextFromHeaders(req.headers)
        const server = buildMcpServer({ tools, ctx, log })
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        })
        res.on("close", () => {
            transport.close().catch(() => {})
            server.close().catch(() => {})
        })
        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)
    }
}
