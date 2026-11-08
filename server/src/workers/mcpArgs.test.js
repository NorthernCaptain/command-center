/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import fs from "node:fs"
import {
    DEFAULT_HEADERS_HELPER,
    MCP_SERVER_NAME,
    mcpLaunchArgs,
} from "./mcpArgs.js"

const URL_ = "http://127.0.0.1:7788/mcp"

describe("mcpLaunchArgs", () => {
    test("claude: one --mcp-config JSON with the helper (no strict mode)", () => {
        const args = mcpLaunchArgs("claude", {
            url: URL_,
            headersHelper: "/h.sh",
        })
        expect(args).toEqual([
            "--mcp-config",
            JSON.stringify({
                mcpServers: {
                    [MCP_SERVER_NAME]: {
                        type: "http",
                        url: URL_,
                        headersHelper: "/h.sh",
                    },
                },
            }),
        ])
        expect(args).not.toContain("--strict-mcp-config")
    })

    test("codex: -c overrides reading the token and task from the env", () => {
        expect(mcpLaunchArgs("codex", { url: URL_ })).toEqual([
            "-c",
            'mcp_servers.command-center.url="http://127.0.0.1:7788/mcp"',
            "-c",
            'mcp_servers.command-center.bearer_token_env_var="CC_TOKEN"',
            "-c",
            'mcp_servers.command-center.env_http_headers={ "X-CC-Task" = "CC_TASK_ID" }',
        ])
    })

    test("other kinds or no url: nothing", () => {
        expect(mcpLaunchArgs("gemini", { url: URL_ })).toEqual([])
        expect(mcpLaunchArgs("claude", {})).toEqual([])
        expect(mcpLaunchArgs("claude")).toEqual([])
    })

    test("the default helper exists in this checkout", () => {
        expect(fs.existsSync(DEFAULT_HEADERS_HELPER)).toBe(true)
        const args = mcpLaunchArgs("claude", { url: URL_ })
        expect(
            JSON.parse(args[1]).mcpServers[MCP_SERVER_NAME].headersHelper
        ).toBe(DEFAULT_HEADERS_HELPER)
    })
})
