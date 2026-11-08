/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Center agent job runner.
//
// - Two lanes ("interactive", "background") with independent concurrency,
//   FIFO within a lane.
// - Lifecycle: queued -> running -> done | failed | cancelled, plus parked
//   (waiting on something slow, e.g. a Brain job; no slot is held). poll()
//   re-queues parked jobs; their module's resume() decides whether to go on.
// - Persistence via jobsRepo (center_jobs row, *_json columns hold JSON
//   strings; rows read back are accepted with either parsed or string JSON).
//   The public `summary` and `fallback_from` have no columns: summary lives in
//   output_json as { result, summary }, fallback_from in usage_json.
// - The LLM call happens outside any lock. Modules with `lock: true` run only
//   their apply() inside store.withTaskLock(task_id). On StaleRevisionError,
//   apply() runs once more with ctx.attempt = 2; modules re-read what they
//   depend on (see artifactEdits.js for the section rebase rule).
// - Output is validated with the module's zod outputSchema.
// - LimitError + center.auto_fallback -> one retry on the fallback provider.
// - Job failures never throw out to callers; they end in status "failed".
// - stop() aborts running jobs (CLI children run in their own process group,
//   so nothing else would stop them on shutdown), waits for them up to
//   stopTimeoutMs, then SIGKILLs whatever child groups are left. Jobs in their
//   apply phase are not aborted (local store writes; they finish quickly).
//   Aborted jobs end "failed" ("interrupted (service stopped)"); queued jobs
//   stay queued and run after the next start().

import crypto from "node:crypto"
import { z } from "zod"
import { systemClock } from "../util/clock.js"
import { AppError } from "../util/errors.js"
import { nullLogger } from "../util/logger.js"
import { toProviderSchema } from "./jsonSchema.js"
import { killAll } from "./providers/common.js"

export const LANES = ["interactive", "background"]

class Cancelled extends Error {}

const STOPPED_ERROR = "interrupted (service stopped)"

function parseJson(v) {
    if (v === null || v === undefined) return null
    if (typeof v !== "string") return v
    try {
        return JSON.parse(v)
    } catch {
        return null
    }
}

/** Row (center_jobs) -> in-memory job. */
export function fromRow(row) {
    const outEnv = parseJson(row.output_json ?? row.output)
    const isEnv =
        outEnv &&
        typeof outEnv === "object" &&
        "result" in outEnv &&
        "summary" in outEnv
    const usage = parseJson(row.usage_json ?? row.usage)
    return {
        id: row.id,
        task_id: row.task_id ?? null,
        type: row.type,
        lane: row.lane,
        status: row.status,
        provider: row.provider ?? null,
        model: row.model ?? null,
        input: parseJson(row.input_json ?? row.input) || {},
        output: isEnv ? outEnv.result : outEnv,
        summary: isEnv ? outEnv.summary : (row.summary ?? null),
        park: parseJson(row.park_json ?? row.park),
        error: row.error ?? null,
        usage,
        fallback_from: (usage && usage.fallback_from) || null,
        created_at: row.created_at,
        started_at: row.started_at ?? null,
        ended_at: row.ended_at ?? null,
    }
}

function rowPatch(job, patch) {
    const out = {}
    for (const k of [
        "status",
        "provider",
        "model",
        "error",
        "started_at",
        "ended_at",
    ]) {
        if (k in patch) out[k] = patch[k]
    }
    if ("output" in patch || "summary" in patch)
        out.output = {
            result: job.output ?? null,
            summary: job.summary ?? null,
        }
    if ("usage" in patch || "fallback_from" in patch)
        out.usage = {
            ...(job.usage || {}),
            fallback_from: job.fallback_from ?? null,
        }
    if ("park" in patch) out.park = job.park == null ? null : job.park
    return out
}

function toRow(job) {
    return {
        id: job.id,
        task_id: job.task_id,
        type: job.type,
        lane: job.lane,
        status: job.status,
        provider: job.provider,
        model: job.model,
        input: job.input ?? {},
        output: null,
        park: null,
        error: job.error,
        usage: null,
        created_at: job.created_at,
        started_at: job.started_at,
        ended_at: job.ended_at,
    }
}

