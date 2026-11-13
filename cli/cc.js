#!/usr/bin/env node
/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// `cc` — command center CLI. Talks to the local listener (127.0.0.1:7788)
// with the bearer token from <configDir>/token.
//
// Worker environment (set by the service in the herdr workspace):
// CC_TOKEN overrides the token file, CC_URL overrides host/port (loopback
// http only, so the token never leaves the machine) and CC_TASK_ID is sent
// as X-CC-Task on agent tool calls (the server rejects writes to another
// task) and is the default id of `cc task`.
//
// Known limitation (token exposure): the bearer token is sent to whatever
// process is listening on the configured local host:port. If the command
// center is not running and another local process has taken that port, it
// receives the token. There is no portable way to check which user owns
// the listening process, and an "is this ours" probe would itself need a
// shared secret, so this is accepted: the attacker must already run code
// as some local user and win the port while the server is down. Rotate the
// token (delete <configDir>/token and restart) if that is suspected.
//
// `cc open` only hands the browser a URL that is exactly a loopback
// bootstrap link (BOOTSTRAP_URL_RE), and passes it after "--" so it can
// never be read as an option of open(1).

import { execFile } from "node:child_process"
import nodeFs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const USAGE = `Usage: cc <command> [args]

Commands:
  add <text...>             capture a task (URLs and "remind me ..." understood)
  ls [--status s[,s]] [--q text] [--limit n]
                            list tasks
  show <id>                 show a task and its artifact
  done <id>                 mark a task done
  remind <when> <text...>   create a reminder ("2h", "tomorrow 9am", ...)
  open                      open the web UI logged in (desktop browser)
  pair                      print a 6-digit code to pair a phone
  reindex                   rebuild the search index from tasks/
  help                      show this help

Worker tools (CC_TASK_ID / CC_URL / CC_TOKEN are read from the environment):
  task [id] [--json]        task brief: artifact revision, deliverables, open feedback
  progress <id> <text...>   append a progress note
  decision <id> <decision...> -- <rationale...>
                            log a decision
  link <id> <type> <url> [--role ref|work|main] [--repo r] [--label l] [--branch b]
                            register a folder / branch / pr / doc link
  report <id> <status> <summary...> [--repos a,b] [--no-change a,b] [--checks t] [--next t]
                            status: ready_for_pr | review | blocked | progress
  feedback <id> <item> <status> [--commit sha] [--reply url] [--note t]
                            resolve a PR feedback item: fixed | answered | declined
  schedule <id> <when> <action> [prompt...]
                            action: surface | prompt_agent | center_job
  reparent <id> <parent>    move a task of your task's family under another parent
`

const COMMANDS = [
    "add",
    "ls",
    "show",
    "done",
    "remind",
    "open",
    "pair",
    "reindex",
    "help",
    "task",
    "progress",
    "decision",
    "link",
    "report",
    "feedback",
    "schedule",
    "reparent",
]

/** CC_URL must be a loopback http(s) origin: the token goes there. */
export const LOCAL_URL_RE =
    /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?\/?$/

export class UsageError extends Error {}

/** The only URL shape `cc open` will pass to open(1). */
export const BOOTSTRAP_URL_RE =
    /^http:\/\/(127\.0\.0\.1|localhost):\d+\/auth\/bootstrap\?t=[0-9a-f]+$/

/** True when a server-returned URL is a loopback bootstrap link. */
export function isBootstrapUrl(url) {
    return typeof url === "string" && BOOTSTRAP_URL_RE.test(url)
}

/**
 * Parse argv (without node/script). Flags: --name value, --name=value,
 * boolean -h/--help. Returns { command, args, flags }, plus `dash` (the
 * index in args where the words after "--" start) when "--" was given.
 */
export function parseArgs(argv) {
    const args = []
    const flags = {}
    let command = null
    let dash = null
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === "--") {
            dash = args.length
            args.push(...argv.slice(i + 1))
            break
        }
        if (a === "-h" || a === "--help") {
            flags.help = true
            continue
        }
        if (a.startsWith("--") && a.length > 2) {
            const eq = a.indexOf("=")
            if (eq > 0) {
                flags[a.slice(2, eq)] = a.slice(eq + 1)
            } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
                flags[a.slice(2)] = argv[++i]
            } else {
                flags[a.slice(2)] = true
            }
            continue
        }
        if (command === null) command = a
        else args.push(a)
    }
    if (flags.help && !command) command = "help"
    const out = { command: command || "help", args, flags }
    if (dash !== null) out.dash = dash
    return out
}

