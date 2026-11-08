/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import express from "express"
import http from "node:http"
import { startListeners } from "./server.js"

function app(name) {
    const a = express()
    a.get("/who", (req, res) => res.json({ name }))
    a.get("/stream", (req, res) => {
        res.setHeader("Content-Type", "text/event-stream")
        res.write(": open\n\n")
    })
    return a
}

function get(port, p) {
    return new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: p }, (res) => {
            let data = ""
            res.on("data", (d) => (data += d))
            res.on("end", () => resolve(JSON.parse(data)))
        }).on("error", reject)
    })
}

const cfg = (local = {}, tailnet = {}) => ({
    listeners: {
        local: { host: "127.0.0.1", port: 0, ...local },
        tailnet: { host: "127.0.0.1", port: 0, ...tailnet },
    },
})

describe("startListeners", () => {
    test("binds both apps on loopback ephemeral ports and closes", async () => {
        const logs = []
        const l = await startListeners({
            appLocal: app("local"),
            appTailnet: app("tailnet"),
            config: cfg(),
            log: { info: (o, m) => logs.push(m) },
        })
        expect(l.local.host).toBe("127.0.0.1")
        expect(l.local.port).toBeGreaterThan(0)
        expect(l.tailnet.port).not.toBe(l.local.port)
        expect(await get(l.local.port, "/who")).toEqual({ name: "local" })
        expect(await get(l.tailnet.port, "/who")).toEqual({ name: "tailnet" })
        expect(logs).toEqual(["local listening", "tailnet listening"])
        // An open stream must not block close().
        await new Promise((resolve) => {
            http.get(
                { host: "127.0.0.1", port: l.local.port, path: "/stream" },
                (res) => {
                    res.once("data", resolve)
                    res.on("error", () => {})
                }
            ).on("error", () => {})
        })
        await l.close()
        expect(l.servers.local.listening).toBe(false)
        expect(l.servers.tailnet.listening).toBe(false)
    })

    test("tailnet listener is optional", async () => {
        const l = await startListeners({
            appLocal: app("local"),
            appTailnet: null,
            config: cfg(),
        })
        expect(l.tailnet).toBeNull()
        await l.close()
    })

    test("refuses non-loopback hosts and cleans up", async () => {
        await expect(
            startListeners({
                appLocal: app("local"),
                config: cfg({ host: "0.0.0.0" }),
            })
        ).rejects.toThrow("must bind loopback")
        await expect(
            startListeners({
                appLocal: app("local"),
                appTailnet: app("tailnet"),
                config: cfg({}, { host: "0.0.0.0" }),
            })
        ).rejects.toThrow("tailnet listener must bind loopback")
    })

    test("port conflict rejects", async () => {
        const first = await startListeners({
            appLocal: app("a"),
            config: cfg(),
        })
        await expect(
            startListeners({
                appLocal: app("b"),
                config: cfg({ port: first.local.port }),
            })
        ).rejects.toThrow(/EADDRINUSE/)
        await first.close()
    })
})
