/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */
import { createLogger, nullLogger } from "./logger.js"

test("createLogger returns a pino logger", () => {
    const log = createLogger({ level: "silent" })
    expect(typeof log.info).toBe("function")
    expect(log.level).toBe("silent")
    expect(createLogger().level).toBeDefined()
})

test("nullLogger is a no-op", () => {
    nullLogger.info()
    nullLogger.warn()
    nullLogger.error()
    nullLogger.debug()
    expect(nullLogger.child()).toBe(nullLogger)
})
