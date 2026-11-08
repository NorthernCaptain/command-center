/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Codex CLI provider: one `codex exec` per job.
//   codex exec -m <model> --skip-git-repo-check --sandbox read-only
//     --ephemeral --color never --output-schema <file> -o <outfile> -
// The prompt goes through stdin ("-" = read instructions from stdin, per
// `codex exec --help`) and stdin is ended right after writing, so codex never
// waits for more input and a large prompt cannot hit E2BIG on argv.
// `codex exec --help` has no system-prompt flag, so the system text is
// prepended to the prompt. No streaming deltas.
//
// No MCP servers / hooks / plugins for center jobs (least privilege): codex
// would otherwise load every server from ~/.codex/config.toml (mysql,
// obsidian, tracebot-mcp, ...) and run them without approvals. A config
// override does NOT work: `codex mcp list -c 'mcp_servers={}'` still lists
// all servers (verified with codex-cli 0.162.1; -c merges into the table).
// So codex runs with a dedicated CODEX_HOME (`codexHome`, under the service
// data dir) that holds a minimal config.toml (model settings only) and a
// symlink to the real auth.json (`authFile`, ~/.codex/auth.json in
// production). `CODEX_HOME=<that dir> codex mcp list` prints "No MCP servers
// configured yet" (verified). The symlink is re-checked on every run in case
// codex replaced it with a plain file while refreshing tokens (the newer
// tokens are kept; see ensureCodexHome).

import crypto from "node:crypto"
import os from "node:os"
import path from "node:path"
import { systemClock } from "../../util/clock.js"
import { LimitError } from "../../util/errors.js"
import { nullLogger } from "../../util/logger.js"
import {
    abortedError,
    looksLikeLimit,
    providerFailed,
    runProcess,
    tail,
    timeoutError,
} from "./common.js"

export const CODEX = "codex"

export function buildCodexArgs({ model, schemaFile, outFile }) {
    return [
        "exec",
        "-m",
        model,
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--color",
        "never",
        "--output-schema",
        schemaFile,
        "-o",
        outFile,
        "-",
    ]
}

/** Codex features disabled for center jobs (no shell, apps, plugins...). */
export const DISABLED_FEATURES = [
    "shell_tool",
    "unified_exec",
    "apps",
    "plugins",
    "remote_plugin",
    "browser_use",
    "computer_use",
    "multi_agent",
    "multi_agent_v2",
]

function tomlValue(v) {
    if (typeof v === "boolean" || typeof v === "number") return String(v)
    return JSON.stringify(String(v)) // TOML basic string == JSON string here
}

/** Minimal config.toml: top-level scalar keys only (never mcp_servers). */
export function codexConfigToml(settings = {}) {
    const lines = [
        "# Managed by command-center: CODEX_HOME for center agent jobs.",
        "# Intentionally no mcp_servers, hooks or plugins (least privilege).",
    ]
    for (const [k, v] of Object.entries(settings || {})) {
        if (!/^[A-Za-z0-9_]+$/.test(k) || k === "mcp_servers") continue
        if (v === null || v === undefined || typeof v === "object") continue
        lines.push(`${k} = ${tomlValue(v)}`)
    }
    // Center jobs need structured output only. Turn off every tool-capable
    // feature: verified (codex-cli 0.162.1) that with these off the model
    // cannot read local files, while the default config can.
    lines.push("", "[features]")
    for (const feat of DISABLED_FEATURES) lines.push(`${feat} = false`)
    return `${lines.join("\n")}\n`
}

/** Unique sibling temp name for an atomic create-then-rename. */
function tempName(file) {
    const rand = crypto.randomBytes(6).toString("hex")
    return path.join(
        path.dirname(file),
        `.${path.basename(file)}.${process.pid}.${rand}.tmp`
    )
}

/** Run fn(tmp), then rename tmp over target; tmp is removed on failure. */
async function atomicReplace(fs, target, fn) {
    const tmp = tempName(target)
    try {
        await fn(tmp)
        await fs.rename(tmp, target)
    } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw err
    }
}

