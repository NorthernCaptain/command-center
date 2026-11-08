/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
    backupFile,
    BEGIN,
    codexBlock,
    END,
    main,
    mergeClaude,
    mergeCodex,
    linkSkill,
    parseOptions,
    register,
    tomlString,
} from "./register-mcp.mjs"

const TOKEN = "f".repeat(64)
const URL_ = "http://127.0.0.1:7788/mcp"
let root
let home
let repo
let n

const now = () => `ts${++n}`
const mode = (p) => fs.statSync(p).mode & 0o777
const sink = () => {
    const s = { text: "", write: (c) => (s.text += c) }
    return s
}

beforeEach(() => {
    n = 0
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-register-"))
    home = path.join(root, "home")
    repo = path.join(root, "repo")
    fs.mkdirSync(path.join(repo, "skills", "command-center"), {
        recursive: true,
    })
    fs.writeFileSync(
        path.join(repo, "skills", "command-center", "SKILL.md"),
        "---\nname: command-center\n---\n"
    )
    fs.mkdirSync(path.join(repo, "install"))
    fs.writeFileSync(path.join(repo, "install", "mcp-headers.sh"), "#!x\n")
    fs.mkdirSync(path.join(home, ".config", "command-center"), {
        recursive: true,
    })
    fs.writeFileSync(
        path.join(home, ".config", "command-center", "token"),
        TOKEN + "\n"
    )
})

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
})

describe("tomlString / codexBlock", () => {
    test("escapes", () => {
        expect(tomlString('a"b\\c\nd\re\tf')).toBe('"a\\"b\\\\c\\nd\\re\\tf"')
    })
    test("block", () => {
        expect(codexBlock({ url: URL_, token: "t" })).toBe(
            `${BEGIN}\n[mcp_servers.command-center]\nurl = "${URL_}"\n` +
                'http_headers = { Authorization = "Bearer t" }\n' +
                'env_http_headers = { "X-CC-Task" = "CC_TASK_ID" }\n' +
                `${END}\n`
        )
    })
})

describe("mergeClaude", () => {
    const file = () => path.join(home, ".claude.json")
    const args = (over = {}) => ({
        claudeJsonPath: file(),
        headersHelperPath: "/repo/install/mcp-headers.sh",
        url: URL_,
        now,
        ...over,
    })

    test("installs into a missing file, then is unchanged", () => {
        expect(mergeClaude(args({ dryRun: true })).action).toBe(
            "would-installed"
        )
        expect(fs.existsSync(file())).toBe(false)
        expect(mergeClaude(args())).toEqual({
            action: "installed",
            path: file(),
        })
        const json = JSON.parse(fs.readFileSync(file(), "utf8"))
        expect(json.mcpServers["command-center"]).toEqual({
            type: "http",
            url: URL_,
            headersHelper: "/repo/install/mcp-headers.sh",
        })
        expect(mode(file())).toBe(0o600)
        expect(mergeClaude(args()).action).toBe("unchanged")
        expect(mergeClaude(args({ dryRun: true })).action).toBe(
            "would-unchanged"
        )
    })

    test("updates keeping other keys, with a backup in the same mode", () => {
        fs.mkdirSync(home, { recursive: true })
        const before = {
            numStartups: 3,
            mcpServers: { review: { type: "http" } },
        }
        fs.writeFileSync(file(), JSON.stringify(before), { mode: 0o644 })
        expect(mergeClaude(args({ dryRun: true })).action).toBe("would-updated")
        expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toEqual(before)
        const r = mergeClaude(args())
        expect(r).toEqual({
            action: "updated",
            path: file(),
            backup: `${file()}.bak.ts1`,
        })
        expect(JSON.parse(fs.readFileSync(r.backup, "utf8"))).toEqual(before)
        expect(mode(file())).toBe(0o644)
        const json = JSON.parse(fs.readFileSync(file(), "utf8"))
        expect(json.numStartups).toBe(3)
        expect(json.mcpServers.review).toEqual({ type: "http" })
        expect(json.mcpServers["command-center"].url).toBe(URL_)
    })

    test("empty file, mcpServers not an object, bad JSON", () => {
        fs.mkdirSync(home, { recursive: true })
        fs.writeFileSync(file(), "  ")
        expect(mergeClaude(args()).action).toBe("updated")
        fs.writeFileSync(file(), JSON.stringify({ mcpServers: [] }))
        mergeClaude(args())
        expect(
            Object.keys(JSON.parse(fs.readFileSync(file(), "utf8")).mcpServers)
        ).toEqual(["command-center"])
        fs.writeFileSync(file(), "{nope")
        expect(() => mergeClaude(args())).toThrow(/cannot parse/)
        fs.writeFileSync(file(), "[1]")
        expect(() => mergeClaude(args())).toThrow(/not a JSON object/)
    })
})

