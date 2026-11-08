/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */
// Server + CLI tests: native ESM (run with NODE_OPTIONS=--experimental-vm-modules).
// Web tests use jest.web.config.js (babel + jsdom); see package.json scripts.
export default {
    displayName: "server",
    testEnvironment: "node",
    transform: {},
    testMatch: [
        "<rootDir>/server/**/*.test.js",
        "<rootDir>/cli/**/*.test.js",
        "<rootDir>/install/**/*.test.js",
    ],
    collectCoverageFrom: [
        "server/src/**/*.js",
        "cli/**/*.js",
        "install/**/*.mjs",
        "!**/*.test.js",
        "!server/src/index.js",
    ],
    coverageDirectory: "coverage/server",
    coverageThreshold: {
        global: { lines: 90, statements: 90, functions: 85, branches: 80 },
    },
}
