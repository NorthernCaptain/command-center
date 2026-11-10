/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Brain (TraceBot) client over the tracebot-mcp HTTP MCP server. The server
// entry (url + auth headers) is read from the Claude config file at connect
// time. Headers are never logged.

import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { AppError } from "../../util/errors.js"

export const JOB_ID_RE = /j_[0-9a-f]{24}/
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/
const MAX_WAIT_SECONDS = 40

const RUNNING = new Set([
    "running",
    "queued",
    "pending",
    "working",
    "parked",
    "in_progress",
    "started",
])
const DONE = new Set([
    "done",
    "completed",
    "complete",
    "succeeded",
    "success",
    "finished",
])
const FAILED = new Set([
    "failed",
    "failure",
    "error",
    "errored",
    "cancelled",
    "canceled",
    "stopped",
    "timeout",
    "timed_out",
])

/** Default factory: a connected @modelcontextprotocol/sdk Client. */
export async function defaultMcpClientFactory({ url, headers }) {
    const client = new Client({ name: "command-center", version: "0.1.0" })
    const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: headers || {} },
    })
    await client.connect(transport)
    return client
}

function textOf(result) {
    return (result?.content || [])
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
}

function tryJson(text) {
    const t = String(text || "").trim()
    if (!t.startsWith("{")) return null
    try {
        return JSON.parse(t)
    } catch {
        return null
    }
}

/** Tool result -> plain object (structuredContent, JSON text) or null. */
function payloadOf(result) {
    if (
        result?.structuredContent &&
        typeof result.structuredContent === "object"
    ) {
        return result.structuredContent
    }
    return tryJson(textOf(result))
}

export function extractJobId(result) {
    const payload = payloadOf(result)
    const candidates = [
        payload?.job_id,
        payload?.jobId,
        payload?.job?.id,
        textOf(result),
    ]
    for (const c of candidates) {
        const m = typeof c === "string" ? JOB_ID_RE.exec(c) : null
        if (m) return m[0]
    }
    return null
}

export function normalizeStatus(value) {
    const s = String(value || "")
        .toLowerCase()
        .trim()
    if (DONE.has(s)) return "done"
    if (FAILED.has(s)) return "failed"
    if (RUNNING.has(s)) return "running"
    return null
}

function lineField(text, name) {
    const re = new RegExp(
        `^\\s*[*_\`]*${name}[*_\`]*\\s*[:=]\\s*[*_\`]*([A-Za-z_]+)`,
        "im"
    )
    const m = re.exec(text)
    return m ? m[1] : null
}

// brain_job_result text: status lines, a transcript link, a banner, then
// Brain's own words between <<<BRAIN OUTPUT <tag> (untrusted)>>> markers
const OUTPUT_RE =
    /<<<BRAIN OUTPUT ([A-Za-z0-9]+)[^>\n]*>>>\r?\n?([\s\S]*?)\r?\n?<<<END BRAIN OUTPUT \1>>>/
const TRANSCRIPT_RE = /^\s*transcript[^:\n]*:\s*(https?:\/\/\S+)/im

/**
 * Brain's own answer out of a brain_job_result text (without its "title:"
 * line) and the transcript link: { output, transcript }, nulls when absent.
 */
export function brainOutput(text) {
    const t = String(text || "")
    const m = OUTPUT_RE.exec(t)
    const tr = TRANSCRIPT_RE.exec(t)
    const output = m
        ? m[2].replace(/^\s*title:[^\n]*(\n|$)/i, "").trim() || null
        : null
    return { output, transcript: tr ? tr[1] : null }
}

/**
 * Normalize a brain_job_result tool result.
 * @returns {{ status: "running"|"done"|"failed", answer: string|null,
 *   phase: string|null, error: string|null, transcript?: string }}
 * A text result with Brain's output markers answers with Brain's own words
 * only (not the status lines and the banner around them).
 */
export function normalizeJobResult(result) {
    const payload = payloadOf(result)
    const text = textOf(result)
    if (payload) {
        const job =
            payload.job && typeof payload.job === "object"
                ? payload.job
                : payload
        const status =
            normalizeStatus(job.status ?? payload.status) ||
            (result?.isError ? "failed" : "running")
        const answer =
            job.answer ?? job.result ?? job.output ?? payload.answer ?? null
        return {
            status,
            answer:
                answer == null
                    ? null
                    : typeof answer === "string"
                      ? answer
                      : JSON.stringify(answer),
            phase: job.phase ?? payload.phase ?? null,
            error: job.error ?? payload.error ?? null,
        }
    }
    let status = normalizeStatus(lineField(text, "status"))
    if (!status)
        status = result?.isError ? "failed" : text.trim() ? "done" : "running"
    const phase = lineField(text, "phase")
    const { output, transcript } = brainOutput(text)
    let answer = null
    if (status === "done") {
        const m = /(^|\n)\s*[*_]*answer[*_]*\s*:\s*\n?([\s\S]*)$/i.exec(text)
        answer = output || (m ? m[2] : text).trim() || null
    }
    return {
        status,
        answer,
        phase: phase ? phase.toLowerCase() : null,
        error: status === "failed" ? output || text.trim() || null : null,
        ...(transcript ? { transcript } : {}),
    }
}

