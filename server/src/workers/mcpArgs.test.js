/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import {
    DEFAULT_HEADERS_HELPER,
    MCP_SERVER_NAME,
    REVIEW_HEADER_ENV,
    mcpLaunchArgs,
    quietLaunchArgs,
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

    test("klaude: the same MCP setup as claude (it runs the claude CLI)", () => {
        const opts = { url: URL_, headersHelper: "/h.sh" }
        expect(mcpLaunchArgs("klaude", opts)).toEqual(
            mcpLaunchArgs("claude", opts)
        )
        expect(mcpLaunchArgs("klaude", opts)).not.toEqual([])
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

    test("codex: a review agent sends X-CC-Review", () => {
        expect(
            mcpLaunchArgs("codex", {
                url: URL_,
                headerEnv: REVIEW_HEADER_ENV,
            }).at(-1)
        ).toBe(
            'mcp_servers.command-center.env_http_headers={ "X-CC-Review" = "CC_REVIEW_ID" }'
        )
    })

    test("quietLaunchArgs: codex skips its startup update notice", () => {
        expect(quietLaunchArgs("codex")).toEqual([
            "-c",
            "check_for_update_on_startup=false",
        ])
        expect(quietLaunchArgs("claude")).toEqual([])
        expect(quietLaunchArgs("klaude")).toEqual([])
    })

    test("other kinds or no url: nothing", () => {
        expect(mcpLaunchArgs("gemini", { url: URL_ })).toEqual([])
        expect(mcpLaunchArgs("claude", {})).toEqual([])
        expect(mcpLaunchArgs("claude")).toEqual([])
    })

    test("the headers helper scopes task and review agents", () => {
        const run = (env) =>
            JSON.parse(
                execFileSync("bash", [DEFAULT_HEADERS_HELPER], {
                    env: {
                        PATH: process.env.PATH,
                        CC_CONFIG_DIR: "/nonexistent",
                        CC_TOKEN: "tok123",
                        ...env,
                    },
                    encoding: "utf8",
                })
            )
        const auth = "Bearer tok123"
        expect(run({})).toEqual({ Authorization: auth })
        expect(run({ CC_TASK_ID: "T-12" })).toEqual({
            Authorization: auth,
            "X-CC-Task": "T-12",
        })
        expect(run({ CC_REVIEW_ID: "34" })).toEqual({
            Authorization: auth,
            "X-CC-Review": "34",
        })
        // a task id wins; a malformed review id sends no review header
        expect(run({ CC_TASK_ID: "7", CC_REVIEW_ID: "34" })).toEqual({
            Authorization: auth,
            "X-CC-Task": "7",
        })
        expect(run({ CC_REVIEW_ID: "34; rm" })).toEqual({ Authorization: auth })
        expect(run({ CC_REVIEW_ID: "T-34" })).toEqual({ Authorization: auth })
    })

    test("the default helper exists in this checkout", () => {
        expect(fs.existsSync(DEFAULT_HEADERS_HELPER)).toBe(true)
        const args = mcpLaunchArgs("claude", { url: URL_ })
        expect(
            JSON.parse(args[1]).mcpServers[MCP_SERVER_NAME].headersHelper
        ).toBe(DEFAULT_HEADERS_HELPER)
    })
})