describe("mergeCodex", () => {
    const file = () => path.join(home, ".codex", "config.toml")
    const args = (over = {}) => ({
        configTomlPath: file(),
        token: TOKEN,
        url: URL_,
        now,
        ...over,
    })

    test("requires a token", () => {
        expect(() => mergeCodex(args({ token: "" }))).toThrow("empty token")
    })

    test("installs, is idempotent, and is 0600", () => {
        expect(mergeCodex(args({ dryRun: true })).action).toBe(
            "would-installed"
        )
        expect(fs.existsSync(file())).toBe(false)
        expect(mergeCodex(args()).action).toBe("installed")
        expect(fs.readFileSync(file(), "utf8")).toBe(
            codexBlock({ url: URL_, token: TOKEN })
        )
        expect(mode(file())).toBe(0o600)
        fs.chmodSync(file(), 0o644)
        expect(mergeCodex(args({ dryRun: true })).action).toBe(
            "would-unchanged"
        )
        expect(mode(file())).toBe(0o644)
        expect(mergeCodex(args()).action).toBe("unchanged")
        expect(mode(file())).toBe(0o600)
    })

    test("appends after other tables and replaces its own block", () => {
        fs.mkdirSync(path.dirname(file()), { recursive: true })
        const other = '[mcp_servers.review]\nurl = "http://127.0.0.1:7777/mcp"'
        fs.writeFileSync(file(), other)
        const r = mergeCodex(args())
        expect(r.action).toBe("updated")
        expect(r.backup).toBe(`${file()}.bak.ts1`)
        expect(fs.readFileSync(r.backup, "utf8")).toBe(other)
        expect(mode(r.backup)).toBe(0o600)
        const text = fs.readFileSync(file(), "utf8")
        expect(text).toBe(
            `${other}\n\n${codexBlock({ url: URL_, token: TOKEN })}`
        )
        // token rotated: block replaced in place
        const r2 = mergeCodex(args({ token: "new" }))
        expect(r2.action).toBe("updated")
        const text2 = fs.readFileSync(file(), "utf8")
        expect(text2).toContain('"Bearer new"')
        expect(text2).not.toContain(TOKEN)
        expect(text2.split(BEGIN)).toHaveLength(2)
        expect(text2.startsWith(other)).toBe(true)
    })

    test("trailing newline and whitespace-only files", () => {
        fs.mkdirSync(path.dirname(file()), { recursive: true })
        fs.writeFileSync(file(), "model = 'x'\n")
        mergeCodex(args())
        expect(fs.readFileSync(file(), "utf8")).toBe(
            `model = 'x'\n\n${codexBlock({ url: URL_, token: TOKEN })}`
        )
        fs.writeFileSync(file(), "\n\n")
        mergeCodex(args())
        expect(fs.readFileSync(file(), "utf8")).toBe(
            codexBlock({ url: URL_, token: TOKEN })
        )
    })

    test.each([
        "[mcp_servers.command-center]\nurl = 'x'\n",
        '[mcp_servers."command-center"]\n',
        "[mcp_servers.command-center.env]\n",
    ])("refuses an unmanaged table %p", (content) => {
        fs.mkdirSync(path.dirname(file()), { recursive: true })
        fs.writeFileSync(file(), content)
        expect(() => mergeCodex(args())).toThrow(/unmanaged/)
        expect(fs.readFileSync(file(), "utf8")).toBe(content)
    })
})

