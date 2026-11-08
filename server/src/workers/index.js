/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// herdr workers: identity, prompts, service and routes.

export {
    agentName,
    createIdentity,
    defaultBranch,
    folderName,
    isValidBranch,
    parseTaskNote,
    slugify,
    truncateName,
} from "./identity.js"
export {
    cleanPrompt,
    createPrPrompt,
    feedbackPrompt,
    freshContextPrompt,
    kickoffPrompt,
    orderedRepos,
    resumePrompt,
    sendToAgentPrompt,
} from "./prompts.js"
export {
    ACTIONS,
    BLOCKED_REASON,
    createWorkerService,
    UNAVAILABLE_REASON,
    USAGE_LIMIT_RE,
} from "./workerService.js"
export { mountWorkers, workerBoardExtras, workerTaskExtras } from "./routes.js"
