/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */
module.exports = {
    root: true,
    env: { node: true, es2023: true, browser: true, jest: true },
    parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
    },
    plugins: ["react"],
    extends: ["eslint:recommended", "plugin:react/recommended"],
    settings: { react: { version: "detect" } },
    rules: {
        "react/react-in-jsx-scope": "off",
        "react/prop-types": "off",
        "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
    ignorePatterns: ["node_modules", "coverage", "web/dist", "data", "tasks"],
}
