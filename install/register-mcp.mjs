#!/usr/bin/env node
/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Register the command-center MCP server and worker skill for Claude Code
// and Codex (install/register-mcp.sh is the entry point). Idempotent; every
// file is backed up (<file>.bak.<ts>) before it is changed; --dry-run only
// reports. Never prints the token.
//
// - ~/.claude.json: mcpServers["command-center"] = { type: "http", url,
//   headersHelper: <repo>/install/mcp-headers.sh } (the helper prints the
//   bearer token and X-CC-Task from $CC_TASK_ID at connect time).
// - ~/.codex/config.toml: a marked block (no TOML parser needed):
//     # command-center:begin (managed — do not edit)
//     [mcp_servers.command-center]
//     url = "http://127.0.0.1:7788/mcp"
//     http_headers = { Authorization = "Bearer <token>" }
//     env_http_headers = { "X-CC-Task" = "CC_TASK_ID" }
//     # command-center:end
//   The file then holds the token, so it is written 0600.
// - Skill: ~/.claude/skills/command-center and ~/.codex/skills/command-center
//   are symlinks to <repo>/skills/command-center.

import nodeFs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const SERVER_NAME = "command-center"
export const BEGIN = "# command-center:begin (managed — do not edit)"
export const END = "# command-center:end"
export const SECRET_MODE = 0o600
export const DEFAULT_URL = "http://127.0.0.1:7788/mcp"

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-")

/** TOML basic string. */
export function tomlString(value) {
    return `"${String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t")}"`
}

/** Matches an unmanaged [mcp_servers.command-center] (sub)table. */
const TABLE_RE =
    /^[ \t]*\[\[?\s*mcp_servers\.("command-center"|command-center)(\.[^\]]*)?\s*\]\]?/m

function fileMode(fs, file, fallback) {
    try {
        return fs.statSync(file).mode & 0o777
    } catch {
        return fallback
    }
}

/** Copy file to <file>.bak.<ts> (same mode). Returns the backup path. */
export function backupFile(fs, file, ts, mode) {
    const bak = `${file}.bak.${ts}`
    fs.copyFileSync(file, bak)
    fs.chmodSync(bak, mode ?? fileMode(fs, file, SECRET_MODE))
    return bak
}

function writeAtomic(fs, file, content, mode) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, content, { mode })
    fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, file)
}

/**
 * Add/replace mcpServers["command-center"] in ~/.claude.json.
 * @returns {{ action, path, backup? }} action: installed | updated |
 *   unchanged (prefixed "would-" in dry-run)
 */
export function mergeClaude({
    claudeJsonPath,
    headersHelperPath,
    url = DEFAULT_URL,
    dryRun = false,
    fs = nodeFs,
    now = timestamp,
}) {
    const desired = { type: "http", url, headersHelper: headersHelperPath }
    const existed = fs.existsSync(claudeJsonPath)
    let root = {}
    if (existed) {
        const raw = fs.readFileSync(claudeJsonPath, "utf8")
        if (raw.trim()) {
            try {
                root = JSON.parse(raw)
            } catch (err) {
                throw new Error(
                    `cannot parse ${claudeJsonPath}: ${err.message}`
                )
            }
            if (!isObj(root))
                throw new Error(`${claudeJsonPath} is not a JSON object`)
        }
    }
    const current = isObj(root.mcpServers)
        ? root.mcpServers[SERVER_NAME]
        : undefined
    if (existed && JSON.stringify(current) === JSON.stringify(desired))
        return { action: label("unchanged", dryRun), path: claudeJsonPath }
    const action = existed ? "updated" : "installed"
    if (dryRun) return { action: label(action, true), path: claudeJsonPath }
    const next = {
        ...root,
        mcpServers: {
            ...(isObj(root.mcpServers) ? root.mcpServers : {}),
            [SERVER_NAME]: desired,
        },
    }
    const mode = fileMode(fs, claudeJsonPath, SECRET_MODE)
    const backup = existed
        ? backupFile(fs, claudeJsonPath, now(), mode)
        : undefined
    writeAtomic(fs, claudeJsonPath, JSON.stringify(next, null, 2) + "\n", mode)
    return { action, path: claudeJsonPath, ...(backup ? { backup } : {}) }
}

