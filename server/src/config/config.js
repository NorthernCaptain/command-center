/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Static configuration: defaults <- ~/.config/command-center/config.json <- env.
// Runtime-switchable settings (provider, models, ...) live in SQLite via the
// settings repository, not here.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../.."
)

export function defaultConfig({ home = os.homedir(), root = REPO_ROOT } = {}) {
    return {
        repoRoot: root,
        tasksDir: path.join(root, "tasks"),
        dataDir: path.join(root, "data"),
        webDist: path.join(root, "web", "dist"),
        configDir: path.join(home, ".config", "command-center"),
        listeners: {
            local: { host: "127.0.0.1", port: 7788 },
            tailnet: { host: "127.0.0.1", port: 7789 },
        },
        // Public base URL of the tailnet listener (tailscale serve
        // --https=<tailscale.httpsPort>). Used for the tailnet Host guard and
        // artifact links in Asana. Set in config.json, or detected from
        // `tailscale status` (system.js detectPublicBaseUrl).
        publicBaseUrl: null,
        // HTTPS port of `tailscale serve` (install/tailscale-serve.sh,
        // env CC_HTTPS_PORT).
        tailscale: { httpsPort: 8443 },
        // your Tailscale login (owner on the tailnet listener); config.json
        owner: { tailscaleLogin: null },
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // Asana project, assignee and workspace gids, and the optional
        // "Status" enum field ({ gid, options: { initial, in_progress,
        // code_review, released, cancelled } }): set in config.json (see
        // config.example.json). Without a project gid Asana is unavailable.
        asana: {
            projectGid: null,
            assigneeGid: null,
            workspaceGid: null,
            keychainService: "command-center-asana",
            statusField: null,
        },
        brain: {
            // the Brain MCP server entry is read from ~/.claude.json at
            // runtime; serverName is its key there (config.json; unset = no
            // Brain: Slack threads can't be fetched or answered)
            claudeConfigPath: path.join(home, ".claude.json"),
            serverName: null,
        },
        // where worker agents check out repos (AGENTS.md lives there)
        treeDir: path.join(home, "work", "tree"),
        center: {
            concurrency: { interactive: 4, background: 2 },
            jobTimeoutMs: 180000,
            // area -> main repo when enrich assigns none, also shown to the
            // model as a hint, e.g. { "batch": "my-batch-repo" }
            areaRepos: {},
        },
        git: {
            // branch of the task data repo the store commits on
            branch: "tasks",
            commitDebounceMs: 15000,
            authorName: "Command Center",
            authorEmail: "command-center@localhost",
        },
        scheduler: { tickMs: 15000 },
        herdr: {
            socketPath: path.join(home, ".config", "herdr", "herdr.sock"),
            requestTimeoutMs: 15000,
            startTimeoutMs: 60000,
            promptTimeoutMs: 120000,
            pollMs: 10000,
        },
        github: {
            // GitHub org of the work repos (config.json); unset = no PR watch
            org: null,
            pollMinutes: 15,
            ghBin: "gh",
            // reviewer bots whose review comments are real feedback (their
            // thread replies stay no_action)
            actionableBots: [],
        },
        review: {
            archiveDir: path.join(home, "work", "review", "reviews"),
            dashboardUrl: "http://127.0.0.1:7777/",
        },
        push: {
            vapidFile: path.join(
                home,
                ".config",
                "command-center",
                "vapid.json"
            ),
            // Web Push contact (config.json), e.g. "mailto:you@example.com"
            subject: "mailto:command-center@localhost",
        },
    }
}

function deepMerge(base, over) {
    if (!over || typeof over !== "object" || Array.isArray(over)) return base
    const out = { ...base }
    for (const [k, v] of Object.entries(over)) {
        out[k] =
            v && typeof v === "object" && !Array.isArray(v) && base[k]
                ? deepMerge(base[k], v)
                : v
    }
    return out
}

/** Load config. `readFile` and `env` are injectable for tests. */
export function loadConfig({
    home = os.homedir(),
    root = REPO_ROOT,
    env = process.env,
    readFile = (p) => fs.readFileSync(p, "utf8"),
} = {}) {
    let cfg = defaultConfig({ home, root })
    const file = path.join(cfg.configDir, "config.json")
    try {
        cfg = deepMerge(cfg, JSON.parse(readFile(file)))
    } catch (err) {
        if (err.code !== "ENOENT") throw err
    }
    if (env.CC_TASKS_DIR) cfg.tasksDir = env.CC_TASKS_DIR
    if (env.CC_DATA_DIR) cfg.dataDir = env.CC_DATA_DIR
    if (env.CC_LOCAL_PORT) cfg.listeners.local.port = Number(env.CC_LOCAL_PORT)
    if (env.CC_TAILNET_PORT)
        cfg.listeners.tailnet.port = Number(env.CC_TAILNET_PORT)
    if (env.CC_HTTPS_PORT) cfg.tailscale.httpsPort = Number(env.CC_HTTPS_PORT)
    if (env.CC_PUBLIC_BASE_URL) cfg.publicBaseUrl = env.CC_PUBLIC_BASE_URL
    return cfg
}
