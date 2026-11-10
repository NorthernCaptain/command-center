/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Composition root: wires store, scheduler, center agent, integrations and
// the two HTTP listeners. Everything external (exec, fetch, keychain, SDK
// query, spawn) can be overridden for tests.

import {
    createThreadNotifier,
    mountThreadNotice,
    noticeTaskExtras,
} from "./agent/threadNotify.js"
import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { createBus } from "./events/bus.js"
import { systemClock } from "./util/clock.js"
import { nullLogger } from "./util/logger.js"
import {
    openDb,
    createStore,
    createGitCommitter,
    createSchedulesRepo,
    createJobsRepo,
    createSettingsRepo,
    createDevicesRepo,
} from "./store/index.js"
import {
    createDateParser,
    createNotifier,
    createScheduler,
} from "./scheduler/index.js"
import {
    createKeychain,
    createAsanaClient,
    createAsanaService,
    createAsanaSync,
    createBrainClient,
    createRepoTable,
} from "./integrations/index.js"
import { createCenterAgent } from "./agent/index.js"
import { createAuth } from "./http/auth.js"
import { createApp } from "./http/app.js"
import {
    createAgentSessionsRepo,
    createHerdrClient,
    createHerdrEvents,
    createOutboxRepo,
} from "./herdr/index.js"
import {
    createIdentity,
    createWorkerService,
    feedbackPrompt,
    mountWorkers,
    workerBoardExtras,
    workerTaskExtras,
} from "./workers/index.js"
import {
    createAgentTools,
    createMcpHandler,
    mountAgentTools,
} from "./mcp/index.js"
import { createGithub } from "./github/index.js"
import { createPhase3 } from "./phase3/index.js"
import { startListeners } from "./http/server.js"

const execFileP = promisify(execFile)

/** Promisified execFile returning { stdout, stderr }. */
export async function defaultExec(cmd, args, opts = {}) {
    return execFileP(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts })
}

export const TAILSCALE_CLI =
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale"

/**
 * Derive the tailnet URL (https://<mac>.<tailnet>.ts.net:<port>) from
 * `tailscale status --json` when config.publicBaseUrl is not set. Returns
 * null when Tailscale is unavailable; the tailnet listener then answers 503.
 * The app's binary acts as the CLI only when TERM is set; without it (e.g.
 * under launchd) it tries to start the GUI and prints "The Tailscale GUI
 * failed to start", so TERM is always passed.
 */
export async function detectPublicBaseUrl({
    exec = defaultExec,
    port = 8443,
    cli = TAILSCALE_CLI,
    log = nullLogger,
} = {}) {
    try {
        const { stdout } = await exec(cli, ["status", "--json"], {
            timeout: 5000,
            env: { ...process.env, TERM: process.env.TERM || "dumb" },
        })
        const name = JSON.parse(stdout)?.Self?.DNSName
        if (typeof name !== "string" || !/^[a-z0-9.-]+\.?$/i.test(name))
            return null
        return `https://${name.replace(/\.$/, "").toLowerCase()}:${port}`
    } catch (err) {
        log.warn({ err: err.message }, "tailscale status unavailable")
        return null
    }
}

/**
 * Read the Brain MCP server entry (config.brain.serverName) from
 * ~/.claude.json so the center agent can hand it to providers (assist "ask"
 * jobs). Returns {} when unavailable or not configured.
 */
export function loadMcpServers({ config, readFile, log = nullLogger }) {
    if (!config.brain.serverName) return {}
    try {
        const json = JSON.parse(readFile(config.brain.claudeConfigPath))
        const entry = json?.mcpServers?.[config.brain.serverName]
        if (!entry || !entry.url) return {}
        return {
            [config.brain.serverName]: {
                type: "http",
                url: entry.url,
                headers: entry.headers || {},
            },
        }
    } catch (err) {
        log.warn({ err: err.message }, "no Brain MCP config for center")
        return {}
    }
}

