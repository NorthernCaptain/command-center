/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// GitHub module: gh client, PR claims, PR watcher, review archive, routes.

import { createClaims } from "./claims.js"
import { createGhClient } from "./ghClient.js"
import { createPrWatcher } from "./prWatcher.js"
import { createReviewArchive } from "./reviewArchive.js"
import { githubTaskExtras, mountGithub } from "./routes.js"

export { createClaims, checkCandidate, parsePrUrl } from "./claims.js"
export { createGhClient } from "./ghClient.js"
export {
    createPrWatcher,
    classify,
    extractItems,
    verifyItem,
} from "./prWatcher.js"
export { createReviewArchive, workFolder } from "./reviewArchive.js"
export { githubTaskExtras, mountGithub } from "./routes.js"

/**
 * Build the whole module from the system deps.
 * @param {object} deps  createPrWatcher deps (store, db, workerService,
 *        jobRunner, asanaService, settingsRepo, notifier, bus, clock, log,
 *        feedbackPrompt, actionableBots) + config + optional exec / fs.
 */
export function createGithub({ config, exec, fs, ...deps }) {
    const github = (config && config.github) || {}
    const review = (config && config.review) || {}
    const org = github.org || null
    const gh = createGhClient({
        exec,
        ghBin: github.ghBin || "gh",
        org,
        log: deps.log,
    })
    const claims = createClaims(deps.db, { clock: deps.clock })
    const prWatcher = createPrWatcher({
        ...deps,
        gh,
        claims,
        org,
        pollMinutes: github.pollMinutes || 15,
    })
    const reviewArchive = createReviewArchive({
        dir: review.archiveDir,
        fs,
        dashboardUrl: review.dashboardUrl || null,
    })
    return {
        gh,
        claims,
        prWatcher,
        reviewArchive,
        mount: (api, helpers) => mountGithub(api, helpers, { prWatcher }),
        taskExtras: githubTaskExtras({ prWatcher, reviewArchive }),
    }
}
