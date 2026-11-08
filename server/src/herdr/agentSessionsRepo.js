/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// agent_sessions table: one row per herdr worker launch. A row is live while
// ended_at IS NULL; at most one live row per task (enforced here: create()
// ends the previous live row with state "replaced").

import { ValidationError } from "../util/errors.js"
import { systemClock } from "../util/clock.js"

export const SESSION_KINDS = ["claude", "codex"]

function toSession(row) {
    if (!row) return null
    return {
        id: row.id,
        task_id: row.task_id,
        name: row.herdr_agent_name,
        workspace_id: row.herdr_workspace_id,
        pane_id: row.herdr_pane_id,
        session_id: row.claude_session_id,
        kind: row.kind,
        state: row.state,
        started_at: row.started_at,
        last_seen_at: row.last_seen_at,
        ended_at: row.ended_at,
    }
}

const UPDATABLE = {
    state: "state",
    session_id: "claude_session_id",
    last_seen_at: "last_seen_at",
}

export function createAgentSessionsRepo(db, { clock = systemClock } = {}) {
    const now = () => clock.now().toISOString()
    const st = {
        insert: db.prepare(
            `INSERT INTO agent_sessions (task_id, herdr_agent_name,
                herdr_workspace_id, herdr_pane_id, claude_session_id, kind,
                state, started_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ),
        get: db.prepare("SELECT * FROM agent_sessions WHERE id = ?"),
        current: db.prepare(
            `SELECT * FROM agent_sessions
             WHERE task_id = ? AND ended_at IS NULL
             ORDER BY id DESC LIMIT 1`
        ),
        liveForTask: db.prepare(
            `SELECT id FROM agent_sessions
             WHERE task_id = ? AND ended_at IS NULL`
        ),
        byPane: db.prepare(
            `SELECT * FROM agent_sessions
             WHERE herdr_pane_id = ? AND ended_at IS NULL
             ORDER BY id DESC LIMIT 1`
        ),
        live: db.prepare(
            "SELECT * FROM agent_sessions WHERE ended_at IS NULL ORDER BY id"
        ),
        end: db.prepare(
            `UPDATE agent_sessions SET state = ?, ended_at = ?
             WHERE id = ? AND ended_at IS NULL`
        ),
        history: db.prepare(
            "SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY id"
        ),
    }

    function get(id) {
        return toSession(st.get.get(Number(id)))
    }

    const createTx = db.transaction((s) => {
        const t = now()
        for (const { id } of st.liveForTask.all(s.task_id))
            st.end.run("replaced", t, id)
        const info = st.insert.run(
            s.task_id,
            s.name ?? null,
            s.workspace_id ?? null,
            s.pane_id ?? null,
            s.session_id ?? null,
            s.kind,
            s.state ?? "unknown",
            t,
            t
        )
        return info.lastInsertRowid
    })

    return {
        get,

        /** create({ task_id, name, workspace_id, pane_id, kind, session_id, state }) -> row */
        create(input = {}) {
            const taskId = Number(input.task_id)
            if (!Number.isInteger(taskId) || taskId <= 0)
                throw new ValidationError("agent session needs a task_id")
            if (!SESSION_KINDS.includes(input.kind))
                throw new ValidationError(`invalid agent kind: ${input.kind}`)
            return get(createTx({ ...input, task_id: taskId }))
        },

        /** Newest live row of a task, or null. */
        current(taskId) {
            return toSession(st.current.get(Number(taskId)))
        },

        /** Live row running in a herdr pane, or null. */
        byPane(paneId) {
            return toSession(st.byPane.get(String(paneId)))
        },

        /** Every live row (ended_at IS NULL), oldest first. */
        live() {
            return st.live.all().map(toSession)
        },

        /** update(id, { state?, session_id?, last_seen_at? }) -> row. last_seen_at defaults to now. */
        update(id, patch = {}) {
            const sets = []
            const values = []
            for (const [k, v] of Object.entries(patch)) {
                if (v === undefined) continue
                const col = UPDATABLE[k]
                if (!col)
                    throw new ValidationError(
                        `unknown agent session field: ${k}`
                    )
                sets.push(`${col} = ?`)
                values.push(v)
            }
            if (
                !("last_seen_at" in patch) ||
                patch.last_seen_at === undefined
            ) {
                sets.push("last_seen_at = ?")
                values.push(now())
            }
            db.prepare(
                `UPDATE agent_sessions SET ${sets.join(", ")} WHERE id = ?`
            ).run(...values, Number(id))
            return get(id)
        },

        /** End a live row (ended_at = now). Returns the row. */
        end(id, state = "gone") {
            st.end.run(state, now(), Number(id))
            return get(id)
        },

        /** All rows of a task, oldest first. */
        history(taskId) {
            return st.history.all(Number(taskId)).map(toSession)
        },
    }
}
