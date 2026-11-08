/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */
// Web (React) tests: jsdom + babel-jest. Run WITHOUT --experimental-vm-modules.
export default {
    displayName: "web",
    testEnvironment: "jsdom",
    transform: { "\\.[jt]sx?$": "babel-jest" },
    testMatch: ["<rootDir>/web/src/**/*.test.{js,jsx}"],
    moduleNameMapper: { "\\.css$": "<rootDir>/web/test/styleMock.js" },
    setupFilesAfterEnv: ["<rootDir>/web/test/setup.js"],
    collectCoverageFrom: [
        "web/src/**/*.{js,jsx}",
        "!**/*.test.{js,jsx}",
        "!web/src/main.jsx",
    ],
    coverageDirectory: "coverage/web",
    coverageThreshold: {
        global: { lines: 90, statements: 90, functions: 85, branches: 80 },
    },
}
