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
    // 5: PR reviews (docs/09): tracked repos, other developers' PRs, our
    // review decisions on them (stats) and the review agent runs.
    `
    CREATE TABLE review_repos (
        repo TEXT PRIMARY KEY,
        track INTEGER NOT NULL DEFAULT 0,
        auto_review INTEGER NOT NULL DEFAULT 0,
        last_scan_at TEXT,
        last_error TEXT,
        backfilled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT
    );

    CREATE TABLE review_prs (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        url TEXT,
        title TEXT,
        author TEXT,
        author_bot INTEGER NOT NULL DEFAULT 0,
        is_draft INTEGER NOT NULL DEFAULT 0,
        base TEXT,
        default_branch TEXT,
        head_sha TEXT,
        state TEXT,
        created_at TEXT,
        updated_at TEXT,
        merged_at TEXT,
        closed_at TEXT,
        additions INTEGER,
        deletions INTEGER,
        changed_files INTEGER,
        ci_state TEXT,
        mergeable TEXT,
        review_decision TEXT,
        decision TEXT,
        decided_at TEXT,
        decided_sha TEXT,
        first_review_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_activity_at TEXT,
        needs_review TEXT,
        first_seen_at TEXT,
        last_scanned_at TEXT,
        PRIMARY KEY (repo, number)
    );

    CREATE TABLE review_decisions (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        review_id TEXT NOT NULL,
        state TEXT NOT NULL,
        submitted_at TEXT,
        commit_sha TEXT,
        PRIMARY KEY (repo, number, review_id)
    );
    CREATE INDEX review_decisions_at ON review_decisions(submitted_at);

    CREATE TABLE review_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger_key TEXT,
        manual INTEGER NOT NULL DEFAULT 0,
        head_sha TEXT,
        agent_name TEXT,
        agent_kind TEXT,
        workspace_id TEXT,
        pane_id TEXT,
        folder TEXT,
        queued_at TEXT,
        started_at TEXT,
        reported_at TEXT,
        finished_at TEXT,
        verdict TEXT,
        issues INTEGER,
        summary TEXT,
        error TEXT,
        seen_working INTEGER NOT NULL DEFAULT 0,
        idle_since TEXT,
        nudged_at TEXT
    );
    CREATE INDEX review_runs_pr ON review_runs(repo, number, id);
    CREATE INDEX review_runs_status ON review_runs(status, id);
    `,
    // 6: the PR's review trigger (what a review would look at), stored with
    // the PR so the queue is reconciled from the stored state
    `
    ALTER TABLE review_prs ADD COLUMN trigger_key TEXT;
    `,
    // 7: a review run queued again after its agent hit a usage limit
    // points at the stopped run
    `
    ALTER TABLE review_runs ADD COLUMN retry_of INTEGER;
    `,
    // 8: the model (REVIEW_MODELS id) a review agent ran on
    `
    ALTER TABLE review_runs ADD COLUMN agent_model TEXT;
    `,
    // 9: the author asked for our review again after our latest review
    // (still pending): a re-review that must end in a new GitHub review
    `
    ALTER TABLE review_prs ADD COLUMN rerequested_at TEXT;
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