describe("linkSkill", () => {
    const src = () => path.join(repo, "skills", "command-center")
    const dest = () => path.join(home, ".claude", "skills", "command-center")

    test("installs a symlink, then unchanged", () => {
        expect(linkSkill({ src: src(), dest: dest(), dryRun: true })).toEqual({
            action: "would-installed",
            path: dest(),
        })
        expect(fs.existsSync(dest())).toBe(false)
        expect(linkSkill({ src: src(), dest: dest(), now }).action).toBe(
            "installed"
        )
        expect(fs.readlinkSync(dest())).toBe(src())
        expect(linkSkill({ src: src(), dest: dest() }).action).toBe("unchanged")
        expect(
            linkSkill({ src: src(), dest: dest(), dryRun: true }).action
        ).toBe("would-unchanged")
    })

    test("moves anything else aside", () => {
        fs.mkdirSync(dest(), { recursive: true })
        fs.writeFileSync(path.join(dest(), "SKILL.md"), "old")
        expect(
            linkSkill({ src: src(), dest: dest(), dryRun: true }).action
        ).toBe("would-updated")
        const r = linkSkill({ src: src(), dest: dest(), now })
        expect(r).toEqual({
            action: "updated",
            path: dest(),
            backup: `${dest()}.bak.ts1`,
        })
        expect(fs.readFileSync(path.join(r.backup, "SKILL.md"), "utf8")).toBe(
            "old"
        )
        // a symlink pointing elsewhere is replaced too
        fs.unlinkSync(dest())
        fs.symlinkSync("/elsewhere", dest())
        expect(linkSkill({ src: src(), dest: dest(), now }).action).toBe(
            "updated"
        )
        expect(fs.readlinkSync(dest())).toBe(src())
    })

    test("lstat errors other than ENOENT propagate", () => {
        const fake = {
            lstatSync: () => {
                const e = new Error("denied")
                e.code = "EACCES"
                throw e
            },
        }
        expect(() => linkSkill({ src: src(), dest: dest(), fs: fake })).toThrow(
            "denied"
        )
    })
})

describe("backupFile", () => {
    test("keeps the source mode when none is given", () => {
        const f = path.join(root, "x")
        fs.writeFileSync(f, "x", { mode: 0o640 })
        fs.chmodSync(f, 0o640)
        const b = backupFile(fs, f, "t")
        expect(mode(b)).toBe(0o640)
    })
})

describe("parseOptions", () => {
    test("defaults and flags", () => {
        expect(parseOptions([], { HOME: "/h" })).toEqual({
            dryRun: false,
            home: "/h",
            repo: null,
            url: URL_,
            tokenFile: null,
            claude: true,
            codex: true,
        })
        expect(
            parseOptions(
                [
                    "--dry-run",
                    "--home",
                    "/x",
                    "--repo",
                    "/r",
                    "--token-file",
                    "/t",
                    "--no-claude",
                    "--no-codex",
                    "--url",
                    "http://localhost:9000/mcp",
                ],
                {}
            )
        ).toMatchObject({
            dryRun: true,
            home: "/x",
            repo: "/r",
            tokenFile: "/t",
            claude: false,
            codex: false,
            url: "http://localhost:9000/mcp",
        })
        expect(parseOptions([], { CC_LOCAL_PORT: "7790" }).url).toBe(
            "http://127.0.0.1:7790/mcp"
        )
        expect(parseOptions([]).home).toBe(os.homedir())
    })

    test("errors", () => {
        expect(() => parseOptions(["--bogus"])).toThrow(/unknown option/)
        expect(() => parseOptions(["--home"])).toThrow(/needs a value/)
        expect(() => parseOptions(["--home", "--dry-run"])).toThrow(
            /needs a value/
        )
        expect(() =>
            parseOptions(["--url", "https://evil.example/mcp"])
        ).toThrow(/loopback/)
    })
})

