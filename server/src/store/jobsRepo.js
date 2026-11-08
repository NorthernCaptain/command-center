/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// center_jobs table: persistent state of center-agent jobs.

import crypto from "node:crypto"
import { ValidationError } from "../util/errors.js"
import { systemClock } from "../util/clock.js"
import { parseJson } from "./db.js"

export const JOB_STATUSES = [
    "queued",
    "running",
    "parked",
    "done",
    "failed",
    "cancelled",
]

const JSON_FIELDS = {
    input: "input_json",
    output: "output_json",
    park: "park_json",
    usage: "usage_json",
}
const PLAIN_FIELDS = [
    "task_id",
    "type",
    "lane",
    "status",
    "provider",
    "model",
    "error",
    "created_at",
    "started_at",
    "ended_at",
]

function toJob(row) {
    if (!row) return null
    const job = {}
    for (const f of ["id", ...PLAIN_FIELDS]) job[f] = row[f]
    for (const [f, col] of Object.entries(JSON_FIELDS))
        job[f] = parseJson(row[col], null)
    return job
}

function checkStatus(status) {
    if (!JOB_STATUSES.includes(status))
        throw new ValidationError(`invalid job status: ${status}`)
}

/** Map a job patch to column => value, rejecting unknown fields. */
function toColumns(patch) {
    const cols = {}
    for (const [k, v] of Object.entries(patch)) {
        if (k in JSON_FIELDS)
            cols[JSON_FIELDS[k]] =
                v === undefined || v === null ? null : JSON.stringify(v)
        else if (PLAIN_FIELDS.includes(k)) cols[k] = v ?? null
        else throw new ValidationError(`unknown job field: ${k}`)
    }
    if ("status" in cols) checkStatus(cols.status)
    return cols
}

export function createJobsRepo(db, { clock = systemClock } = {}) {
    const getSt = db.prepare("SELECT * FROM center_jobs WHERE id = ?")

    function get(id) {
        return toJob(getSt.get(String(id)))
    }

    return {
        /** insert({ id?, task_id?, type, lane, status = "queued", ... }) -> job */
        insert(job) {
            const { id: givenId, ...rest } = job
            if (!rest.type || !rest.lane)
                throw new ValidationError("job type and lane are required")
            const id = givenId || `j_${crypto.randomBytes(8).toString("hex")}`
            const cols = toColumns({
                status: "queued",
                task_id: null,
                created_at: clock.now().toISOString(),
                ...rest,
            })
            const names = ["id", ...Object.keys(cols)]
            db.prepare(
                `INSERT INTO center_jobs (${names.join(", ")})
                 VALUES (${names.map(() => "?").join(", ")})`
            ).run(id, ...Object.values(cols))
            return get(id)
        },
        /** update(id, patch) -> job | null */
        update(id, patch) {
            const cols = toColumns(patch || {})
            delete cols.created_at
            const keys = Object.keys(cols)
            if (keys.length) {
                db.prepare(
                    `UPDATE center_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")}
                     WHERE id = ?`
                ).run(...Object.values(cols), String(id))
            }
            return get(id)
        },
        get,
        /** Newest first. status may be a string or an array. */
        list({ task_id, status, limit = 50 } = {}) {
            const where = []
            const args = []
            if (task_id !== undefined && task_id !== null) {
                where.push("task_id = ?")
                args.push(Number(task_id))
            }
            const statuses = status ? [].concat(status) : []
            if (statuses.length) {
                statuses.forEach(checkStatus)
                where.push(`status IN (${statuses.map(() => "?").join(", ")})`)
                args.push(...statuses)
            }
            const sql =
                "SELECT * FROM center_jobs" +
                (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
                " ORDER BY created_at DESC, rowid DESC LIMIT ?"
            return db
                .prepare(sql)
                .all(...args, Number(limit))
                .map(toJob)
        },
        /** Oldest first (FIFO resume order). */
        listByStatus(statuses) {
            const list = [].concat(statuses || [])
            if (!list.length) return []
            list.forEach(checkStatus)
            return db
                .prepare(
                    `SELECT * FROM center_jobs
                     WHERE status IN (${list.map(() => "?").join(", ")})
                     ORDER BY created_at, rowid`
                )
                .all(...list)
                .map(toJob)
        },
    }
}
