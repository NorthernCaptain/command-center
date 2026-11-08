/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { cleanCell, createRepoTable, parseRepoTable } from "./repoTable.js"

const AGENTS_MD = `# Agents

Intro text.

## 0. Main repos

These are the \`acme\` repos the user works on most.

| Repo (\`acme/…\`) | Default | Lang | What it is / aliases |
|---|---|---|---|
| \`web_app\` | \`devel\` | PHP | Main web app (backend + web) |
| \`aws-lambda\` | \`master\` | JS | AWS Lambdas and more |
| \`infrastructure\` | \`main\` | HCL | Infrastructure as code (Terraform), ops scripts. Alias: *infra* |
| \`mobile-apps\` | \`main\` | TS | New generation mobile apps. Alias: *teams-app* (local folder name) |
| \`core-py\` | \`main\` | Python/Jupyter | Internal ML and CV code |
| \`vision-ios-sdk\` | **\`multicam\`** | C++ | Vision iOS SDK. Note the non-standard default branch |
| \`ChatBot\` | \`main\` | Rust | ChatBot. Its wiki is \`acme/ChatBot.wiki\` (default \`master\`) |
| | | | |

After the table.

| other | table |
|---|---|
| \`nope\` | x |

## 1. Next section
`

describe("cleanCell", () => {
    test("strips backticks, bold and italics", () => {
        expect(cleanCell("**`multicam`**")).toBe("multicam")
        expect(cleanCell("Alias: *infra*")).toBe("Alias: infra")
        expect(cleanCell("__x__ y")).toBe("x y")
        expect(cleanCell("web_app")).toBe("web_app")
        expect(cleanCell("a * b * c")).toBe("a * b * c")
        expect(cleanCell(undefined)).toBe("")
    })
})

describe("parseRepoTable", () => {
    test("parses rows under the heading", () => {
        const repos = parseRepoTable(AGENTS_MD)
        expect(repos.map((r) => r.name)).toEqual([
            "web_app",
            "aws-lambda",
            "infrastructure",
            "mobile-apps",
            "core-py",
            "vision-ios-sdk",
            "ChatBot",
        ])
        expect(repos[0]).toEqual({
            name: "web_app",
            default_branch: "devel",
            lang: "PHP",
            description: "Main web app (backend + web)",
        })
        expect(repos[2].description).toBe(
            "Infrastructure as code (Terraform), ops scripts. Alias: infra"
        )
        expect(repos[5].default_branch).toBe("multicam")
        expect(repos[6].description).toBe(
            "ChatBot. Its wiki is acme/ChatBot.wiki (default master)"
        )
    })

    test("stops at the next heading, handles prefixes, short rows and extra pipes", () => {
        const md = [
            "## 0. Main repos",
            "| Repo | Default | Lang | What |",
            "|:--|--:|---|---|",
            "| `acme/qa-tools` | `master` | JS | QA | tools |",
            "| `short` |",
            "## 1. Other",
            "| `later` | main | JS | x |",
        ].join("\r\n")
        expect(parseRepoTable(md)).toEqual([
            {
                name: "qa-tools",
                default_branch: "master",
                lang: "JS",
                description: "QA | tools",
            },
            {
                name: "short",
                default_branch: null,
                lang: null,
                description: "",
            },
        ])
    })

    test("missing heading or empty input", () => {
        expect(parseRepoTable("# nothing here")).toEqual([])
        expect(parseRepoTable(null)).toEqual([])
        expect(parseRepoTable("## 0. Main repos\n\nno table")).toEqual([])
    })
})

describe("createRepoTable", () => {
    test("reads once and caches", () => {
        const readFile = jest.fn(() => AGENTS_MD)
        const table = createRepoTable({
            readFile,
            agentsMdPath: "/fake/AGENTS.md",
        })
        expect(table.list()).toHaveLength(7)
        expect(table.list()).toHaveLength(7)
        expect(readFile).toHaveBeenCalledTimes(1)
        expect(readFile).toHaveBeenCalledWith("/fake/AGENTS.md", "utf8")
        table.reset()
        table.list()
        expect(readFile).toHaveBeenCalledTimes(2)
    })

    test("missing file -> [] silently; other errors -> [] with a warning", () => {
        const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" })
        const log = { warn: jest.fn() }
        const t1 = createRepoTable({
            readFile: () => {
                throw enoent
            },
            agentsMdPath: "/x",
            log,
        })
        expect(t1.list()).toEqual([])
        expect(log.warn).not.toHaveBeenCalled()
        const t2 = createRepoTable({
            readFile: () => {
                throw new Error("EACCES")
            },
            agentsMdPath: "/x",
            log,
        })
        expect(t2.list()).toEqual([])
        expect(log.warn).toHaveBeenCalledTimes(1)
    })

    test("default readFile on a missing path returns []", () => {
        const table = createRepoTable({
            agentsMdPath: "/nonexistent/cc-test/AGENTS.md",
        })
        expect(table.list()).toEqual([])
    })
})