/**
 * @param {{ readFile?: Function, claudeConfigPath: string, serverName: string,
 *           mcpClientFactory?: Function, log?: object }} deps
 */
export function createBrainClient({
    readFile = (p) => fs.readFile(p, "utf8"),
    claudeConfigPath,
    serverName,
    mcpClientFactory = defaultMcpClientFactory,
    log,
} = {}) {
    let connecting = null // Promise<client>

    async function loadServer() {
        let json
        try {
            json = JSON.parse(await readFile(claudeConfigPath, "utf8"))
        } catch (err) {
            throw new AppError(
                "brain_not_configured",
                `cannot read Claude config: ${err?.code || err?.message}`,
                { status: 503 }
            )
        }
        const entry = json?.mcpServers?.[serverName]
        let problem = null
        if (!entry || typeof entry !== "object") {
            problem = "not found in Claude config"
        } else if (entry.type && entry.type !== "http") {
            problem = `must be type "http" (got "${entry.type}")`
        } else if (typeof entry.url !== "string" || !entry.url) {
            problem = "has no url"
        }
        if (problem) {
            throw new AppError(
                "brain_not_configured",
                `MCP server "${serverName}" ${problem}`,
                { status: 503 }
            )
        }
        return { url: entry.url, headers: entry.headers || {} }
    }

    function connect() {
        if (!connecting) {
            const pending = (async () => {
                const server = await loadServer()
                log?.debug?.({ server: serverName }, "brain connecting")
                return mcpClientFactory(server)
            })()
            connecting = pending
            pending.catch(() => {
                if (connecting === pending) connecting = null
            })
        }
        return connecting
    }

    async function drop() {
        const pending = connecting
        connecting = null
        if (!pending) return
        try {
            const client = await pending
            await client?.close?.()
        } catch {
            // already broken
        }
    }

    async function callTool(name, args) {
        let result
        for (let attempt = 0; ; attempt++) {
            try {
                const client = await connect()
                result = await client.callTool({ name, arguments: args })
                break
            } catch (err) {
                if (
                    err instanceof AppError &&
                    err.code === "brain_not_configured"
                )
                    throw err
                await drop()
                if (attempt >= 1) {
                    throw new AppError(
                        "brain_error",
                        `Brain ${name} failed: ${err?.message}`,
                        {
                            status: 502,
                        }
                    )
                }
                log?.warn?.(
                    { tool: name, err: err?.message },
                    "brain call failed, reconnecting"
                )
            }
        }
        return result
    }

    /** @returns {Promise<string>} Brain job id */
    async function start({ prompt, title, idempotencyKey } = {}) {
        if (!prompt) throw new AppError("brain_error", "prompt required")
        const key = IDEMPOTENCY_RE.test(idempotencyKey || "")
            ? idempotencyKey
            : randomUUID()
        const args = { prompt, idempotency_key: key }
        if (title) args.title = String(title).slice(0, 120)
        const result = await callTool("brain_do", args)
        if (result?.isError) {
            throw new AppError(
                "brain_error",
                `brain_do failed: ${textOf(result).slice(0, 500)}`,
                {
                    status: 502,
                }
            )
        }
        const jobId = extractJobId(result)
        if (!jobId)
            throw new AppError("brain_error", "brain_do returned no job id", {
                status: 502,
            })
        log?.info?.({ brain_job: jobId }, "brain job started")
        return jobId
    }

    async function result(jobId, { waitSeconds = 0 } = {}) {
        if (!/^j_[0-9a-f]{24}$/.test(String(jobId))) {
            throw new AppError("brain_error", "invalid Brain job id")
        }
        const wait = Math.max(
            0,
            Math.min(MAX_WAIT_SECONDS, Math.floor(Number(waitSeconds) || 0))
        )
        const res = await callTool("brain_job_result", {
            job_id: jobId,
            wait_seconds: wait,
        })
        return normalizeJobResult(res)
    }

    async function close() {
        await drop()
    }

    return { start, result, close }
}
