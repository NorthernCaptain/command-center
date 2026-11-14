/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// PR reviews module (docs/09-pr-reviews.md).

import { createReviewsRepo } from "./reviewsRepo.js"
import { createReviewService } from "./reviewService.js"
import { mountReviews } from "./routes.js"

export { createReviewsRepo } from "./reviewsRepo.js"
export {
    createReviewService,
    DEFAULT_REVIEWS_DIR,
    VERDICTS,
} from "./reviewService.js"
export { mountReviews } from "./routes.js"

/**
 * Build the module from the system deps.
 * @param {object} deps  db, gh, herdr, repoTable, settingsRepo, bus, clock,
 *        log, config, agentEnv, mcpArgs + optional fs / service overrides
 */
export function createReviews({ db, config = {}, clock, ...deps }) {
    const reviews = createReviewsRepo(db, { clock })
    const cfg = config.reviews || {}
    const reviewService = createReviewService({
        ...deps,
        reviews,
        clock,
        ...(cfg.dir ? { reviewsDir: cfg.dir } : {}),
        login: (config.github && config.github.login) || null,
    })
    return {
        reviews,
        reviewService,
        mount: (api, helpers) =>
            mountReviews(api, helpers, { reviewService, reviews, clock }),
    }
}
