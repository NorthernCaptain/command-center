/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// schedules table: reminders and deferred actions fired by the scheduler.

import { ScheduleCreateSchema } from "../contracts/schemas.js"
import { ValidationError } from "../util/errors.js"
import { systemClock } from "../util/clock.js"
import { parseJson, toUtcIso } from "./db.js"

function toSchedule(row) {
    if (!row) return null
    return {
        id: row.id,
        task_id: row.task_id,
        fire_at: row.fire_at,
        action: row.action,
        payload: parseJson(row.payload_json, {}),
        status: row.status,
        note: row.note,
        created_at: row.created_at,
        fired_at: row.fired_at,
        error: row.error,
    }
}

export function createSchedulesRepo(db, { clock = systemClock } = {}) {
    const now = () => clock.now().toISOString()
    const st = {
        insert: db.prepare(
            `INSERT INTO schedules (task_id, fire_at, action, payload_json,
                status, note, created_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?)`
        ),
        get: db.prepare("SELECT * FROM schedules WHERE id = ?"),
        pending: db.prepare(
            `SELECT * FROM schedules WHERE status = 'pending'
             ORDER BY fire_at, id`
        ),
        pendingBefore: db.prepare(
            `SELECT * FROM schedules WHERE status = 'pending' AND fire_at <= ?
             ORDER BY fire_at, id`
        ),
        forTask: db.prepare(
            "SELECT * FROM schedules WHERE task_id = ? ORDER BY fire_at, id"
        ),
        fired: db.prepare(
            `UPDATE schedules SET status = 'fired', fired_at = ?, error = NULL
             WHERE id = ? AND status = 'pending'`
        ),
        failed: db.prepare(
            `UPDATE schedules SET status = 'failed', fired_at = ?, error = ?
             WHERE id = ? AND status IN ('pending', 'fired')`
        ),
        cancel: db.prepare(
            `UPDATE schedules SET status = 'cancelled'
             WHERE id = ? AND status = 'pending'`
        ),
        cancelForTask: db.prepare(
            `UPDATE schedules SET status = 'cancelled'
             WHERE task_id = ? AND status = 'pending'`
        ),
    }

    function get(id) {
        return toSchedule(st.get.get(Number(id)))
    }

    return {
        /** add({ task_id, fire_at, action, payload?, note? }) -> schedule */
        add(input) {
            const parsed = ScheduleCreateSchema.safeParse(input)
            if (!parsed.success)
                throw new ValidationError(
                    "invalid schedule",
                    parsed.error.issues
                )
            const s = parsed.data
            const info = st.insert.run(
                s.task_id,
                toUtcIso(s.fire_at),
                s.action,
                JSON.stringify(s.payload),
                input.note ?? null,
                now()
            )
            return get(info.lastInsertRowid)
        },
        get,
        /** Pending schedules (optionally only those due at/before dueBefore). */
        listPending(dueBefore) {
            const rows =
                dueBefore === undefined || dueBefore === null
                    ? st.pending.all()
                    : st.pendingBefore.all(toUtcIso(dueBefore))
            return rows.map(toSchedule)
        },
        listForTask(taskId) {
            return st.forTask.all(Number(taskId)).map(toSchedule)
        },
        /** pending -> fired. Returns the schedule (status shows the outcome). */
        markFired(id) {
            st.fired.run(now(), Number(id))
            return get(id)
        },
        /** pending|fired -> failed with an error message. */
        markFailed(id, error) {
            const msg = error instanceof Error ? error.message : String(error)
            st.failed.run(now(), msg, Number(id))
            return get(id)
        },
        /** pending -> cancelled. Returns true when something was cancelled. */
        cancel(id) {
            return st.cancel.run(Number(id)).changes === 1
        },
        /** Cancel every pending schedule of a task. Returns the count. */
        cancelForTask(taskId) {
            return st.cancelForTask.run(Number(taskId)).changes
        },
    }
}
