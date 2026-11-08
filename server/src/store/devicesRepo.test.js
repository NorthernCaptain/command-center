/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { createFakeClock } from "../util/clock.js"
import { ValidationError } from "../util/errors.js"
import { openDb } from "./db.js"
import { createDevicesRepo } from "./devicesRepo.js"

let db
let clock
let repo
beforeEach(() => {
    db = openDb(":memory:")
    clock = createFakeClock()
    repo = createDevicesRepo(db, { clock })
})
afterEach(() => db.close())

test("devices: add, find, touch, list, revoke", async () => {
    const d = repo.add({ name: "iPhone", tokenHash: "h1" })
    expect(d).toEqual({
        id: expect.stringMatching(/^d_/),
        name: "iPhone",
        created_at: "2026-11-07T12:00:00.000Z",
        last_seen_at: null,
        revoked_at: null,
    })
    expect(d).not.toHaveProperty("token_hash")
    expect(repo.findByTokenHash("h1")).toEqual(d)
    expect(repo.findByTokenHash("nope")).toBeNull()
    await clock.advance(5000)
    expect(repo.touch(d.id)).toBe(true)
    expect(repo.touch("missing")).toBe(false)
    expect(repo.get(d.id).last_seen_at).toBe("2026-11-07T12:00:05.000Z")
    const e = repo.add({ name: "iPad", tokenHash: "h2" })
    expect(repo.list().map((x) => x.id)).toEqual([e.id, d.id])
    expect(repo.revoke(d.id)).toBe(true)
    expect(repo.revoke(d.id)).toBe(false)
    expect(repo.findByTokenHash("h1")).toBeNull()
    expect(repo.get(d.id).revoked_at).toBe("2026-11-07T12:00:05.000Z")
    expect(repo.get("zzz")).toBeNull()
    expect(() => repo.add({ name: "x" })).toThrow(ValidationError)
    expect(() => repo.add({ name: "dup", tokenHash: "h2" })).toThrow()
})

test("pair codes are single use and expire", async () => {
    const { pairCodes } = repo
    const exp = new Date(clock.now().getTime() + 600000).toISOString()
    expect(pairCodes.add("c1", exp)).toEqual({
        code_hash: "c1",
        expires_at: exp,
    })
    pairCodes.add("c2", exp)
    expect(pairCodes.consume("c1")).toBe(true)
    expect(pairCodes.consume("c1")).toBe(false)
    expect(pairCodes.consume("unknown")).toBe(false)
    await clock.advance(600000)
    expect(pairCodes.consume("c2")).toBe(false)
    // Re-adding the same hash resets it; expired/used rows are purged.
    pairCodes.add("c1", new Date(clock.now().getTime() + 1000))
    expect(db.prepare("SELECT COUNT(*) AS n FROM pair_codes").get().n).toBe(1)
    expect(pairCodes.consume("c1")).toBe(true)
    expect(() => pairCodes.add("", exp)).toThrow(ValidationError)
    expect(() => pairCodes.add("x", "not a date")).toThrow(ValidationError)
})