/** One-line task summary: "T-12  [waiting]  Title  (due ...)". */
export function formatTask(task) {
    const key = `T-${task.id}`.padEnd(7)
    const status = `[${task.status}]`.padEnd(15)
    let line = `${key}${status}${task.title}`
    if (task.due_at) line += `  (due ${task.due_at})`
    if (task.flags && task.flags.now) line += "  *now*"
    return line
}

function taskId(raw) {
    const m = /^(?:T-)?(\d+)$/i.exec(String(raw || ""))
    if (!m) throw new UsageError(`invalid task id: ${raw ?? "(missing)"}`)
    return Number(m[1])
}

/** Text flag value or undefined (a bare "--flag" is not a value). */
function flagText(flags, name) {
    return typeof flags[name] === "string" ? flags[name] : undefined
}

/** Multi-line brief for `cc task`. */
export function formatBrief(brief) {
    const t = brief.task
    const lines = [formatTask(t), `artifact revision: ${brief.revision}`]
    const repos = (t.repos || []).map((r) => `${r.name} (${r.role})`)
    if (repos.length) lines.push(`repos: ${repos.join(", ")}`)
    if (t.branch || t.slug)
        lines.push(`branch: ${t.branch || "-"}  slug: ${t.slug || "-"}`)
    for (const d of brief.deliverables || [])
        lines.push(
            `deliverable: ${d.repo}@${d.branch} ${d.disposition}${d.pr ? ` ${d.pr}` : ""}`
        )
    for (const f of brief.feedback_open || [])
        lines.push(
            `feedback open: ${f.id}  ${f.kind}${f.path ? `  ${f.path}${f.line ? `:${f.line}` : ""}` : ""}  ${f.url}`
        )
    const comments = (brief.open_comments || []).length
    if (comments) lines.push(`open comments: ${comments}`)
    if (brief.asana_url) lines.push(`asana: ${brief.asana_url}`)
    if (brief.artifact) lines.push("", brief.artifact)
    return lines.join("\n")
}

/** open(1) runner; "--" ends option parsing before the URL. */
export function createOpenUrl(execFileFn = execFile) {
    return (url) =>
        new Promise((resolve, reject) => {
            execFileFn("open", ["--", url], (err) =>
                err ? reject(err) : resolve()
            )
        })
}

const defaultOpenUrl = createOpenUrl()

/**
 * Run the CLI. Returns the exit code.
 * @param {string[]} argv
 * @param {object} deps { fetch, readFile, openUrl, stdout, stderr, config,
 *   env } (env: CC_TASK_ID / CC_URL / CC_TOKEN)
 */