/** The managed config.toml block. */
export function codexBlock({ url, token }) {
    return (
        `${BEGIN}\n` +
        `[mcp_servers.${SERVER_NAME}]\n` +
        `url = ${tomlString(url)}\n` +
        `http_headers = { Authorization = ${tomlString(`Bearer ${token}`)} }\n` +
        `env_http_headers = { "X-CC-Task" = "CC_TASK_ID" }\n` +
        `${END}\n`
    )
}

/**
 * Add/replace the marked block in ~/.codex/config.toml (0600).
 * @returns {{ action, path, backup? }}
 */
export function mergeCodex({
    configTomlPath,
    token,
    url = DEFAULT_URL,
    dryRun = false,
    fs = nodeFs,
    now = timestamp,
}) {
    if (!token) throw new Error("empty token")
    const block = codexBlock({ url, token })
    const existed = fs.existsSync(configTomlPath)
    const current = existed ? fs.readFileSync(configTomlPath, "utf8") : ""
    const blockRe = new RegExp(
        `${escapeRegExp(BEGIN)}[\\s\\S]*?${escapeRegExp(END)}\\n?`
    )
    if (TABLE_RE.test(current.replace(blockRe, "")))
        throw new Error(
            `${configTomlPath} already has an unmanaged [mcp_servers.${SERVER_NAME}] table; remove it and rerun`
        )
    let next
    if (blockRe.test(current)) next = current.replace(blockRe, block)
    else if (!current.trim()) next = block
    else next = `${current}${current.endsWith("\n") ? "" : "\n"}\n${block}`

    if (existed && next === current) {
        if (!dryRun) fs.chmodSync(configTomlPath, SECRET_MODE)
        return { action: label("unchanged", dryRun), path: configTomlPath }
    }
    const action = existed ? "updated" : "installed"
    if (dryRun) return { action: label(action, true), path: configTomlPath }
    const backup = existed
        ? backupFile(fs, configTomlPath, now(), SECRET_MODE)
        : undefined
    writeAtomic(fs, configTomlPath, next, SECRET_MODE)
    return { action, path: configTomlPath, ...(backup ? { backup } : {}) }
}

/**
 * Point dest at src with a symlink. Anything else at dest is moved to
 * <dest>.bak.<ts> first.
 * @returns {{ action, path, backup? }}
 */
export function linkSkill({
    src,
    dest,
    dryRun = false,
    fs = nodeFs,
    now = timestamp,
}) {
    let stat = null
    try {
        stat = fs.lstatSync(dest)
    } catch (err) {
        if (err.code !== "ENOENT") throw err
    }
    if (
        stat &&
        stat.isSymbolicLink() &&
        path.resolve(path.dirname(dest), fs.readlinkSync(dest)) ===
            path.resolve(src)
    )
        return { action: label("unchanged", dryRun), path: dest }
    const action = stat ? "updated" : "installed"
    if (dryRun) return { action: label(action, true), path: dest }
    let backup
    if (stat) {
        backup = `${dest}.bak.${now()}`
        fs.renameSync(dest, backup)
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.symlinkSync(src, dest)
    return { action, path: dest, ...(backup ? { backup } : {}) }
}

function label(action, dryRun) {
    return dryRun ? `would-${action}` : action
}

/** argv -> options. */
export function parseOptions(argv, env = {}) {
    const opts = {
        dryRun: false,
        home: env.HOME || os.homedir(),
        repo: null,
        url: null,
        tokenFile: null,
        claude: true,
        codex: true,
    }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        const value = () => {
            const v = argv[++i]
            if (v === undefined || v.startsWith("--"))
                throw new Error(`${a} needs a value`)
            return v
        }
        if (a === "--dry-run") opts.dryRun = true
        else if (a === "--home") opts.home = value()
        else if (a === "--repo") opts.repo = value()
        else if (a === "--url") opts.url = value()
        else if (a === "--token-file") opts.tokenFile = value()
        else if (a === "--no-claude") opts.claude = false
        else if (a === "--no-codex") opts.codex = false
        else throw new Error(`unknown option: ${a}`)
    }
    if (!opts.url) {
        const port = env.CC_LOCAL_PORT || "7788"
        opts.url = `http://127.0.0.1:${port}/mcp`
    }
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/mcp$/.test(opts.url))
        throw new Error("--url must be a loopback http://.../mcp URL")
    return opts
}