async function lstatOrNull(fs, file) {
    try {
        return await fs.lstat(file)
    } catch (err) {
        if (err && err.code === "ENOENT") return null
        throw err
    }
}

async function statOrNull(fs, file) {
    try {
        return await fs.stat(file)
    } catch (err) {
        if (err && err.code === "ENOENT") return null
        throw err
    }
}

async function writeConfigIfChanged(fs, codexHome, settings) {
    const configFile = path.join(codexHome, "config.toml")
    const want = codexConfigToml(settings)
    let have = null
    try {
        have = await fs.readFile(configFile, "utf8")
    } catch {
        have = null
    }
    if (have === want) return false
    await atomicReplace(fs, configFile, (tmp) =>
        fs.writeFile(tmp, want, { mode: 0o600 })
    )
    return true
}

/** Backup name for an isolated auth.json replaced by a newer authFile. */
export const STALE_AUTH_BACKUP = "auth.json.stale"

/** Make <codexHome>/auth.json a symlink to authFile without losing tokens. */
async function ensureAuthLink(fs, codexHome, authFile, log) {
    const link = path.join(codexHome, "auth.json")
    const relink = () =>
        atomicReplace(fs, link, (tmp) => fs.symlink(authFile, tmp))
    const st = await lstatOrNull(fs, link)
    if (!st) return relink()
    if (st.isSymbolicLink()) {
        if ((await fs.readlink(link)) !== authFile) await relink()
        return
    }
    if (!st.isFile()) {
        log.warn(
            { path: link },
            "codex auth.json is neither a file nor a symlink; left in place"
        )
        return
    }
    // codex replaced the link with a plain file (token refresh). Keep the
    // newest tokens: never delete it unless authFile now holds its content.
    const real = await statOrNull(fs, authFile)
    if (real && st.mtimeMs <= real.mtimeMs) {
        // authFile was refreshed (or re-logged in) since: it wins. Keep the
        // older isolated copy as a backup, then point the link back at it.
        const backup = path.join(codexHome, STALE_AUTH_BACKUP)
        await atomicReplace(fs, backup, async (tmp) => {
            await fs.copyFile(link, tmp)
            await fs.chmod(tmp, 0o600)
        })
        log.warn(
            { path: link, authFile, backup },
            "codex auth.json was an older plain file; backed up, link restored"
        )
        await relink()
        return
    }
    await atomicReplace(fs, authFile, async (tmp) => {
        await fs.copyFile(link, tmp)
        await fs.chmod(tmp, 0o600)
    })
    log.info(
        { path: link, authFile },
        "codex refreshed auth.json moved to authFile; link restored"
    )
    await relink()
}

async function ensureCodexHomeNow(fs, { codexHome, authFile, settings }, log) {
    await fs.mkdir(codexHome, { recursive: true, mode: 0o700 })
    await writeConfigIfChanged(fs, codexHome, settings)
    if (authFile) await ensureAuthLink(fs, codexHome, authFile, log)
    return codexHome
}

const homeQueues = new Map() // resolved codexHome -> tail promise

/**
 * Create/refresh the dedicated CODEX_HOME: config.toml + auth.json symlink.
 *
 * - Calls for the same codexHome are serialized in-process, so parallel
 *   first use never races on the same paths.
 * - Nothing is removed before its replacement exists: config.toml (only when
 *   its content changed) and the symlink are created under a unique temp
 *   name and rename()d over the target (atomic, EEXIST-safe), so a codex
 *   reading auth.json meanwhile never finds it missing.
 * - A plain file at auth.json is codex's refreshed token store and is never
 *   deleted: if it is newer than authFile it is copied over authFile
 *   atomically (temp file in authFile's dir + rename) and the link is then
 *   restored; otherwise authFile is newer (a later login or refresh): the
 *   plain file is copied to auth.json.stale and the link restored.
 * @returns {Promise<string>} the home dir
 */