export async function run(argv, deps) {
    const {
        fetch: fetchFn,
        readFile,
        openUrl = defaultOpenUrl,
        stdout,
        stderr,
        config,
        env = {},
    } = deps
    const out = (s) => stdout.write(s.endsWith("\n") ? s : s + "\n")
    const err = (s) => stderr.write(s.endsWith("\n") ? s : s + "\n")
    const { command, args, flags, dash } = parseArgs(argv)

    // "--help" anywhere shows usage and does nothing else (`cc done 12
    // --help` must not mark T-12 done).
    if (command === "help" || flags.help) {
        out(USAGE)
        return 0
    }
    if (!COMMANDS.includes(command)) {
        err(`unknown command: ${command}\n\n${USAGE}`)
        return 2
    }

    const { host, port } = config.listeners.local
    let base = `http://${host}:${port}`
    if (env.CC_URL) {
        if (!LOCAL_URL_RE.test(env.CC_URL)) {
            err("CC_URL must be a loopback URL like http://127.0.0.1:7788")
            return 1
        }
        base = env.CC_URL.replace(/\/$/, "")
    }
    let token = env.CC_TOKEN ? String(env.CC_TOKEN).trim() : ""
    if (!token) {
        try {
            token = String(
                await readFile(path.join(config.configDir, "token"), "utf8")
            ).trim()
        } catch (e) {
            err(
                `cannot read token in ${config.configDir} (${e.code || e.message}); ` +
                    "is the command center running?"
            )
            return 1
        }
    }
    const envTask = env.CC_TASK_ID ? String(env.CC_TASK_ID).trim() : ""

    async function api(method, urlPath, body, extraHeaders = {}) {
        const init = {
            method,
            headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
        }
        if (body !== undefined) {
            init.headers["Content-Type"] = "application/json"
            init.body = JSON.stringify(body)
        }
        let res
        try {
            res = await fetchFn(base + urlPath, init)
        } catch (e) {
            throw new Error(`cannot reach ${base}: ${e.message}`)
        }
        let data = null
        const text = await res.text()
        try {
            data = text ? JSON.parse(text) : null
        } catch {
            data = { message: text }
        }
        if (!res.ok) {
            let msg = (data && (data.message || data.error)) || res.statusText
            const issue =
                data && data.details && Array.isArray(data.details.issues)
                    ? data.details.issues[0]
                    : null
            if (issue)
                msg += ` (${(issue.path || []).join(".") || "args"}: ${issue.message})`
            throw new Error(`${res.status} ${msg}`)
        }
        return data
    }

    /** Worker tool call through the REST mirror. */
    const tool = (name, args) =>
        api(
            "POST",
            `/api/agent/${name}`,
            args,
            envTask ? { "X-CC-Task": envTask } : {}
        )
    const words = (list) => list.join(" ").trim()

    try {
        switch (command) {
            case "add": {
                const text = args.join(" ").trim()
                if (!text) throw new UsageError("cc add <text...>")
                // No source_type: the server classifies a Slack/Asana URL
                // in the text and fetches it during enrich.
                const { task } = await api("POST", "/api/tasks", { text })
                out(formatTask(task))
                return 0
            }
            case "ls": {
                const qs = new URLSearchParams()
                if (typeof flags.status === "string")
                    qs.set("status", flags.status)
                if (typeof flags.q === "string") qs.set("q", flags.q)
                if (typeof flags.limit === "string")
                    qs.set("limit", flags.limit)
                const query = qs.toString()
                const { tasks, total } = await api(
                    "GET",
                    "/api/tasks" + (query ? `?${query}` : "")
                )
                for (const t of tasks) out(formatTask(t))
                if (total > tasks.length)
                    out(`(${tasks.length} of ${total} shown)`)
                if (!tasks.length) out("no tasks")
                return 0
            }
            case "show": {
                const id = taskId(args[0])
                const data = await api("GET", `/api/tasks/${id}`)
                out(formatTask(data.task))
                if (data.artifact && data.artifact.content)
                    out("\n" + data.artifact.content)
                return 0
            }
            case "done": {
                const id = taskId(args[0])
                const { task, job, close_out } = await api(
                    "PATCH",
                    `/api/tasks/${id}`,
                    { patch: { status: "done" } }
                )
                out(formatTask(task))
                // Asana-linked tasks close out in the background (Result
                // section, Asana comment + completion, then done).
                if (close_out)
                    out(
                        `close-out ${close_out === "pending" ? "already running" : "started"}${job && job.id ? ` (${job.id})` : ""}`
                    )
                return 0
            }
            case "remind": {
                const [when, ...rest] = args
                const text = rest.join(" ").trim()
                if (!when || !text)
                    throw new UsageError("cc remind <when> <text...>")
                const { task } = await api("POST", "/api/tasks", {
                    text,
                    when,
                    kind: "reminder",
                    source_type: "manual",
                })
                out(formatTask(task))
                return 0
            }
            case "open": {
                const { url } =
                    (await api("POST", "/api/auth/bootstrap-token")) || {}
                if (!isBootstrapUrl(url))
                    throw new Error(
                        "server returned an unexpected bootstrap URL; not opening it"
                    )
                await openUrl(url)
                out("opened the command center in your browser")
                return 0
            }
            case "pair": {
                const { code, expires_at } = await api("POST", "/api/pair/code")
                out(`Pairing code: ${code}`)
                out(
                    `Enter it on your phone within 10 minutes (expires ${expires_at}).`
                )
                return 0
            }
            case "reindex": {
                const { count } = await api("POST", "/api/admin/reindex")
                out(`reindexed ${count} tasks`)
                return 0
            }
            case "task": {
                const id = taskId(args[0] ?? (envTask || undefined))
                const brief = await tool("cc_get_task", { task_id: id })
                out(
                    flags.json
                        ? JSON.stringify(brief, null, 2)
                        : formatBrief(brief)
                )
                return 0
            }
            case "progress": {
                const id = taskId(args[0])
                const summary = words(args.slice(1))
                if (!summary) throw new UsageError("cc progress <id> <text...>")
                await tool("cc_report", {
                    task_id: id,
                    status: "progress",
                    summary,
                })
                out(`progress recorded on T-${id}`)
                return 0
            }
            case "decision": {
                const usage = "cc decision <id> <decision...> -- <rationale...>"
                const id = taskId(args[0])
                if (dash === undefined || dash < 1) throw new UsageError(usage)
                const decision = words(args.slice(1, dash))
                const rationale = words(args.slice(dash))
                if (!decision || !rationale) throw new UsageError(usage)
                const { line } = await tool("cc_log_decision", {
                    task_id: id,
                    decision,
                    rationale,
                })
                out(line)
                return 0
            }
            case "link": {
                const [rawId, type, url] = args
                const id = taskId(rawId)
                if (!type || !url)
                    throw new UsageError(
                        "cc link <id> <type> <url> [--role r] [--repo r] [--label l]"
                    )
                const body = { task_id: id, type, url }
                for (const k of ["role", "repo", "label", "branch"])
                    if (flagText(flags, k) !== undefined) body[k] = flags[k]
                const r = await tool("cc_add_link", body)
                if (r.ok === false) {
                    const why = r.conflict || r.reason || "rejected"
                    err(
                        `not linked: ${why}${r.suggestion ? `; suggestion: ${r.suggestion}` : ""}`
                    )
                    return 1
                }
                out(`linked ${type} ${url} to T-${id}`)
                return 0
            }
            case "report": {
                const [rawId, status, ...rest] = args
                const id = taskId(rawId)
                const summary = words(rest)
                if (!status || !summary)
                    throw new UsageError(
                        "cc report <id> <status> <summary...> [--repos a,b] [--no-change a,b] [--checks t] [--next t]"
                    )
                const body = { task_id: id, status, summary }
                const repos = flagText(flags, "repos")
                if (repos !== undefined)
                    body.work_repos = repos
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean)
                const noChange = flagText(flags, "no-change")
                if (noChange !== undefined)
                    body.no_change_repos = noChange
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean)
                if (flagText(flags, "checks") !== undefined)
                    body.checks = flags.checks
                if (flagText(flags, "next") !== undefined)
                    body.next_steps = flags.next
                const r = await tool("cc_report", body)
                if (r.ok === false) {
                    const m = r.mismatch || {}
                    err(
                        `work repos differ: reported ${(m.reported || []).join(", ")}; deliverables ${(m.deliverables || []).join(", ") || "none"} (flagged for Leo)`
                    )
                    return 1
                }
                out(`T-${id} ${status} reported (status: ${r.status})`)
                return 0
            }
            case "feedback": {
                const [rawId, item, status] = args
                const id = taskId(rawId)
                if (!item || !status)
                    throw new UsageError(
                        "cc feedback <id> <item> <status> [--commit sha] [--reply url] [--note t]"
                    )
                const body = { task_id: id, item_id: item, status }
                if (flagText(flags, "commit") !== undefined)
                    body.commit = flags.commit
                if (flagText(flags, "reply") !== undefined)
                    body.reply_url = flags.reply
                if (flagText(flags, "note") !== undefined)
                    body.note = flags.note
                const r = await tool("cc_feedback", body)
                out(
                    `${item} ${status}${r.round_resolved ? ` (round ${r.round} resolved)` : ""}`
                )
                return 0
            }
            case "reparent": {
                const [rawId, rawParent] = args
                const id = taskId(rawId)
                if (!rawParent)
                    throw new UsageError("cc reparent <id> <parent>")
                const parent = taskId(rawParent)
                const r = await tool("cc_reparent_task", {
                    task_id: id,
                    parent_id: parent,
                })
                out(
                    r.unchanged
                        ? `T-${id} already under T-${parent}`
                        : `T-${id} moved under T-${parent}${r.previous_parent_id ? ` (was T-${r.previous_parent_id})` : ""}`
                )
                return 0
            }
            case "schedule": {
                const [rawId, when, action, ...rest] = args
                const id = taskId(rawId)
                if (!when || !action)
                    throw new UsageError(
                        "cc schedule <id> <when> <action> [prompt...]"
                    )
                const body = { task_id: id, at: when, action }
                const prompt = words(rest)
                if (prompt) body.prompt = prompt
                const { schedule } = await tool("cc_schedule", body)
                out(
                    `scheduled ${action} for T-${id} at ${schedule && schedule.fire_at}`
                )
                return 0
            }
        }
    } catch (e) {
        if (e instanceof UsageError) {
            err(`usage: ${e.message}`)
            return 2
        }
        err(`cc: ${e.message}`)
        return 1
    }
    /* istanbul ignore next */
    return 0
}

/* istanbul ignore next */
async function main() {
    const { loadConfig } = await import("../server/src/config/config.js")
    const config = loadConfig()
    process.exitCode = await run(process.argv.slice(2), {
        fetch: globalThis.fetch,
        readFile: (p, enc) => nodeFs.promises.readFile(p, enc),
        openUrl: defaultOpenUrl,
        stdout: process.stdout,
        stderr: process.stderr,
        config,
        env: process.env,
    })
}

/* istanbul ignore next */
function isMain() {
    if (!process.argv[1]) return false
    try {
        const self = fileURLToPath(import.meta.url)
        return (
            nodeFs.realpathSync(process.argv[1]) === nodeFs.realpathSync(self)
        )
    } catch {
        return import.meta.url === pathToFileURL(process.argv[1]).href
    }
}

/* istanbul ignore next */
if (isMain()) main()
