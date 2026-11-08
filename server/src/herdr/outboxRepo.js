/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// agent_outbox table: prompts persisted before delivery to a worker agent.
// Statuses: pending -> sent | failed | cancelled. A failed row is never
// resent automatically; requeue() is the explicit (owner) retry.

import { ValidationError } from "../util/errors.js"
import { systemClock } from "../util/clock.js"

function toItem(row) {
    if (!row) return null
    return {
        id: row.id,
        task_id: row.task_id,
        text: row.text,
        reason: row.reason,
        dedupe_key: row.dedupe_key,
        status: row.status,
        error: row.error,
        created_at: row.created_at,
        sent_at: row.sent_at,
    }
}

export function createOutboxRepo(db, { clock = systemClock } = {}) {
    const now = () => clock.now().toISOString()
    const st = {
        insert: db.prepare(
            `INSERT INTO agent_outbox (task_id, text, reason, dedupe_key,
                status, created_at)
             VALUES (?, ?, ?, ?, 'pending', ?)`
        ),
        get: db.prepare("SELECT * FROM agent_outbox WHERE id = ?"),
        byKey: db.prepare(
            "SELECT * FROM agent_outbox WHERE task_id = ? AND dedupe_key = ?"
        ),
        pendingTask: db.prepare(
            `SELECT * FROM agent_outbox WHERE status = 'pending' AND task_id = ?
             ORDER BY id`
        ),
        pendingAll: db.prepare(
            "SELECT * FROM agent_outbox WHERE status = 'pending' ORDER BY id"
        ),
        sending: db.prepare(
            `UPDATE agent_outbox SET status = 'sending'
             WHERE id = ? AND status = 'pending'`
        ),
        sent: db.prepare(
            `UPDATE agent_outbox SET status = 'sent', sent_at = ?, error = NULL
             WHERE id = ? AND status IN ('pending', 'sending')`
        ),
        failed: db.prepare(
            `UPDATE agent_outbox SET status = 'failed', error = ?
             WHERE id = ? AND status IN ('pending', 'sending')`
        ),
        release: db.prepare(
            `UPDATE agent_outbox SET status = 'pending'
             WHERE id = ? AND status = 'sending'`
        ),
        interrupted: db.prepare(
            "SELECT * FROM agent_outbox WHERE status = 'sending' ORDER BY id"
        ),
        cancel: db.prepare(
            `UPDATE agent_outbox SET status = 'cancelled'
             WHERE id = ? AND status = 'pending'`
        ),
        requeue: db.prepare(
            `UPDATE agent_outbox SET status = 'pending', error = NULL
             WHERE id = ? AND status = 'failed'`
        ),
        list: db.prepare(
            `SELECT * FROM agent_outbox WHERE task_id = ?
             ORDER BY id DESC LIMIT ?`
        ),
        failedTask: db.prepare(
            `SELECT * FROM agent_outbox WHERE status = 'failed' AND task_id = ?
             ORDER BY id`
        ),
    }

    function get(id) {
        return toItem(st.get.get(Number(id)))
    }

    const enqueueTx = db.transaction((taskId, text, reason, key) => {
        if (key !== null) {
            const existing = st.byKey.get(taskId, key)
            if (existing) return existing.id
        }
        return st.insert.run(taskId, text, reason, key, now()).lastInsertRowid
    })

    return {
        get,

        /**
         * enqueue({ task_id, text, reason, dedupe_key? }) -> row.
         * A row with the same (task_id, dedupe_key) is returned as is, in
         * any status (the unique index allows one row per key): a key is
         * delivered at most once.
         */
        enqueue({ task_id, text, reason, dedupe_key } = {}) {
            const taskId = Number(task_id)
            if (!Number.isInteger(taskId) || taskId <= 0)
                throw new ValidationError("outbox item needs a task_id")
            if (typeof text !== "string" || !text.trim())
                throw new ValidationError("outbox item needs text")
            if (typeof reason !== "string" || !reason)
                throw new ValidationError("outbox item needs a reason")
            const key =
                dedupe_key === undefined || dedupe_key === null
                    ? null
                    : String(dedupe_key)
            return get(enqueueTx(taskId, text, reason, key))
        },

        /** Pending rows, FIFO. Without a task id: every task's. */
        pending(taskId) {
            const rows =
                taskId === undefined || taskId === null
                    ? st.pendingAll.all()
                    : st.pendingTask.all(Number(taskId))
            return rows.map(toItem)
        },

        /**
         * pending -> sending, persisted BEFORE the prompt is handed to herdr.
         * Returns true when this caller claimed the row. A row still
         * 'sending' after a restart was interrupted mid-send: it may have
         * reached the agent, so recoverInterrupted() fails it as uncertain
         * instead of sending it again.
         */
        markSending(id) {
            return st.sending.run(Number(id)).changes === 1
        },

        /**
         * sending -> pending: herdr explicitly refused the prompt (blocked,
         * not ready, agent gone), so nothing was delivered and it may be
         * sent again later. Returns true when a row was released.
         */
        release(id) {
            return st.release.run(Number(id)).changes === 1
        },

        /**
         * Startup: every 'sending' row -> failed ("delivery uncertain:
         * interrupted"). Returns those rows (now failed). Retry is explicit.
         */
        recoverInterrupted() {
            const rows = st.interrupted.all()
            for (const r of rows)
                st.failed.run(
                    "delivery uncertain: interrupted while sending (server restarted)",
                    r.id
                )
            return rows.map((r) => get(r.id))
        },

        /** pending|sending -> sent. Returns the row. */
        markSent(id) {
            st.sent.run(now(), Number(id))
            return get(id)
        },

        /** pending|sending -> failed with the error message. Returns the row. */
        markFailed(id, error) {
            const msg = error instanceof Error ? error.message : String(error)
            st.failed.run(msg, Number(id))
            return get(id)
        },

        /** pending -> cancelled. Returns true when something was cancelled. */
        cancel(id) {
            return st.cancel.run(Number(id)).changes === 1
        },

        /** failed -> pending (explicit owner retry). Returns the row. */
        requeue(id) {
            st.requeue.run(Number(id))
            return get(id)
        },

        /**
         * Every failed row of a task, oldest first (no limit: failed prompts
         * are never retried automatically, so none may drop out of view).
         */
        failed(taskId) {
            return st.failedTask.all(Number(taskId)).map(toItem)
        },

        /** One row by id, or null. */
        byId(id) {
            return get(id)
        },

        /** Rows of a task, newest first. */
        list(taskId, { limit = 50 } = {}) {
            return st.list.all(Number(taskId), Number(limit)).map(toItem)
        },
    }
}