/**
 * Run every step. Returns the result lines ("<action> <what>: <path>").
 * @param {object} opts from parseOptions (+ repo)
 */
export function register(opts, { fs = nodeFs, now = timestamp } = {}) {
    const repo = opts.repo
    const home = opts.home
    const lines = []
    const report = (what, r) =>
        lines.push(
            `${r.action} ${what}: ${r.path}${r.backup ? ` (backup ${r.backup})` : ""}`
        )
    const skillSrc = path.join(repo, "skills", SERVER_NAME)
    if (!fs.existsSync(path.join(skillSrc, "SKILL.md")))
        throw new Error(`missing ${path.join(skillSrc, "SKILL.md")}`)
    const helper = path.join(repo, "install", "mcp-headers.sh")
    if (!fs.existsSync(helper)) throw new Error(`missing ${helper}`)

    if (opts.claude) {
        report(
            "claude mcp server",
            mergeClaude({
                claudeJsonPath: path.join(home, ".claude.json"),
                headersHelperPath: helper,
                url: opts.url,
                dryRun: opts.dryRun,
                fs,
                now,
            })
        )
        report(
            "claude skill",
            linkSkill({
                src: skillSrc,
                dest: path.join(home, ".claude", "skills", SERVER_NAME),
                dryRun: opts.dryRun,
                fs,
                now,
            })
        )
    }
    if (opts.codex) {
        const tokenFile =
            opts.tokenFile ||
            path.join(home, ".config", "command-center", "token")
        let token
        try {
            token = String(fs.readFileSync(tokenFile, "utf8")).trim()
        } catch (err) {
            throw new Error(
                `cannot read the token (${tokenFile}: ${err.code || err.message}); start the command center once first`
            )
        }
        if (!token) throw new Error(`token file ${tokenFile} is empty`)
        report(
            "codex mcp server",
            mergeCodex({
                configTomlPath: path.join(home, ".codex", "config.toml"),
                token,
                url: opts.url,
                dryRun: opts.dryRun,
                fs,
                now,
            })
        )
        report(
            "codex skill",
            linkSkill({
                src: skillSrc,
                dest: path.join(home, ".codex", "skills", SERVER_NAME),
                dryRun: opts.dryRun,
                fs,
                now,
            })
        )
    }
    return lines
}

/** CLI entry. Returns the exit code. */
export function main(
    argv,
    { env = process.env, stdout, stderr, fs, now } = {}
) {
    try {
        const opts = parseOptions(argv, env)
        if (!opts.repo)
            opts.repo = path.resolve(
                path.dirname(fileURLToPath(import.meta.url)),
                ".."
            )
        const lines = register(opts, { fs, now })
        if (opts.dryRun) stdout.write("dry run: nothing was changed\n")
        for (const l of lines) stdout.write(`${l}\n`)
        return 0
    } catch (err) {
        stderr.write(`register-mcp: ${err.message}\n`)
        return 1
    }
}

/* istanbul ignore next */
const isDirect =
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

/* istanbul ignore next */
if (isDirect)
    process.exitCode = main(process.argv.slice(2), {
        stdout: process.stdout,
        stderr: process.stderr,
    })
