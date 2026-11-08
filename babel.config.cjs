/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */
// Used only by the "web" jest project (jsdom + JSX). Server tests run native ESM.
module.exports = {
    presets: [
        ["@babel/preset-env", { targets: { node: "current" } }],
        ["@babel/preset-react", { runtime: "automatic" }],
    ],
}
