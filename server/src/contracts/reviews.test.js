/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    DEFAULT_REVIEW_MODEL,
    REVIEW_MODEL_IDS,
    REVIEW_MODELS,
    reviewModel,
} from "./reviews.js"
import { AGENT_KINDS } from "./agentKinds.js"

test("every agent kind has review models; klaude shares claude's", () => {
    for (const k of AGENT_KINDS)
        expect(REVIEW_MODELS[k].length).toBeGreaterThan(0)
    expect(REVIEW_MODELS.klaude).toBe(REVIEW_MODELS.claude)
    expect(reviewModel("klaude", "opus-high")).toMatchObject({
        model: "opus",
        effort: "high",
    })
    expect(reviewModel("codex", "opus-high")).toBeNull()
})

test("model ids: default first, each once", () => {
    expect(REVIEW_MODEL_IDS[0]).toBe(DEFAULT_REVIEW_MODEL)
    expect(new Set(REVIEW_MODEL_IDS).size).toBe(REVIEW_MODEL_IDS.length)
    expect(REVIEW_MODEL_IDS).toContain("terra-xhigh")
})
