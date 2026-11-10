/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// SQLite (better-sqlite3): index of tasks/ plus runtime state. Migrations
// are tracked with PRAGMA user_version. The index tables are rebuildable
// from tasks/ (store.reindex()); everything else is runtime state.

import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"

export const MIGRATIONS = [
    // 1: phase 1 schema
    `
    CREATE TABLE tasks_index (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        area TEXT NOT NULL,
        status TEXT NOT NULL,
        visibility TEXT NOT NULL,
        shared INTEGER NOT NULL DEFAULT 0,
        lane TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        due_at TEXT,
        snooze_until TEXT,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        done_at TEXT,
        json TEXT NOT NULL
    );
    CREATE INDEX tasks_index_lane ON tasks_index(lane, updated_at);
    CREATE INDEX tasks_index_status ON tasks_index(status);
    CREATE VIRTUAL TABLE tasks_fts USING fts5(
        title, body, tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TABLE schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        fire_at TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'fired', 'cancelled', 'failed')),
        note TEXT,
        created_at TEXT NOT NULL,
        fired_at TEXT,
        error TEXT
    );
    CREATE INDEX schedules_pending ON schedules(status, fire_at);
    CREATE INDEX schedules_task ON schedules(task_id);

    CREATE TABLE center_jobs (
        id TEXT PRIMARY KEY,
        task_id INTEGER,
        type TEXT NOT NULL,
        lane TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN
            ('queued', 'running', 'parked', 'done', 'failed', 'cancelled')),
        provider TEXT,
        model TEXT,
        input_json TEXT,
        output_json TEXT,
        park_json TEXT,
        error TEXT,
        usage_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT
    );
    CREATE INDEX center_jobs_status ON center_jobs(status, created_at);
    CREATE INDEX center_jobs_task ON center_jobs(task_id, created_at);

    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );

    CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
    );

    CREATE TABLE pair_codes (
        code_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        used_at TEXT
    );

    CREATE TABLE agent_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        herdr_agent_name TEXT,
        herdr_workspace_id TEXT,
        herdr_pane_id TEXT,
        claude_session_id TEXT,
        kind TEXT,
        state TEXT,
        started_at TEXT,
        last_seen_at TEXT,
        ended_at TEXT
    );

    CREATE TABLE pr_watch (
        task_id INTEGER NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        url TEXT,
        state TEXT,
        last_comment_at TEXT,
        last_checked_at TEXT,
        ci_state TEXT,
        merged_at TEXT,
        PRIMARY KEY (repo, number)
    );
    `,
    // 2: split the FTS body by audience. public_body = artifact text + labels
    // of viewer-visible link types; private_body = comments + other labels.
    // Old bodies are kept as private (owner-only) until store.reindex() (run
    // by store.recover() on startup) rebuilds both columns from tasks/.
    `
    ALTER TABLE tasks_fts RENAME TO tasks_fts_v1;
    CREATE VIRTUAL TABLE tasks_fts USING fts5(
        title, public_body, private_body,
        tokenize = 'unicode61 remove_diacritics 2'
    );
    INSERT INTO tasks_fts (rowid, title, public_body, private_body)
        SELECT rowid, title, '', body FROM tasks_fts_v1;
    DROP TABLE tasks_fts_v1;
    `,
    // 3: phase 2/3 runtime state. agent_outbox = prompts waiting for an idle
    // agent; pr_claims = which task owns a PR (unique URL); push_subscriptions
    // = Web Push endpoints of paired devices; pr_watch gains the head SHA and
    // the CI state of that SHA. agent_sessions gains a uniqueness rule: one
    // live (not gone/ended) session per task, enforced in code.
    `
    CREATE TABLE agent_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        reason TEXT NOT NULL,
        dedupe_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT
    );
    CREATE INDEX agent_outbox_pending ON agent_outbox(status, task_id, id);
    CREATE UNIQUE INDEX agent_outbox_dedupe
        ON agent_outbox(task_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

    CREATE TABLE pr_claims (
        url TEXT PRIMARY KEY,
        task_id INTEGER NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        branch TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        manual INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX pr_claims_task ON pr_claims(task_id);

    CREATE TABLE push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        device_id TEXT,
        keys_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_ok_at TEXT,
        failures INTEGER NOT NULL DEFAULT 0
    );

    ALTER TABLE pr_watch ADD COLUMN head_sha TEXT;
    ALTER TABLE pr_watch ADD COLUMN closed_at TEXT;
    ALTER TABLE pr_watch ADD COLUMN last_review_at TEXT;
    CREATE INDEX agent_sessions_task ON agent_sessions(task_id, id);
    `,
    // 4: Close agent with "Clean folders": close the workspace once the
    // clean-up turn is over ("clean", then "clean:working" once it worked).
    `
    ALTER TABLE agent_sessions ADD COLUMN close_after TEXT;
    `,
]

/** Apply pending migrations. Returns the resulting schema version. */
export function migrate(db, migrations = MIGRATIONS) {
    const current = db.pragma("user_version", { simple: true })
    for (let v = current; v < migrations.length; v++) {
        db.transaction(() => {
            db.exec(migrations[v])
            db.pragma(`user_version = ${v + 1}`)
        })()
    }
    return db.pragma("user_version", { simple: true })
}

/**
 * Open (or create) the database at `file` (":memory:" for tests), enable
 * WAL and run migrations.
 */
export function openDb(file) {
    if (file !== ":memory:")
        fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new Database(file)
    db.pragma("journal_mode = WAL")
    db.pragma("busy_timeout = 5000")
    db.pragma("foreign_keys = ON")
    migrate(db)
    return db
}

/** Normalize a Date / ISO string to UTC ISO so text columns sort correctly. */
export function toUtcIso(value) {
    if (value === null || value === undefined || value === "") return null
    const d = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(d.getTime())) return null
    return d.toISOString()
}

export function parseJson(text, fallback = null) {
    if (text === null || text === undefined) return fallback
    try {
        return JSON.parse(text)
    } catch {
        return fallback
    }
}