/**
 * Build the whole system without starting timers or listeners.
 * @param {object} opts
 * @param {object} opts.config  loaded config (see config/config.js)
 * @param {object} [opts.overrides] { exec, fetch, clock, log, query, spawn,
 *        readFile, notifierExec, keychain, providers, mcpClientFactory,
 *        codexAuthFile, tailscaleExec, resolvePublicBaseUrl }
 */
export function createSystem({ config, overrides = {} }) {
    const clock = overrides.clock || systemClock
    const log = overrides.log || nullLogger
    const exec = overrides.exec || defaultExec
    const readFile = overrides.readFile || ((p) => fs.readFileSync(p, "utf8"))

    fs.mkdirSync(config.dataDir, { recursive: true })
    const db = openDb(path.join(config.dataDir, "cc.db"))
    const bus = createBus({ clock })

    const git = createGitCommitter({
        tasksDir: config.tasksDir,
        exec,
        clock,
        debounceMs: config.git.commitDebounceMs,
        author: { name: config.git.authorName, email: config.git.authorEmail },
        branch: config.git.branch || "tasks",
        codeRepoDir: config.repoRoot,
        log,
    })
    const store = createStore({
        tasksDir: config.tasksDir,
        db,
        bus,
        clock,
        git,
        log,
    })
    const schedulesRepo = createSchedulesRepo(db, { clock })
    const jobsRepo = createJobsRepo(db, { clock })
    const settingsRepo = createSettingsRepo(db, { clock })
    const devicesRepo = createDevicesRepo(db, { clock })

    const dateParser = createDateParser({ clock, timezone: config.timezone })
    const notifier = createNotifier({
        ...(overrides.notifierExec ? { exec: overrides.notifierExec } : {}),
        log,
    })

    const keychain = overrides.keychain || createKeychain({ exec, log })
    const asanaClient = createAsanaClient({
        ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
        token: () => keychain.get(config.asana.keychainService),
        log,
    })
    const asanaService = createAsanaService({
        client: asanaClient,
        config: config.asana,
        clock,
        publicBaseUrl: () => config.publicBaseUrl,
        timeZone: config.timezone,
        githubOrg: config.github.org,
        log,
    })
    const asanaSync = createAsanaSync({
        store,
        bus,
        asanaService,
        clock,
        log,
        githubOrg: config.github.org,
        ...(overrides.asanaSyncDebounceMs !== undefined
            ? { debounceMs: overrides.asanaSyncDebounceMs }
            : {}),
    })
    const brain = createBrainClient({
        claudeConfigPath: config.brain.claudeConfigPath,
        serverName: config.brain.serverName,
        ...(overrides.mcpClientFactory
            ? { mcpClientFactory: overrides.mcpClientFactory }
            : {}),
        ...(overrides.readFileAsync
            ? { readFile: overrides.readFileAsync }
            : {}),
        log,
    })
    const repoTable = createRepoTable({
        readFile,
        agentsMdPath: path.join(config.treeDir, "AGENTS.md"),
        log,
    })

    // scheduler <-> job runner reference each other; bind late.
    let runner = null
    const runnerProxy = {
        enqueue: (...a) => runner.enqueue(...a),
        cancel: (...a) => runner.cancel(...a),
        get: (...a) => runner.get(...a),
        list: (...a) => runner.list(...a),
    }
    const scheduler = createScheduler({
        schedulesRepo,
        store,
        bus,
        notifier,
        jobRunner: runnerProxy,
        clock,
        log,
        tickMs: config.scheduler.tickMs,
    })
    // Asana link -> the task's Slack thread (via Brain); its state and the
    // retry live on the task page
    const threadNotifier = createThreadNotifier({ store, brain, log })
    const center = createCenterAgent({
        jobsRepo,
        settingsRepo,
        store,
        bus,
        clock,
        log,
        config: config.center,
        deps: {
            asanaService,
            brain,
            areaRepos: config.center.areaRepos || {},
            // Asana link -> the task's Slack thread (via Brain)
            threadNotifier,
            scheduler,
            repoTable,
            dateParser,
            // command: "done" on an Asana-linked task enqueues close_out.
            jobRunner: runnerProxy,
            // close_out re-checks unmerged PRs on GitHub first (the watcher
            // is created further down)
            prWatcher: {
                pollTask: (id) =>
                    github.prWatcher ? github.prWatcher.pollTask(id) : null,
            },
            // assist: pass Leo's message on to the task's herdr agent
            // (the worker service is created further down)
            workers: {
                agentState: (...a) => workerService.agentState(...a),
                send: (id, text) =>
                    workerService.action(
                        id,
                        "send",
                        { text },
                        { actor: "center" }
                    ),
            },
            timezone: config.timezone,
            mcpServers: loadMcpServers({ config, readFile, log }),
        },
        ...(overrides.providers ? { providers: overrides.providers } : {}),
        ...(overrides.query ? { query: overrides.query } : {}),
        ...(overrides.spawn ? { spawn: overrides.spawn } : {}),
        cwd: config.dataDir,
        tmpDir: config.dataDir,
        // Dedicated CODEX_HOME: no MCP servers/hooks for center jobs.
        codexHome: path.join(config.dataDir, "codex-home"),
        ...(overrides.codexAuthFile !== undefined
            ? { codexAuthFile: overrides.codexAuthFile }
            : {}),
    })
    runner = center.runner

    const auth = createAuth({
        config,
        devicesRepo,
        ...(overrides.localToken ? { localToken: overrides.localToken } : {}),
        clock,
        log,
    })
    // Tailscale may not be up yet at login: while publicBaseUrl is unknown
    // the tailnet host guard retries this (at most once a minute).
    const resolvePublicBaseUrl =
        overrides.resolvePublicBaseUrl ||
        (() =>
            detectPublicBaseUrl({
                exec: overrides.tailscaleExec || exec,
                port: config.tailscale?.httpsPort,
                log,
            }))
    // ---- phase 2: herdr workers, PR watcher, worker tools (MCP) -----------
    const herdrClient =
        overrides.herdrClient ||
        createHerdrClient({
            socketPath: config.herdr.socketPath,
            timeoutMs: config.herdr.requestTimeoutMs,
            startTimeoutMs: config.herdr.startTimeoutMs,
            promptTimeoutMs: config.herdr.promptTimeoutMs,
            ...(overrides.herdrConnect
                ? { connect: overrides.herdrConnect }
                : {}),
            clock,
            log,
        })
    const herdrEvents =
        overrides.herdrEvents ||
        createHerdrEvents({
            socketPath: config.herdr.socketPath,
            ...(overrides.herdrConnect
                ? { connect: overrides.herdrConnect }
                : {}),
            client: herdrClient,
            pollMs: config.herdr.pollMs,
            clock,
            log,
        })
    const identity = createIdentity({
        store,
        treeDir: config.treeDir,
        org: config.github.org,
        ...(overrides.identityExec ? { exec: overrides.identityExec } : {}),
    })
    const workerService = createWorkerService({
        store,
        herdr: herdrClient,
        events: herdrEvents,
        sessions: createAgentSessionsRepo(db, { clock }),
        outbox: createOutboxRepo(db, { clock }),
        identity,
        settingsRepo,
        jobRunner: runnerProxy,
        notifier,
        bus,
        config,
        clock,
        log,
        localToken: auth.localToken(),
        transaction: (fn) => db.transaction(fn)(),
    })
    scheduler.setWorkerService(workerService)
    const github = createGithub({
        config,
        // gh runs through ghClient's bounded default executor (60 s
        // timeout) unless a test injects one: a hung gh must not stall the
        // serial poll cycle or shutdown.
        ...(overrides.ghExec ? { exec: overrides.ghExec } : {}),
        db,
        store,
        workerService,
        jobRunner: runnerProxy,
        asanaService,
        settingsRepo,
        notifier,
        bus,
        clock,
        log,
        feedbackPrompt,
        actionableBots: config.github.actionableBots || [],
        ...(overrides.reviewFs ? { fs: overrides.reviewFs } : {}),
    })
    // "Address feedback" goes through the watcher's round queue
    workerService.setFeedbackDelivery(github.prWatcher)
    const agentTools = createAgentTools({
        store,
        scheduler,
        dateParser,
        identity,
        prWatcher: github.prWatcher,
        workerService,
        notifier,
        bus,
        clock,
        log,
    })
    // ---- phase 3: SOC2 export, Web Push, digest + stale sweep -------------
    const phase3 = createPhase3({
        db,
        store,
        settingsRepo,
        devicesRepo,
        notifier,
        bus,
        config,
        clock,
        log,
        ...(overrides.webpush ? { webpush: overrides.webpush } : {}),
    })
    phase3.setWorkerService(workerService)

    const appDeps = {
        store,
        repoTable,
        bus,
        jobRunner: runner,
        scheduler,
        dateParser,
        settingsRepo,
        devicesRepo,
        auth,
        config,
        log,
        clock,
        features: {
            workers: true,
            // PR watch needs github.org
            github: Boolean(config.github.org),
            push: true,
            soc2: true,
            digest: true,
        },
        mounts: [
            (api, h) => mountWorkers(api, h, { workerService }),
            github.mount,
            (api, h) => mountAgentTools(api, h, { tools: agentTools }),
            phase3.mount,
            (api, h) => mountThreadNotice(api, h, { notifier: threadNotifier }),
        ],
        taskExtras: [
            workerTaskExtras(workerService),
            github.taskExtras,
            noticeTaskExtras(threadNotifier),
        ],
        boardExtras: [workerBoardExtras(workerService)],
        onDeviceRevoked: [(id) => phase3.push.removeForDevice(id)],
    }
    const appLocal = createApp({
        mode: "local",
        ...appDeps,
        mcpHandler: createMcpHandler({ tools: agentTools, log }),
    })
    const appTailnet = createApp({
        mode: "tailnet",
        ...appDeps,
        resolvePublicBaseUrl,
    })

    let listeners = null
    let notifyOff = null

    return {
        config,
        db,
        bus,
        store,
        git,
        scheduler,
        runner,
        registry: center.registry,
        asanaService,
        asanaSync,
        brain,
        auth,
        herdrClient,
        workerService,
        github,
        agentTools,
        phase3,
        appLocal,
        appTailnet,
        /** Recover, start timers and (unless listen:false) the listeners. */
        async start({ listen = true } = {}) {
            await git.ensureRepo()
            const rec = await store.recover()
            log.info(rec, "store recovered")
            // Notify when an agent-facing status needs me.
            notifyOff = bus.subscribe((ev) => {
                if (ev.type !== "job.updated") return
                const job = ev.data.job
                if (job && job.status === "failed")
                    notifier
                        .notify({
                            title: "Center agent job failed",
                            body: `${job.type}${job.task_id ? ` T-${job.task_id}` : ""}: ${job.error || ""}`,
                            sound: "none",
                        })
                        .catch(() => {})
            })
            // before any producer (scheduler, PR watcher, listeners) can
            // put a prompt in 'sending': recovery fails every such row
            await workerService.recover()
            runner.start()
            scheduler.start()
            await asanaSync.start()
            await phase3.start()
            github.prWatcher.start()
            // unresolved Slack thread notices keep their tasks in Now
            threadNotifier.start()
            if (listen) {
                listeners = await startListeners({
                    appLocal,
                    appTailnet,
                    config,
                    log,
                })
                log.info(
                    { local: listeners.local, tailnet: listeners.tailnet },
                    "command center listening"
                )
            }
            // herdr may be down: the worker service retries in the background
            await workerService
                .start()
                .catch((err) =>
                    log.warn({ err: err.message }, "worker service start")
                )
            return listeners
        },
        async stop() {
            if (notifyOff) notifyOff()
            if (listeners) await listeners.close()
            // PR watcher first: it calls the worker service while it runs
            await github.prWatcher.stop()
            await threadNotifier.stop()
            await workerService.stop()
            await phase3.stop()
            await scheduler.stop()
            await runner.stop()
            await asanaSync.stop()
            // producers are stopped: let background Web Push sends finish
            // (they update push_subscriptions) before the database closes
            await notifier.drainPush()
            await brain.close().catch(() => {})
            await store.close()
        },
    }
}