/** Public job view (bus + API). */
export function publicJob(job) {
    return {
        id: job.id,
        task_id: job.task_id,
        type: job.type,
        lane: job.lane,
        status: job.status,
        provider: job.provider,
        model: job.model,
        error: job.error,
        summary: job.summary,
        fallback_from: job.fallback_from || null,
        created_at: job.created_at,
        started_at: job.started_at,
        ended_at: job.ended_at,
    }
}

function errorMessage(err) {
    if (!err) return "unknown error"
    const msg = err.message || String(err)
    return msg.length > 2000 ? `${msg.slice(0, 2000)}…` : msg
}

function isStale(err) {
    return Boolean(err) && err.code === "stale_revision"
}

function isLimit(err) {
    return Boolean(err) && err.code === "provider_limit"
}

/**
 * @param {object} opts see docs/implementation/contracts.md "Job runner".
 *   Extra options: pollMs (parked poll interval, 0 = off), maxParkMs (a parked
 *   job older than this is resumed with parkState.expired = true), idGen,
 *   stopTimeoutMs (how long stop() waits for aborted jobs), killChildren
 *   (last-resort kill of CLI child groups; default providers/common killAll).
 */
export function createJobRunner({
    jobsRepo,
    store,
    bus,
    registry,
    jobs,
    clock = systemClock,
    log = nullLogger,
    concurrency = {},
    timeoutMs = 180000,
    deps = {},
    pollMs = 30000,
    maxParkMs = 30 * 60 * 1000,
    idGen = () => `j_${crypto.randomBytes(6).toString("hex")}`,
    stopTimeoutMs = 10000,
    killChildren = killAll,
}) {
    const lanes = {
        interactive: {
            queue: [],
            running: 0,
            limit: Math.max(1, concurrency.interactive ?? 4),
        },
        background: {
            queue: [],
            running: 0,
            limit: Math.max(1, concurrency.background ?? 2),
        },
    }
    const inFlight = new Map() // id -> entry
    const active = new Set() // running execute() promises
    const schemaCache = new Map()
    let started = false
    let pollTimer = null

    const now = () => clock.now().toISOString()
    const lookup = (type) =>
        typeof jobs.get === "function" ? jobs.get(type) : jobs[type]

    function emitJob(job) {
        if (!bus) return
        bus.emit("job.updated", {
            task_id: job.task_id,
            data: { job: publicJob(job) },
        })
    }

    function save(job, patch, { emit = "status" in patch } = {}) {
        Object.assign(job, patch)
        jobsRepo.update(job.id, rowPatch(job, patch))
        if (emit) emitJob(job)
    }

    function schemaFor(mod) {
        if (!schemaCache.has(mod.type))
            schemaCache.set(mod.type, toProviderSchema(mod.outputSchema))
        return schemaCache.get(mod.type)
    }

    function makeCtx(job, signal, attempt = 1) {
        return {
            job: publicJob(job),
            input: job.input || {},
            task_id: job.task_id,
            store,
            deps,
            actor: "center",
            clock,
            log,
            signal,
            attempt,
        }
    }

    async function notifyFailure(job, err, { cancelled = false } = {}) {
        const mod = lookup(job.type)
        if (!mod || typeof mod.onFailure !== "function") return
        try {
            await mod.onFailure(makeCtx(job, undefined), err, { cancelled })
        } catch (e) {
            log.warn({ err: e, job_id: job.id }, "job onFailure hook failed")
        }
    }

    function schedule(job, { resume = false } = {}) {
        const lane = lanes[job.lane] ? job.lane : "background"
        inFlight.set(job.id, {
            job,
            lane,
            resume,
            cancelled: false,
            applying: false,
            controller: null,
        })
        lanes[lane].queue.push(job.id)
        pump(lane)
    }

    function pump(laneName) {
        if (!started) return
        const lane = lanes[laneName]
        while (lane.running < lane.limit && lane.queue.length) {
            const id = lane.queue.shift()
            const entry = inFlight.get(id)
            if (!entry || entry.cancelled) continue
            lane.running++
            // Jobs are often enqueued from code holding a task lock (e.g. a
            // command enqueuing close_out). Start them outside that context
            // so they queue for locks instead of inheriting ownership.
            const detach =
                store && typeof store.outsideLocks === "function"
                    ? (fn) => store.outsideLocks(fn)
                    : (fn) => fn()
            const p = detach(() => execute(entry))
                .catch((err) =>
                    log.error({ err, job_id: id }, "job runner internal error")
                )
                .finally(() => {
                    lane.running--
                    if (inFlight.get(id) === entry) inFlight.delete(id)
                })
            active.add(p)
            p.then(() => {
                active.delete(p)
                pump(laneName)
            })
        }
    }

    function checkCancelled(entry) {
        if (entry.cancelled) throw new Cancelled()
    }

    function isExpired(park) {
        if (!park || !park.parked_at) return false
        return clock.now().getTime() - Date.parse(park.parked_at) > maxParkMs
    }

    function parkJob(job, park) {
        const state = {
            ...park,
            until: park.until ?? null,
            parked_at:
                job.status === "parked" && job.park && job.park.parked_at
                    ? job.park.parked_at
                    : now(),
        }
        if (job.status === "parked") save(job, { park: state })
        else save(job, { status: "parked", park: state })
    }

    async function callProvider(job, mod, built, signal) {
        const schema = schemaFor(mod)
        const run = (provider) => {
            const model = registry.modelFor(job.type, mod.weight, provider.name)
            save(job, { provider: provider.name, model })
            return provider.run({
                system: built.system,
                prompt: built.prompt,
                schema,
                model,
                signal,
                mcpServers: built.mcpServers,
                allowedTools: built.allowedTools,
                timeoutMs,
                onDelta: (text) => {
                    if (bus)
                        bus.emit("job.delta", {
                            task_id: job.task_id,
                            data: { job_id: job.id, text },
                        })
                },
            })
        }
        const primary = registry.current()
        try {
            return await run(primary)
        } catch (err) {
            if (!isLimit(err) || (signal && signal.aborted)) throw err
            const fb = registry.fallback()
            if (!fb || fb.name === primary.name) throw err
            log.warn(
                { job_id: job.id, from: primary.name, to: fb.name },
                "provider limit hit, falling back"
            )
            save(job, { fallback_from: primary.name })
            try {
                return await run(fb)
            } catch (err2) {
                throw new AppError(
                    err2.code || "provider_failed",
                    `${errorMessage(err)}; fallback ${fb.name} failed: ${errorMessage(err2)}`,
                    { status: 502 }
                )
            }
        }
    }

    async function applyWithRetry(mod, job, signal, output, context) {
        try {
            return await mod.apply(makeCtx(job, signal, 1), output, context)
        } catch (err) {
            if (!isStale(err)) throw err
            log.info(
                { job_id: job.id },
                "stale revision in apply, retrying once"
            )
            return await mod.apply(makeCtx(job, signal, 2), output, context)
        }
    }

    async function execute(entry) {
        const { job } = entry
        const mod = lookup(job.type)
        const controller = new AbortController()
        entry.controller = controller
        const signal = controller.signal
        try {
            if (!mod)
                throw new AppError(
                    "unknown_job",
                    `unknown job type ${job.type}`
                )
            let prep
            if (entry.resume) {
                if (typeof mod.resume !== "function")
                    throw new AppError(
                        "cannot_resume",
                        `${job.type} cannot resume`
                    )
                const parkState = {
                    ...(job.park || {}),
                    expired: isExpired(job.park),
                }
                prep = await mod.resume(makeCtx(job, signal), parkState)
                checkCancelled(entry)
                if (prep && prep.park) {
                    if (parkState.expired)
                        throw new AppError(
                            "park_timeout",
                            `timed out waiting for ${job.park ? job.park.kind : "parked work"}`
                        )
                    parkJob(job, prep.park)
                    return
                }
                save(job, {
                    status: "running",
                    started_at: job.started_at || now(),
                })
            } else {
                save(job, { status: "running", started_at: now() })
                prep = mod.prepare
                    ? await mod.prepare(makeCtx(job, signal))
                    : null
                checkCancelled(entry)
                if (prep && prep.park) {
                    parkJob(job, prep.park)
                    return
                }
            }
            const context = (prep && prep.context) || {}
            const built = await mod.buildPrompt(makeCtx(job, signal), context)
            const res = await callProvider(job, mod, built, signal)
            checkCancelled(entry)
            const parsed = mod.outputSchema.safeParse(res.output)
            if (!parsed.success) {
                throw new AppError(
                    "invalid_output",
                    `${job.provider} returned output that does not match the ${job.type} schema: ${z
                        .prettifyError(parsed.error)
                        .slice(0, 800)}`,
                    { status: 502 }
                )
            }
            entry.applying = true
            const applyFn = () =>
                applyWithRetry(mod, job, signal, parsed.data, context)
            const result =
                mod.lock && job.task_id != null
                    ? await store.withTaskLock(job.task_id, applyFn)
                    : await applyFn()
            save(job, {
                status: "done",
                output: parsed.data,
                summary: (result && result.summary) || null,
                usage: res.usage || null,
                model: res.model || job.model,
                error: null,
                ended_at: now(),
            })
        } catch (err) {
            if (entry.cancelled) {
                // cancel() already marked the job; run the failure hook only
                // now that execute() has stopped, so it cannot race with
                // prepare() (e.g. assist marking its comment "working").
                await notifyFailure(job, null, { cancelled: true })
                return
            }
            const failure = entry.shutdown ? new Error(STOPPED_ERROR) : err
            log.warn(
                { err, job_id: job.id, type: job.type },
                entry.shutdown ? "job interrupted by stop" : "job failed"
            )
            save(job, {
                status: "failed",
                error: errorMessage(failure),
                ended_at: now(),
            })
            await notifyFailure(job, failure)
        }
    }

    function enqueue(type, input = {}, { task_id = null } = {}) {
        const mod = lookup(type)
        const job = {
            id: idGen(),
            task_id: task_id ?? null,
            type,
            lane: mod && lanes[mod.lane] ? mod.lane : "background",
            status: "queued",
            provider: null,
            model: null,
            input: input ?? {},
            output: null,
            summary: null,
            park: null,
            error: null,
            usage: null,
            fallback_from: null,
            created_at: now(),
            started_at: null,
            ended_at: null,
        }
        if (!mod) job.error = `unknown job type: ${type}`
        else if (mod.needsTask !== false && job.task_id == null)
            job.error = `${type} requires a task_id`
        if (job.error) {
            job.status = "failed"
            job.ended_at = job.created_at
        }
        jobsRepo.insert(toRow(job))
        emitJob(job)
        const view = publicJob(job) // as enqueued, before a slot picks it up
        if (!job.error) schedule(job)
        return view
    }

    function cancel(id) {
        const entry = inFlight.get(id)
        if (entry) {
            if (entry.applying || entry.cancelled) return false
            entry.cancelled = true
            if (entry.controller) entry.controller.abort()
            const q = lanes[entry.lane].queue
            const idx = q.indexOf(id)
            save(entry.job, { status: "cancelled", ended_at: now() })
            if (idx >= 0) {
                // Never started: nothing can race with the failure hook.
                q.splice(idx, 1)
                inFlight.delete(id)
                notifyFailure(entry.job, null, { cancelled: true })
            }
            // Running: execute() calls the hook when it exits.
            return true
        }
        const row = jobsRepo.get(id)
        if (!row) return false
        const job = fromRow(row)
        if (job.status !== "queued" && job.status !== "parked") return false
        save(job, { status: "cancelled", ended_at: now() })
        notifyFailure(job, null, { cancelled: true })
        return true
    }

    function get(id) {
        const entry = inFlight.get(id)
        if (entry) return publicJob(entry.job)
        const row = jobsRepo.get(id)
        return row ? publicJob(fromRow(row)) : null
    }

    function list(opts = {}) {
        return (jobsRepo.list(opts) || []).map((r) => publicJob(fromRow(r)))
    }

    /** Re-queue parked jobs that are due (park.until passed, or expired). */
    function poll() {
        if (!started) return 0
        let n = 0
        for (const row of jobsRepo.listByStatus(["parked"]) || []) {
            const job = fromRow(row)
            if (inFlight.has(job.id)) continue
            const until =
                job.park && job.park.until ? Date.parse(job.park.until) : 0
            if (until > clock.now().getTime() && !isExpired(job.park)) continue
            schedule(job, { resume: true })
            n++
        }
        return n
    }

    function schedulePoll() {
        if (!(pollMs > 0) || !started) return
        pollTimer = clock.setTimeout(() => {
            pollTimer = null
            try {
                poll()
            } catch (err) {
                log.error({ err }, "job poll failed")
            }
            schedulePoll()
        }, pollMs)
    }

    function start() {
        if (started) return
        started = true
        for (const row of jobsRepo.listByStatus(["running"]) || []) {
            const job = fromRow(row)
            if (inFlight.has(job.id)) continue
            save(job, {
                status: "failed",
                error: "interrupted (service restarted)",
                ended_at: now(),
            })
            notifyFailure(job, new Error("interrupted"))
        }
        const queued = (jobsRepo.listByStatus(["queued"]) || [])
            .map(fromRow)
            .sort((a, b) =>
                String(a.created_at).localeCompare(String(b.created_at))
            )
        for (const job of queued) {
            if (!inFlight.has(job.id)) schedule(job)
        }
        for (const lane of LANES) pump(lane)
        poll()
        schedulePoll()
    }

    /** Resolves when nothing is running (queued work may remain if stopped). */
    async function idle() {
        while (active.size) await Promise.allSettled([...active])
    }

    /** idle(), but give up after ms; resolves true when idle. */
    function idleWithin(ms) {
        if (!active.size) return Promise.resolve(true)
        return new Promise((resolve) => {
            const timer = clock.setTimeout(() => resolve(false), ms)
            idle().then(() => {
                clock.clearTimeout(timer)
                resolve(true)
            })
        })
    }

    /**
     * Stop picking up work, abort running jobs and wait for them (at most
     * stopTimeoutMs, then SIGKILL the remaining CLI child groups and wait a
     * moment more so providers can remove their temp dirs).
     * @returns {Promise<{ idle: boolean, aborted: number, killed: number }>}
     */
    async function stop({ timeoutMs: capMs = stopTimeoutMs } = {}) {
        started = false
        if (pollTimer != null) clock.clearTimeout(pollTimer)
        pollTimer = null
        let aborted = 0
        for (const entry of inFlight.values()) {
            if (!entry.controller || entry.applying || entry.cancelled) continue
            if (entry.controller.signal.aborted) continue
            entry.shutdown = true
            entry.controller.abort()
            aborted++
        }
        if (await idleWithin(capMs)) return { idle: true, aborted, killed: 0 }
        let killed = 0
        try {
            killed = killChildren("SIGKILL")
        } catch (err) {
            log.error({ err }, "killing center job children failed")
        }
        log.warn(
            { running: active.size, killed },
            "center jobs still running after stop timeout; killed children"
        )
        const done = await idleWithin(Math.min(1000, capMs))
        return { idle: done, aborted, killed }
    }

    function stats() {
        return Object.fromEntries(
            LANES.map((l) => [
                l,
                { running: lanes[l].running, queued: lanes[l].queue.length },
            ])
        )
    }

    return { enqueue, cancel, get, list, start, stop, poll, idle, stats }
}
