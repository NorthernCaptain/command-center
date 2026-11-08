/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// herdr bridge: socket client, event stream, session + outbox repos.

export {
    createHerdrClient,
    HerdrError,
    HERDR_PROTOCOL,
    DEFAULT_SOCKET_PATH,
    expandHome,
    toAgentInfo,
} from "./herdrClient.js"
export {
    createHerdrEvents,
    buildSubscriptions,
    parseEvent,
} from "./herdrEvents.js"
export { createAgentSessionsRepo, SESSION_KINDS } from "./agentSessionsRepo.js"
export { createOutboxRepo } from "./outboxRepo.js"
