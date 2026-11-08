/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// `claude -p` subprocess provider (fallback when the SDK cannot be used).
// Flags verified against `claude --help`: -p, --model, --output-format
// stream-json (+ --verbose), --include-partial-messages, --json-schema,
// --system-prompt, --tools "", --setting-sources, --strict-mcp-config,
// --mcp-config, --allowedTools, --disallowedTools, --permission-mode dontAsk,
// --no-session-persistence. The prompt goes to stdin because several flags
// are variadic and would swallow a positional. stream-json lines have the same
// shapes as the SDK messages.
// The MCP config (it carries the tracebot API key in its headers) is written
// to a 0600 file in a private temp dir and passed by path, so the secret never
// appears on the command line (ps). The dir is removed after the run.
// Tool scoping: see toolPolicy.js (exact allow-list, dontAsk, deny-list).
// `claude -p` has no canUseTool / hook callback to rewrite tool input, so
// guarded tools (brain_do, which acts as Leo and could post or modify things)
// are never allowed here: an assist "ask" on claude-cli keeps only
// brain_job_result / wiki_search / wiki_read, and brain_do is denied.

import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { systemClock } from "../../util/clock.js"
import { LimitError } from "../../util/errors.js"
import {
    abortedError,
    createClaudeCollector,
    looksLikeLimit,
    providerFailed,
    runProcess,
    safeDelta,
    deltaText,
    tail,
    timeoutError,
} from "./common.js"
import { resolveToolPolicy } from "./toolPolicy.js"

export const CLAUDE_CLI = "claude-cli"

/**
 * @param {{ system, schema, model, mcpServers?, allowedTools?, stream?,
 *           mcpConfigFile? }} opts mcpConfigFile: path of the written MCP
 *           config (required when mcpServers is non-empty).
 */
export function buildClaudeArgs({
    system,
    schema,
    model,
    mcpServers,
    allowedTools,
    stream,
    mcpConfigFile,
}) {
    const args = [
        "-p",
        "--model",
        model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--json-schema",
        JSON.stringify(schema),
        "--system-prompt",
        system,
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--permission-mode",
        "dontAsk",
        "--tools",
        "",
    ]
    if (stream) args.push("--include-partial-messages")
    if (mcpServers && Object.keys(mcpServers).length) {
        if (!mcpConfigFile) throw new Error("mcpConfigFile is required")
        const policy = resolveToolPolicy({
            mcpServers,
            allowedTools,
            canGuardInputs: false,
        })
        args.push("--mcp-config", mcpConfigFile)
        if (policy.allowed.length)
            args.push("--allowedTools", policy.allowed.join(","))
        if (policy.disallowed.length)
            args.push("--disallowedTools", policy.disallowed.join(","))
    }
    return args
}

/** Write the MCP config to a private 0600 file; returns { dir, file }. */
export async function writeMcpConfig(fs, tmpDir, mcpServers) {
    const dir = await fs.mkdtemp(path.join(tmpDir, "cc-claude-mcp-"))
    const file = path.join(dir, "mcp.json")
    await fs.writeFile(file, JSON.stringify({ mcpServers }), { mode: 0o600 })
    return { dir, file }
}

/**
 * @param {{ spawn: Function, bin?: string, cwd?: string, env?: object,
 *           clock?: object, fs?: object, tmpDir?: string }} opts
 *   fs = node:fs/promises (temp MCP config file), tmpDir its parent dir.
 */
export function createClaudeCliProvider({
    spawn,
    bin = "claude",
    cwd,
    env,
    clock = systemClock,
    fs = fsp,
    tmpDir = os.tmpdir(),
}) {
    if (typeof spawn !== "function") throw new Error("spawn is required")
    return {
        name: CLAUDE_CLI,
        async run({
            system,
            prompt,
            schema,
            model,
            signal,
            onDelta,
            mcpServers,
            allowedTools,
            timeoutMs,
        }) {
            if (signal && signal.aborted) throw abortedError(CLAUDE_CLI)
            const hasMcp = mcpServers && Object.keys(mcpServers).length > 0
            let mcp = null
            try {
                if (hasMcp) mcp = await writeMcpConfig(fs, tmpDir, mcpServers)
                return await runOnce({
                    system,
                    prompt,
                    schema,
                    model,
                    signal,
                    onDelta,
                    mcpServers: hasMcp ? mcpServers : null,
                    allowedTools,
                    timeoutMs,
                    mcpConfigFile: mcp ? mcp.file : null,
                })
            } finally {
                if (mcp)
                    await fs
                        .rm(mcp.dir, { recursive: true, force: true })
                        .catch(() => {})
            }
        },
    }

    async function runOnce({
        system,
        prompt,
        schema,
        model,
        signal,
        onDelta,
        mcpServers,
        allowedTools,
        timeoutMs,
        mcpConfigFile,
    }) {
        const collector = createClaudeCollector({ provider: CLAUDE_CLI })
        let seen = 0
        const res = await runProcess({
            spawn,
            bin,
            args: buildClaudeArgs({
                system,
                schema,
                model,
                mcpServers,
                allowedTools,
                stream: Boolean(onDelta),
                mcpConfigFile,
            }),
            stdin: prompt,
            cwd,
            env,
            signal,
            timeoutMs,
            clock,
            onLine(line) {
                let m
                try {
                    m = JSON.parse(line)
                } catch {
                    return
                }
                seen++
                if (m && m.type === "stream_event")
                    safeDelta(onDelta, deltaText(m.event))
                collector.feed(m)
            },
        })
        if (res.timedOut) throw timeoutError(CLAUDE_CLI, timeoutMs)
        if (res.aborted) throw abortedError(CLAUDE_CLI)
        if (seen === 0) {
            const text = tail(`${res.stderr}\n${res.stdout}`)
            if (looksLikeLimit(text))
                throw new LimitError(`${CLAUDE_CLI}: ${text}`)
            throw providerFailed(
                `${CLAUDE_CLI}: exited with code ${res.code}: ${text}`
            )
        }
        const { output, usage } = collector.finish()
        return { output, usage, model }
    }
}
