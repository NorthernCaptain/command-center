/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { ValidationError } from "../util/errors.js"
import { openDb } from "./db.js"
import { createSettingsRepo } from "./settingsRepo.js"

test("get/set/all round-trip JSON values", () => {
    const db = openDb(":memory:")
    const repo = createSettingsRepo(db)
    expect(repo.get("center.provider")).toBeNull()
    expect(repo.get("center.provider", "claude-sdk")).toBe("claude-sdk")
    expect(repo.set("center.provider", "codex")).toBe("codex")
    repo.set("center.provider", "claude-cli")
    repo.set("center.auto_fallback", false)
    repo.set("center.models", { codex: { light: "a" } })
    expect(repo.get("center.provider")).toBe("claude-cli")
    expect(repo.get("center.auto_fallback", true)).toBe(false)
    expect(repo.all()).toEqual({
        "center.auto_fallback": false,
        "center.models": { codex: { light: "a" } },
        "center.provider": "claude-cli",
    })
    expect(() => repo.set("", 1)).toThrow(ValidationError)
    expect(() => repo.set("k")).toThrow(ValidationError)
    repo.set("nul", null)
    expect(repo.get("nul", "fb")).toBeNull()
    db.close()
})