export function ensureCodexHome(fs, opts, log = nullLogger) {
    const key = path.resolve(opts.codexHome)
    const prev = homeQueues.get(key) || Promise.resolve()
    const run = prev.then(() => ensureCodexHomeNow(fs, opts, log))
    const settled = run.catch(() => {})
    homeQueues.set(key, settled)
    settled.then(() => {
        if (homeQueues.get(key) === settled) homeQueues.delete(key)
    })
    return run
}

function parseTokens(text) {
    const m = /tokens used[:\s]*([\d,]+)/i.exec(String(text || ""))
    return m ? Number(m[1].replace(/,/g, "")) : null
}

/**
 * @param {{ spawn: Function, fs: object, tmpDir: string, codexHome: string,
 *           authFile?: string|null, codexSettings?: object, bin?: string,
 *           env?: object, clock?: object, log?: object }} opts fs =
 *   node:fs/promises.
 *   codexHome: dedicated CODEX_HOME (required). authFile: auth.json to link
 *   (default ~/.codex/auth.json; tests pass a temp file). codexSettings:
 *   top-level config.toml scalars (e.g. { model_reasoning_effort: "low" }).
 */
export function createCodexProvider({
    spawn,
    fs,
    tmpDir,
    codexHome,
    authFile = path.join(os.homedir(), ".codex", "auth.json"),
    codexSettings = {},
    bin = "codex",
    env,
    clock = systemClock,
    log = nullLogger,
}) {
    if (typeof spawn !== "function") throw new Error("spawn is required")
    if (!fs || !tmpDir) throw new Error("fs and tmpDir are required")
    if (!codexHome) throw new Error("codexHome is required")
    return {
        name: CODEX,
        async run({ system, prompt, schema, model, signal, timeoutMs }) {
            if (signal && signal.aborted) throw abortedError(CODEX)
            const dir = await fs.mkdtemp(path.join(tmpDir, "cc-codex-"))
            try {
                const schemaFile = path.join(dir, "schema.json")
                const outFile = path.join(dir, "output.json")
                await fs.writeFile(schemaFile, JSON.stringify(schema))
                const home = await ensureCodexHome(
                    fs,
                    { codexHome, authFile, settings: codexSettings },
                    log
                )
                const fullPrompt = system
                    ? `${system}\n\n---\n\n${prompt}`
                    : prompt
                const res = await runProcess({
                    spawn,
                    bin,
                    args: buildCodexArgs({ model, schemaFile, outFile }),
                    stdin: fullPrompt,
                    cwd: dir,
                    env: { ...(env || process.env), CODEX_HOME: home },
                    signal,
                    timeoutMs,
                    clock,
                })
                if (res.timedOut) throw timeoutError(CODEX, timeoutMs)
                if (res.aborted) throw abortedError(CODEX)
                const diag = tail(`${res.stderr}\n${res.stdout}`)
                if (res.code !== 0) {
                    if (looksLikeLimit(diag))
                        throw new LimitError(`${CODEX}: ${diag}`)
                    throw providerFailed(
                        `${CODEX}: exited with code ${res.code}: ${diag}`
                    )
                }
                let text
                try {
                    text = await fs.readFile(outFile, "utf8")
                } catch {
                    throw providerFailed(`${CODEX}: no output file: ${diag}`)
                }
                let output
                try {
                    output = JSON.parse(text)
                } catch {
                    throw providerFailed(
                        `${CODEX}: output is not JSON: ${tail(text, 200)}`
                    )
                }
                if (!output || typeof output !== "object")
                    throw providerFailed(`${CODEX}: output is not an object`)
                return {
                    output,
                    usage: {
                        total_tokens: parseTokens(res.stderr + res.stdout),
                    },
                    model,
                }
            } finally {
                await fs
                    .rm(dir, { recursive: true, force: true })
                    .catch(() => {})
            }
        },
    }
}
