/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

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
//   CC_TASK_ID), merged over any global entry.

import { fileURLToPath } from "node:url"

export const MCP_SERVER_NAME = "command-center"

/** install/mcp-headers.sh in this checkout. */
export const DEFAULT_HEADERS_HELPER = fileURLToPath(
    new URL("../../../install/mcp-headers.sh", import.meta.url)
)

const tomlString = (s) => JSON.stringify(String(s))

/**
 * Args to put before the agent's own args (resume etc.).
 * @param {string} kind  "claude" | "codex" (anything else: none)
 * @param {{ url: string, headersHelper?: string }} opts
 * @returns {string[]}
 */
export function mcpLaunchArgs(
    kind,
    { url, headersHelper = DEFAULT_HEADERS_HELPER } = {}
) {
    if (!url) return []
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
            `${key}.env_http_headers={ "X-CC-Task" = "CC_TASK_ID" }`,
        ]
    }
    return []
}
