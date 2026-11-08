/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import * as store from "./index.js"

test("index re-exports the public store API", () => {
    for (const name of [
        "openDb",
        "migrate",
        "createStore",
        "createGitCommitter",
        "createSchedulesRepo",
        "createJobsRepo",
        "createSettingsRepo",
        "createDevicesRepo",
        "parseSections",
        "setSection",
        "getSectionBody",
        "buildArtifactTemplate",
        "ftsQuery",
        "foldComments",
        "buildCommitMessage",
    ]) {
        expect(typeof store[name]).toBe("function")
    }
    expect(store.MIGRATIONS.length).toBeGreaterThan(0)
    expect(store.JOB_STATUSES).toContain("parked")
    expect(store.SOC2_AREAS).toEqual(["infra", "access", "security", "soc2"])
})
