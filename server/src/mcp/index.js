/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Worker tools: pure handlers, the /mcp handler and the REST mirror.

export {
    agentActor,
    contextFromHeaders,
    createAgentTools,
    toTaskId,
    TOOL_DESCRIPTIONS,
    TOOL_NAMES,
    TOOL_SCHEMAS,
} from "./tools.js"
export {
    buildMcpServer,
    createMcpHandler,
    SERVER_INFO,
    toErrorResult,
    toResult,
} from "./mcpServer.js"
export { mountAgentTools } from "./routes.js"