describe("register / main", () => {
    const opts = (over = {}) => ({
        ...parseOptions([], { HOME: home }),
        repo,
        ...over,
    })

    test("dry run changes nothing and never prints the token", () => {
        const out = sink()
        const err = sink()
        const code = main(["--dry-run", "--home", home, "--repo", repo], {
            env: {},
            stdout: out,
            stderr: err,
        })
        expect(code).toBe(0)
        expect(err.text).toBe("")
        expect(out.text).toMatch(/^dry run: nothing was changed\n/)
        expect(out.text).toContain("would-installed claude mcp server")
        expect(out.text).toContain("would-installed codex skill")
        expect(out.text).not.toContain(TOKEN)
        expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false)
        expect(fs.existsSync(path.join(home, ".codex"))).toBe(false)
        expect(fs.existsSync(path.join(home, ".claude"))).toBe(false)
    })

    test("installs everything, then everything is unchanged", () => {
        const lines = register(opts(), { now })
        expect(lines).toEqual([
            `installed claude mcp server: ${path.join(home, ".claude.json")}`,
            `installed claude skill: ${path.join(home, ".claude", "skills", "command-center")}`,
            `installed codex mcp server: ${path.join(home, ".codex", "config.toml")}`,
            `installed codex skill: ${path.join(home, ".codex", "skills", "command-center")}`,
        ])
        const claude = JSON.parse(
            fs.readFileSync(path.join(home, ".claude.json"), "utf8")
        )
        expect(claude.mcpServers["command-center"].headersHelper).toBe(
            path.join(repo, "install", "mcp-headers.sh")
        )
        const again = register(opts(), { now })
        expect(again.every((l) => l.startsWith("unchanged "))).toBe(true)
        // update with backup is reported
        fs.writeFileSync(path.join(home, ".claude.json"), "{}")
        const upd = register(opts({ codex: false }), { now })
        expect(upd[0]).toMatch(/^updated claude mcp server: .*\(backup .*\)$/)
        expect(upd).toHaveLength(2)
    })

    test("codex only with an explicit token file", () => {
        const tf = path.join(root, "tok")
        fs.writeFileSync(tf, "abc\n")
        const lines = register(opts({ claude: false, tokenFile: tf }), { now })
        expect(lines).toHaveLength(2)
        expect(
            fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")
        ).toContain('"Bearer abc"')
    })

    test("errors: missing skill, helper, token, empty token", () => {
        expect(() => register(opts({ tokenFile: "/nope/token" }))).toThrow(
            /start the command center once/
        )
        const empty = path.join(root, "empty")
        fs.writeFileSync(empty, "\n")
        expect(() => register(opts({ tokenFile: empty }))).toThrow(/empty/)
        fs.rmSync(path.join(repo, "install", "mcp-headers.sh"))
        expect(() => register(opts())).toThrow(/mcp-headers\.sh/)
        fs.rmSync(path.join(repo, "skills"), { recursive: true })
        expect(() => register(opts())).toThrow(/SKILL\.md/)
    })

    test("main reports errors with exit 1", () => {
        const out = sink()
        const err = sink()
        expect(main(["--bogus"], { env: {}, stdout: out, stderr: err })).toBe(1)
        expect(err.text).toBe("register-mcp: unknown option: --bogus\n")
    })

    test("main defaults the repo to this checkout", () => {
        const out = sink()
        const err = sink()
        const code = main(["--dry-run", "--home", home, "--no-codex"], {
            env: {},
            stdout: out,
            stderr: err,
        })
        expect(err.text).toBe("")
        expect(code).toBe(0)
        expect(out.text).toContain("would-installed claude skill")
    })
})
