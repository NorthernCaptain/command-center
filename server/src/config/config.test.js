/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */
import { defaultConfig, loadConfig } from "./config.js"

const enoent = () => {
    const e = new Error("nope")
    e.code = "ENOENT"
    throw e
}

test("defaults derive paths from home and root", () => {
    const c = defaultConfig({ home: "/h", root: "/r" })
    expect(c.tasksDir).toBe("/r/tasks")
    expect(c.configDir).toBe("/h/.config/command-center")
    expect(c.listeners.tailnet.port).toBe(7789)
    // nothing identifying ships in the defaults: set in config.json
    expect(c.asana.projectGid).toBeNull()
    expect(c.asana.statusField).toBeNull()
    expect(c.owner.tailscaleLogin).toBeNull()
    expect(c.github.org).toBeNull()
    expect(c.github.actionableBots).toEqual([])
    expect(c.brain.serverName).toBeNull()
    expect(c.center.areaRepos).toEqual({})
    expect(c.git.authorEmail).toBe("command-center@localhost")
    expect(c.push.subject).toBe("mailto:command-center@localhost")
})

test("missing config file uses defaults", () => {
    const c = loadConfig({ home: "/h", root: "/r", env: {}, readFile: enoent })
    expect(c.listeners.local.port).toBe(7788)
})

test("file values deep-merge and env overrides win", () => {
    const c = loadConfig({
        home: "/h",
        root: "/r",
        env: {
            CC_TASKS_DIR: "/t",
            CC_DATA_DIR: "/d",
            CC_LOCAL_PORT: "9001",
            CC_TAILNET_PORT: "9002",
            CC_PUBLIC_BASE_URL: "https://x:8443",
        },
        readFile: (p) => {
            expect(p).toBe("/h/.config/command-center/config.json")
            return JSON.stringify({
                publicBaseUrl: "https://file",
                listeners: { local: { port: 1 } },
                asana: { projectGid: "p", assigneeGid: "a" },
                extra: [1, 2],
            })
        },
    })
    expect(c.tasksDir).toBe("/t")
    expect(c.dataDir).toBe("/d")
    expect(c.listeners.local).toEqual({ host: "127.0.0.1", port: 9001 })
    expect(c.listeners.tailnet.port).toBe(9002)
    expect(c.publicBaseUrl).toBe("https://x:8443")
    expect(c.asana.projectGid).toBe("p")
    expect(c.asana.assigneeGid).toBe("a")
    expect(c.asana.keychainService).toBe("command-center-asana")
    expect(c.extra).toEqual([1, 2])
})

test("invalid JSON or other errors propagate", () => {
    expect(() => loadConfig({ env: {}, readFile: () => "{bad" })).toThrow()
    expect(() =>
        loadConfig({
            env: {},
            readFile: () => {
                const e = new Error("perm")
                e.code = "EACCES"
                throw e
            },
        })
    ).toThrow("perm")
})

test("non-object file content is ignored", () => {
    const c = loadConfig({
        home: "/h",
        root: "/r",
        env: {},
        readFile: () => "[1]",
    })
    expect(c.tasksDir).toBe("/r/tasks")
})

test("tailscale https port: default, file, CC_HTTPS_PORT env wins", () => {
    expect(defaultConfig({ home: "/h", root: "/r" }).tailscale).toEqual({
        httpsPort: 8443,
    })
    const file = () => JSON.stringify({ tailscale: { httpsPort: 9443 } })
    const fromFile = loadConfig({
        home: "/h",
        root: "/r",
        env: {},
        readFile: file,
    })
    expect(fromFile.tailscale.httpsPort).toBe(9443)
    const fromEnv = loadConfig({
        home: "/h",
        root: "/r",
        env: { CC_HTTPS_PORT: "10443" },
        readFile: file,
    })
    expect(fromEnv.tailscale.httpsPort).toBe(10443)
})
