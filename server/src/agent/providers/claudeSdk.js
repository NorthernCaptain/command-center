/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Claude Agent SDK provider (in-process; uses the local Claude login, no API
// key). Built-in tools are disabled; only the MCP servers a job passes are
// connected, and only the exact tool names the job allows can be called
// (see toolPolicy.js: allow-list + dontAsk + deny-list + canUseTool).
// Guarded tools (brain_do acts as Leo) get their input rewritten with the
// read-only prefix in two places: a PreToolUse hook (runs for every call,
// also when the allow-list pre-approves the tool and canUseTool is skipped;
// onFailure "block" so a failing hook never lets the raw input through) and
// canUseTool (when the call does reach the permission callback).

import { systemClock } from "../../util/clock.js"
import {
    abortedError,
    createClaudeCollector,
    providerFailed,
    timeoutError,
} from "./common.js"
import {
    guardToolInput,
    isGuardedTool,
    resolveToolPolicy,
} from "./toolPolicy.js"

export const CLAUDE_SDK = "claude-sdk"

/**
 * canUseTool that only lets the policy's exact tool names through; guarded
 * tools (brain_do) get the read-only prefix on their prompt.
 */
export function policyCanUseTool(policy) {
    return async (toolName, input) =>
        policy.isAllowed(toolName)
            ? {
                  behavior: "allow",
                  updatedInput: guardToolInput(toolName, input),
              }
            : {
                  behavior: "deny",
                  message: `${toolName} is not allowed for this job`,
              }
}

/**
 * PreToolUse hooks rewriting guarded tools' input (null when the policy
 * allows no guarded tool). A guarded call outside the policy is denied.
 */
export function guardHooks(policy) {
    if (!policy.allowed.some(isGuardedTool)) return null
    const hook = async (input) => {
        const name = input && input.tool_name
        if (!isGuardedTool(name)) return {}
        if (!policy.isAllowed(name))
            return {
                hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: `${name} is not allowed for this job`,
                },
            }
        return {
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                updatedInput: guardToolInput(name, input.tool_input),
            },
        }
    }
    return {
        PreToolUse: [
            // No matcher (every tool): the hook checks the name itself, so
            // matcher pattern semantics can never let a guarded call skip it.
            { hooks: [hook], onFailure: "block" },
        ],
    }
}

/**
 * @param {{ query: Function, cwd?: string, clock?: object, maxTurns?: number,
 *           env?: object }} opts query is `query` from
 *           @anthropic-ai/claude-agent-sdk (injected).
 */
export function createClaudeSdkProvider({
    query,
    cwd,
    clock = systemClock,
    maxTurns = 3,
    mcpMaxTurns = 10,
    env,
}) {
    if (typeof query !== "function") throw new Error("query is required")
    return {
        name: CLAUDE_SDK,
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
            if (signal && signal.aborted) throw abortedError(CLAUDE_SDK)
            const abortController = new AbortController()
            let timedOut = false
            const onAbort = () => abortController.abort()
            if (signal)
                signal.addEventListener("abort", onAbort, { once: true })
            const timer =
                timeoutMs > 0
                    ? clock.setTimeout(() => {
                          timedOut = true
                          abortController.abort()
                      }, timeoutMs)
                    : null
            const hasMcp = mcpServers && Object.keys(mcpServers).length > 0
            const policy = resolveToolPolicy({
                mcpServers: hasMcp ? mcpServers : {},
                allowedTools,
            })
            const options = {
                model,
                maxTurns: hasMcp ? mcpMaxTurns : maxTurns,
                systemPrompt: system,
                tools: [],
                allowedTools: policy.allowed,
                disallowedTools: policy.disallowed,
                canUseTool: policyCanUseTool(policy),
                settingSources: [],
                strictMcpConfig: true,
                persistSession: false,
                permissionMode: "dontAsk",
                outputFormat: { type: "json_schema", schema },
                includePartialMessages: Boolean(onDelta),
                abortController,
            }
            if (hasMcp) options.mcpServers = mcpServers
            const hooks = guardHooks(policy)
            if (hooks) options.hooks = hooks
            if (cwd) options.cwd = cwd
            if (env) options.env = env
            const collector = createClaudeCollector({
                provider: CLAUDE_SDK,
                onDelta,
            })
            try {
                for await (const m of query({ prompt, options })) {
                    collector.feed(m)
                }
            } catch (err) {
                if (timedOut) throw timeoutError(CLAUDE_SDK, timeoutMs)
                if (signal && signal.aborted) throw abortedError(CLAUDE_SDK)
                // The SDK may throw after a result/limit message was seen
                // (e.g. a non-zero exit after the result).
                let done = null
                try {
                    done = collector.finish()
                } catch (inner) {
                    if (inner.code === "provider_limit") throw inner
                }
                if (done)
                    return { output: done.output, usage: done.usage, model }
                throw providerFailed(`${CLAUDE_SDK}: ${err.message}`)
            } finally {
                if (timer != null) clock.clearTimeout(timer)
                if (signal) signal.removeEventListener("abort", onAbort)
            }
            if (timedOut) throw timeoutError(CLAUDE_SDK, timeoutMs)
            if (signal && signal.aborted) throw abortedError(CLAUDE_SDK)
            const { output, usage } = collector.finish()
            return { output, usage, model }
        },
    }
}
