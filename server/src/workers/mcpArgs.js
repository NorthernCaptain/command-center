/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { baseKind } from "../contracts/agentKinds.js"

// Launch flags that give a worker the command-center MCP server directly,
// so a worker never depends on a global registration (~/.claude.json,
// ~/.codex/config.toml). No secret goes on the command line: the token and
// the task id come from the workspace env (CC_TOKEN, CC_TASK_ID) that the
// worker service sets.
//
// - claude: --mcp-config '{"mcpServers":{"command-center":{type:"http",
//   url, headersHelper}}}'. The helper (install/mcp-headers.sh) prints the
//   Authorization and X-CC-Task headers from that env. Other MCP servers
//   stay loaded (no --strict-mcp-config); a global "command-center" entry
//   is the same server.
// - codex: -c overrides of mcp_servers.command-center (url,
//   bearer_token_env_var = CC_TOKEN, env_http_headers X-CC-Task =
//   CC_TASK_ID), merged over any global entry. A PR review agent sends
//   X-CC-Review = CC_REVIEW_ID instead (headerEnv).

import { fileURLToPath } from "node:url"

export const MCP_SERVER_NAME = "command-center"

/** install/mcp-headers.sh in this checkout. */
export const DEFAULT_HEADERS_HELPER = fileURLToPath(
    new URL("../../../install/mcp-headers.sh", import.meta.url)
)

export const tomlString = (s) => JSON.stringify(String(s))

/**
 * Launch flags that keep an agent from stopping at a startup dialog before
 * it takes its prompt: codex shows an "Update available" notice (enter /
 * esc) that blocks the start or swallows the first prompt.
 */
export function quietLaunchArgs(kind) {
    return baseKind(kind) === "codex"
        ? ["-c", "check_for_update_on_startup=false"]
        : []
}

/** Caller headers a task worker sends: header -> env var. */
export const TASK_HEADER_ENV = { "X-CC-Task": "CC_TASK_ID" }
/** Caller headers a PR review agent sends. */
export const REVIEW_HEADER_ENV = { "X-CC-Review": "CC_REVIEW_ID" }

/**
 * Args to put before the agent's own args (resume etc.).
 * @param {string} kind  an agent kind (by its CLI: claude | codex; anything
 *        else: none)
 * @param {{ url: string, headersHelper?: string, headerEnv?: object }} opts
 *        headerEnv: codex env_http_headers (claude's helper reads the env)
 * @returns {string[]}
 */
export function mcpLaunchArgs(
    kind,
    {
        url,
        headersHelper = DEFAULT_HEADERS_HELPER,
        headerEnv = TASK_HEADER_ENV,
    } = {}
) {
    if (!url) return []
    kind = baseKind(kind)
    if (kind === "claude") {
        const config = {
            mcpServers: {
                [MCP_SERVER_NAME]: { type: "http", url, headersHelper },
            },
        }
        return ["--mcp-config", JSON.stringify(config)]
    }
    if (kind === "codex") {
        const key = `mcp_servers.${MCP_SERVER_NAME}`
        return [
            "-c",
            `${key}.url=${tomlString(url)}`,
            "-c",
            `${key}.bearer_token_env_var="CC_TOKEN"`,
            "-c",
            `${key}.env_http_headers={ ${Object.entries(headerEnv)
                .map(([h, env]) => `"${h}" = "${env}"`)
                .join(", ")} }`,
        ]
    }
    return []
}
