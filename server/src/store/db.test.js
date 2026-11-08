/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { MIGRATIONS, migrate, openDb, parseJson, toUtcIso } from "./db.js"

const TABLES = [
    "tasks_index",
    "tasks_fts",
    "schedules",
    "center_jobs",
    "settings",
    "devices",
    "pair_codes",
    "agent_sessions",
    "pr_watch",
]

test("openDb(:memory:) creates every table", () => {
    const db = openDb(":memory:")
    const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name)
    for (const t of TABLES) expect(names).toContain(t)
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length)
    db.close()
})

test("file db uses WAL, creates the directory and migrates once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-db-"))
    const file = path.join(dir, "nested", "cc.db")
    try {
        let db = openDb(file)
        expect(db.pragma("journal_mode", { simple: true })).toBe("wal")
        db.prepare(
            "INSERT INTO settings (key, value_json) VALUES ('a', '1')"
        ).run()
        db.close()
        db = openDb(file)
        expect(migrate(db)).toBe(MIGRATIONS.length)
        expect(
            db.prepare("SELECT value_json FROM settings").get().value_json
        ).toBe("1")
        db.close()
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test("migrate applies only newer migrations", () => {
    const db = openDb(":memory:")
    const v = migrate(db, [...MIGRATIONS, "CREATE TABLE extra (x INTEGER)"])
    expect(v).toBe(MIGRATIONS.length + 1)
    db.prepare("INSERT INTO extra VALUES (1)").run()
    db.close()
})

test("schedules status CHECK constraint", () => {
    const db = openDb(":memory:")
    expect(() =>
        db
            .prepare(
                `INSERT INTO schedules (fire_at, action, status, created_at)
                 VALUES ('x', 'surface', 'bogus', 'x')`
            )
            .run()
    ).toThrow(/CHECK/)
    db.close()
})

test("toUtcIso / parseJson", () => {
    expect(toUtcIso("2026-11-07T10:00:00+02:00")).toBe(
        "2026-11-07T08:00:00.000Z"
    )
    expect(toUtcIso(new Date(0))).toBe("1970-01-01T00:00:00.000Z")
    expect(toUtcIso(null)).toBeNull()
    expect(toUtcIso("")).toBeNull()
    expect(toUtcIso("nope")).toBeNull()
    expect(parseJson('{"a":1}')).toEqual({ a: 1 })
    expect(parseJson(null, 5)).toBe(5)
    expect(parseJson("{bad", "fb")).toBe("fb")
})

test("migration 2 splits tasks_fts into public/private columns", () => {
    const old = new Database(":memory:")
    expect(migrate(old, MIGRATIONS.slice(0, 1))).toBe(1)
    old.prepare(
        "INSERT INTO tasks_fts (rowid, title, body) VALUES (7, 'Fix', 'secret')"
    ).run()
    expect(migrate(old)).toBe(MIGRATIONS.length)
    const cols = old
        .prepare("SELECT name FROM pragma_table_info('tasks_fts')")
        .all()
        .map((r) => r.name)
    expect(cols).toEqual(["title", "public_body", "private_body"])
    // Old bodies are owner-only until reindex.
    expect(
        old
            .prepare(
                "SELECT rowid, title, public_body, private_body FROM tasks_fts"
            )
            .all()
    ).toEqual([
        { rowid: 7, title: "Fix", public_body: "", private_body: "secret" },
    ])
    const match = (q) =>
        old
            .prepare("SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH ?")
            .all(q)
            .map((r) => r.rowid)
    expect(match('"secr"*')).toEqual([7])
    expect(match('{title public_body} : ("secr"*)')).toEqual([])
    expect(match('{title public_body} : ("fix"*)')).toEqual([7])
    expect(
        old
            .prepare(
                "SELECT name FROM sqlite_master WHERE name = 'tasks_fts_v1'"
            )
            .all()
    ).toEqual([])
    old.close()
})
