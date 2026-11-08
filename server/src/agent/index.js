/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Center agent wiring: providers + registry + job runner with the default
// job set. Everything is injectable; defaults use the real SDK/binaries.

import { spawn as nodeSpawn } from "node:child_process"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { systemClock } from "../util/clock.js"
import { nullLogger } from "../util/logger.js"
import { createJobRunner } from "./jobRunner.js"
import { createJobRegistry, DEFAULT_JOBS } from "./jobs/index.js"
import { createClaudeCliProvider } from "./providers/claudeCli.js"
import { createClaudeSdkProvider } from "./providers/claudeSdk.js"
import { createCodexProvider } from "./providers/codex.js"
import { createProviderRegistry } from "./providers/registry.js"

/** query() that loads the Agent SDK on first use (keeps startup/tests light). */
export function lazySdkQuery(
    load = () => import("@anthropic-ai/claude-agent-sdk")
) {
    return (args) =>
        (async function* run() {
            const { query } = await load()
            yield* query(args)
        })()
}

/**
 * @param {object} opts
 *   jobsRepo, settingsRepo, store, bus, clock, log, config (cfg.center),
 *   deps (passed to jobs: asanaService, brain, scheduler, repoTable,
 *   dateParser, timezone, mcpServers), providers (override), query, spawn,
 *   fs, tmpDir, cwd, codexHome (dedicated CODEX_HOME, default
 *   <tmpDir>/codex-home), codexAuthFile, jobModules, pollMs.
 */
export function createCenterAgent({
    jobsRepo,
    settingsRepo,
    store,
    bus,
    clock = systemClock,
    log = nullLogger,
    config = {},
    deps = {},
    providers,
    query,
    spawn = nodeSpawn,
    fs = fsp,
    tmpDir = os.tmpdir(),
    cwd = os.tmpdir(),
    codexHome,
    codexAuthFile,
    jobModules = DEFAULT_JOBS,
    pollMs,
} = {}) {
    const providerList = providers || [
        createClaudeSdkProvider({ query: query || lazySdkQuery(), cwd, clock }),
        createClaudeCliProvider({ spawn, cwd, clock, fs, tmpDir }),
        createCodexProvider({
            spawn,
            fs,
            tmpDir,
            codexHome: codexHome || path.join(tmpDir, "codex-home"),
            ...(codexAuthFile !== undefined ? { authFile: codexAuthFile } : {}),
            clock,
            log,
        }),
    ]
    const registry = createProviderRegistry({
        providers: providerList,
        settingsRepo,
    })
    const jobs = createJobRegistry(jobModules)
    const runner = createJobRunner({
        jobsRepo,
        store,
        bus,
        registry,
        jobs,
        clock,
        log,
        concurrency: config.concurrency || { interactive: 4, background: 2 },
        timeoutMs: config.jobTimeoutMs || 180000,
        deps,
        ...(pollMs !== undefined ? { pollMs } : {}),
    })
    return { registry, runner, jobs }
}
