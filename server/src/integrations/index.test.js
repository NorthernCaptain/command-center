/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import * as integrations from "./index.js"

test("exports the integration factories", () => {
    for (const name of [
        "createKeychain",
        "createAsanaClient",
        "createAsanaService",
        "createBrainClient",
        "createRepoTable",
        "parseSectionName",
        "pickSection",
        "buildDescriptionHtml",
        "buildTrackingBlockHtml",
        "mergeManagedBlock",
        "parseAsanaTaskGid",
    ]) {
        expect(typeof integrations[name]).toBe("function")
    }
})
