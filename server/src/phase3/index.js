/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Phase 3: SOC2 change records + evidence export, Web Push, morning digest
// and stale sweep. createPhase3() wires the modules for system.js.

import path from "node:path"
import { createDigest } from "./digest.js"
import { createPush } from "./push.js"
import { mountPhase3 } from "./routes.js"
import { createSoc2 } from "./soc2.js"
import { createStaleSweep } from "./stale.js"

export { PHASE3_DEFAULTS } from "./defaults.js"
export {
    assertChangeRecord,
    assertTaskChangeRecord,
    createSoc2,
    parseChangeRecord,
    requiresChangeRecord,
    toMarkdown,
} from "./soc2.js"
export { createPush } from "./push.js"
export { createDigest, localParts, summaryLine } from "./digest.js"
export { createStaleSweep } from "./stale.js"
export { mountPhase3 } from "./routes.js"

/**
 * @param {{ db: object, store: object, settingsRepo: object,
 *           devicesRepo?: object, notifier?: object, bus?: object,
 *           config: object,
 *           clock?: object, log?: object, fs?: object, webpush?: object }} deps
 *   config is the full app config (push, dataDir, timezone).
 * @returns {{ soc2, push, digest, staleSweep, mount: Function,
 *             start: Function, stop: Function, setWorkerService: Function }}
 */
export function createPhase3({
    db,
    store,
    settingsRepo,
    devicesRepo,
    notifier = null,
    bus = null,
    config,
    clock,
    log,
    fs,
    webpush,
}) {
    const opt = (o) =>
        Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
    const soc2 = createSoc2(opt({ store, clock }))
    const push = createPush(
        opt({
            db,
            config: config.push,
            devicesRepo,
            fs,
            webpush,
            clock,
            log,
        })
    )
    const staleSweep = createStaleSweep(
        opt({ store, settingsRepo, clock, log })
    )
    const digest = createDigest(
        opt({
            store,
            settingsRepo,
            notifier,
            bus,
            staleSweep,
            clock,
            log,
            fs,
            timezone: config.timezone,
            stateFile: config.dataDir
                ? path.join(config.dataDir, "digest.json")
                : null,
        })
    )

    function start() {
        push.init()
        if (notifier && typeof notifier.setPush === "function")
            notifier.setPush(push, settingsRepo)
        digest.start()
    }

    return {
        soc2,
        push,
        digest,
        staleSweep,
        mount: (api, helpers) =>
            mountPhase3(api, helpers, { soc2, push, digest }),
        start,
        stop: () => digest.stop(),
        setWorkerService: (ws) => digest.setWorkerService(ws),
    }
}
