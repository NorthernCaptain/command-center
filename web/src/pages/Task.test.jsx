/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    act,
    cleanup,
    fireEvent,
    screen,
    waitFor,
    within,
} from "@testing-library/react"
import TaskPage from "./Task.jsx"
import { mockFetch, reply, sampleTask } from "../../test/helpers.js"
import {
    ALL_FEATURES,
    emit,
    freshStream,
    renderWithApp,
} from "../../test/render.jsx"

const ARTIFACT = `# T-12 — Fix lambda timeout

> **Source:** slack · **Area:** backend

## Summary
The upload lambda has a cold start >10s when the bucket is large.

## Plan
Raise memory to 1024MB.
`

function taskResponse(over = {}) {
    return {
        task: sampleTask({
            asana: { gid: null, url: null },
            links: [
                {
                    id: "l1",
                    type: "pr",
                    url: "https://github.com/x/y/pull/1",
                    label: "PR #1",
                },
            ],
        }),
        revision: "t1",
        artifact: { content: ARTIFACT, revision: "a1" },
        comments: [
            {
                id: "c1",
                parent_id: null,
                anchor: {
                    section: "Summary",
                    exact: "cold start >10s",
                    prefix: "The upload lambda has a ",
                    suffix: " when the bucket is large.",
                },
                body: "is this prod only?",
                intent: "ask",
                author: "me",
                at: "2026-11-07T09:00:00Z",
                status: "open",
                replies: [
                    {
                        id: "c2",
                        parent_id: "c1",
                        body: "prod + staging",
                        intent: "ask",
                        author: "center",
                        at: "2026-11-07T09:01:00Z",
                    },
                ],
            },
            {
                id: "c3",
                parent_id: null,
                anchor: {
                    section: "Plan",
                    exact: "this sentence was deleted entirely",
                    prefix: "",
                    suffix: "",
                },
                body: "old note",
                intent: "note",
                author: "me",
                at: "2026-11-07T08:00:00Z",
                status: "open",
                replies: [],
            },
            {
                id: "c4",
                parent_id: null,
                anchor: null,
                body: "done thing",
                intent: "note",
                author: "me",
                at: "2026-11-07T07:00:00Z",
                status: "resolved",
                resolution: "applied",
                replies: [],
            },
        ],
        feedback: [],
        events: [
            {
                at: "2026-11-07T09:00:00Z",
                actor: "center",
                type: "updated",
                data: { changed: ["title", "area"] },
            },
        ],
        schedules: [
            {
                id: 3,
                task_id: 12,
                fire_at: "2026-11-08T09:00:00Z",
                action: "surface",
                status: "pending",
                note: "check PR",
            },
        ],
        jobs: [],
        ...over,
    }
}

let stream
beforeEach(() => {
    stream = freshStream()
    Element.prototype.scrollIntoView = jest.fn()
})

async function setup(routes = {}, opts) {
    const f = mockFetch({ "GET /api/tasks/12": taskResponse(), ...routes })
    renderWithApp(<TaskPage id={12} />, opts)
    await screen.findByRole("heading", { name: "Fix lambda timeout" })
    return f
}

function selectText(root, phrase) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
        const i = node.nodeValue.indexOf(phrase)
        if (i >= 0) {
            const range = document.createRange()
            range.setStart(node, i)
            range.setEnd(node, i + phrase.length)
            const sel = document.getSelection()
            sel.removeAllRanges()
            sel.addRange(range)
            return range
        }
    }
    throw new Error(`text not found: ${phrase}`)
}

const article = () => document.querySelector("article.artifact")

describe("Task page", () => {
    it("renders the artifact with highlights and comment threads", async () => {
        await setup()
        expect(article().querySelector("h2").textContent).toBe("Summary")
        const mark = article().querySelector('mark[data-comment-id="c1"]')
        expect(mark.textContent).toBe("cold start >10s")
        expect(article().querySelector('mark[data-comment-id="c3"]')).toBeNull()
        expect(screen.getByText("is this prod only?")).toBeInTheDocument()
        expect(screen.getByText("prod + staging")).toBeInTheDocument()
        // orphaned section
        expect(await screen.findByText("Orphaned · 1")).toBeInTheDocument()
        expect(screen.getByText("text gone")).toBeInTheDocument()
        // resolved collapsed
        expect(screen.queryByText("done thing")).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: /Resolved · 1/ }))
        expect(screen.getByText("done thing")).toBeInTheDocument()
        expect(screen.getByText("✓ applied")).toBeInTheDocument()
    })

    it("focuses a thread from a highlight and a highlight from a thread", async () => {
        await setup()
        const mark = article().querySelector('mark[data-comment-id="c1"]')
        fireEvent.click(mark)
        await waitFor(() => expect(mark).toHaveClass("is-active"))
        expect(document.querySelector('[data-thread-id="c1"]')).toHaveClass(
            "is-active"
        )
        fireEvent.click(screen.getByRole("button", { name: "cold start >10s" }))
        expect(mark).toHaveClass("is-active")
    })

    it("scrolls to a thread on every explicit focus, not on live updates", async () => {
        await setup()
        const scroll = Element.prototype.scrollIntoView
        // the comments panel scrolls its thread too; count the artifact's
        const markScrolls = () =>
            scroll.mock.contexts.filter((el) => el.tagName === "MARK").length
        const focus = () =>
            fireEvent.click(
                screen.getByRole("button", { name: "cold start >10s" })
            )
        focus()
        await waitFor(() => expect(markScrolls()).toBe(1))
        // the same, already active thread again: scrolls again
        focus()
        await waitFor(() => expect(markScrolls()).toBe(2))
        // a live update re-creates the highlights but does not scroll
        act(() =>
            emit(stream, "comment.updated", 12, {
                comment: { id: "c2", body: "edited", status: "open" },
            })
        )
        expect(markScrolls()).toBe(2)
    })

    it("changes status with the base revision", async () => {
        const f = await setup({
            "PATCH /api/tasks/12": {
                task: sampleTask({ status: "review" }),
                revision: "t2",
            },
        })
        const select = screen.getByLabelText("Status")
        const options = [...select.options].map((o) => o.value)
        expect(options).toEqual(
            [
                "waiting",
                "active",
                "ready",
                "ready_for_pr",
                "review",
                "done",
                "cancelled",
            ].sort(
                (a, b) =>
                    [
                        "inbox",
                        "ready",
                        "waiting",
                        "active",
                        "ready_for_pr",
                        "pr_open",
                        "pr_feedback",
                        "review",
                        "done",
                        "cancelled",
                    ].indexOf(a) -
                    [
                        "inbox",
                        "ready",
                        "waiting",
                        "active",
                        "ready_for_pr",
                        "pr_open",
                        "pr_feedback",
                        "review",
                        "done",
                        "cancelled",
                    ].indexOf(b)
            )
        )
        fireEvent.change(select, { target: { value: "review" } })
        await waitFor(() =>
            expect(screen.getByLabelText("Status")).toHaveValue("review")
        )
        expect(f.find("PATCH", "/api/tasks/12")[0].body).toEqual({
            patch: { status: "review" },
            base_revision: "t1",
        })
        fireEvent.change(screen.getByLabelText("Area"), {
            target: { value: "infra" },
        })
        await waitFor(() =>
            expect(f.find("PATCH", "/api/tasks/12")).toHaveLength(2)
        )
        expect(f.find("PATCH", "/api/tasks/12")[1].body).toEqual({
            patch: { area: "infra" },
            base_revision: "t2",
        })
    })

    it("reloads on a stale task patch and toasts other errors", async () => {
        let n = 0
        const f = await setup({
            "PATCH /api/tasks/12": () =>
                n++ === 0
                    ? reply(409, {
                          error: "stale_revision",
                          details: { current: { revision: "t9" } },
                      })
                    : reply(400, {
                          error: "illegal_transition",
                          message: "illegal status transition",
                      }),
        })
        fireEvent.change(screen.getByLabelText("Status"), {
            target: { value: "done" },
        })
        expect(
            await screen.findByText(/The task changed meanwhile/)
        ).toBeInTheDocument()
        await waitFor(() =>
            expect(f.find("GET", "/api/tasks/12").length).toBe(2)
        )
        fireEvent.click(screen.getByRole("button", { name: "✓ Done" }))
        expect(
            await screen.findByText("illegal status transition")
        ).toBeInTheDocument()
    })

    it("edits and saves the artifact", async () => {
        const f = await setup({
            "PUT /api/tasks/12/artifact": { revision: "a2" },
        })
        fireEvent.click(screen.getByRole("button", { name: "Edit" }))
        const ta = screen.getByLabelText("Artifact markdown")
        expect(ta.value).toBe(ARTIFACT)
        fireEvent.change(ta, { target: { value: ARTIFACT + "\nMore.\n" } })
        fireEvent.keyDown(ta, { key: "s", metaKey: true })
        await screen.findByText("Artifact saved")
        expect(f.find("PUT", "/api/tasks/12/artifact")[0].body).toEqual({
            content: ARTIFACT + "\nMore.\n",
            base_revision: "a1",
        })
        expect(article().textContent).toContain("More.")
        expect(screen.getByText("a2")).toBeInTheDocument()
    })

    it("edits a CRLF artifact as LF and merges a 409 cleanly", async () => {
        const crlf = ARTIFACT.replace(/\n/g, "\r\n")
        const theirs = crlf.replace(
            "Raise memory to 1024MB.",
            "Raise memory to 2048MB."
        )
        let puts = 0
        const f = await setup({
            "GET /api/tasks/12": taskResponse({
                artifact: { content: crlf, revision: "a1" },
            }),
            "PUT /api/tasks/12/artifact": () =>
                puts++ === 0
                    ? reply(409, {
                          error: "stale_revision",
                          details: {
                              current: { content: theirs, revision: "a2" },
                          },
                      })
                    : { revision: "a3" },
        })
        fireEvent.click(screen.getByRole("button", { name: "Edit" }))
        const ta = screen.getByLabelText("Artifact markdown")
        expect(ta.value).toBe(ARTIFACT)
        const mine = ARTIFACT.replace("## Summary", "## Overview")
        fireEvent.change(ta, { target: { value: mine } })
        fireEvent.keyDown(ta, { key: "s", metaKey: true })
        fireEvent.click(await screen.findByRole("button", { name: /Merge/ }))
        expect(
            screen.getByText(
                "Merged onto the latest revision. Review and save."
            )
        ).toBeInTheDocument()
        const merged = screen.getByLabelText("Artifact markdown").value
        expect(merged).toBe(mine.replace("1024MB", "2048MB"))
        fireEvent.keyDown(screen.getByLabelText("Artifact markdown"), {
            key: "s",
            metaKey: true,
        })
        await screen.findByText("Artifact saved")
        expect(f.find("PUT", "/api/tasks/12/artifact")[1].body).toEqual({
            content: merged,
            base_revision: "a2",
        })
    })

    it("handles a 409 with merge, keep-mine and reload", async () => {
        const theirs = ARTIFACT.replace(
            "Raise memory to 1024MB.",
            "Raise memory to 1024MB.\nAdd provisioned concurrency."
        )
        let puts = 0
        const f = await setup({
            "PUT /api/tasks/12/artifact": () =>
                ++puts === 1
                    ? reply(409, {
                          error: "stale_revision",
                          message: "base_revision does not match current",
                          details: {
                              current: { content: theirs, revision: "a5" },
                          },
                      })
                    : { revision: "a6" },
        })
        fireEvent.click(screen.getByRole("button", { name: "Edit" }))
        const ta = screen.getByLabelText("Artifact markdown")
        const mine = ARTIFACT.replace("cold start >10s", "cold start of 12s")
        fireEvent.change(ta, { target: { value: mine } })
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
        expect(
            await screen.findByText(
                "The artifact changed while you were editing."
            )
        ).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()

        fireEvent.click(screen.getByRole("button", { name: "Merge my edits" }))
        const merged = screen.getByLabelText("Artifact markdown").value
        expect(merged).toContain("cold start of 12s")
        expect(merged).toContain("Add provisioned concurrency.")
        expect(
            screen.getByText(/Merged onto the latest revision/)
        ).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
        await screen.findByText("Artifact saved")
        expect(
            f.find("PUT", "/api/tasks/12/artifact")[1].body.base_revision
        ).toBe("a5")
    })

    it("409 without content fetches the current artifact; keep mine and reload paths", async () => {
        let gets = 0
        let puts = 0
        await setup({
            "GET /api/tasks/12": () =>
                ++gets === 1
                    ? taskResponse()
                    : taskResponse({
                          artifact: { content: "# server", revision: "a7" },
                      }),
            "PUT /api/tasks/12/artifact": () =>
                ++puts <= 2
                    ? reply(409, { error: "stale_revision" })
                    : reply(500, { error: "x", message: "disk full" }),
        })
        fireEvent.click(screen.getByRole("button", { name: "Edit" }))
        fireEvent.change(screen.getByLabelText("Artifact markdown"), {
            target: { value: "# mine" },
        })
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
        await screen.findByText("The artifact changed while you were editing.")
        expect(screen.getByText("# server")).toBeInTheDocument()
        fireEvent.click(
            screen.getByRole("button", { name: "Keep mine (overwrite)" })
        )
        expect(screen.getByText(/Saving will overwrite/)).toBeInTheDocument()
        expect(screen.getByLabelText("Artifact markdown").value).toBe("# mine")
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
        await screen.findByText("The artifact changed while you were editing.")
        fireEvent.click(screen.getByRole("button", { name: /Discard mine/ }))
        expect(article().textContent).toContain("server")
        // other save errors are toasted and keep the editor
        fireEvent.click(screen.getByRole("button", { name: "Edit" }))
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
        expect(await screen.findByText("disk full")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
        expect(
            screen.queryByLabelText("Artifact markdown")
        ).not.toBeInTheDocument()
    })

    it("a clashing merge keeps my text between conflict markers", async () => {
        const theirs = ARTIFACT.replace(
            "Raise memory to 1024MB.",
            "Raise memory to 2048MB (agent)."
        )
        let puts = 0
        const f = await setup({
            "PUT /api/tasks/12/artifact": () =>
                ++puts === 1
                    ? reply(409, {
                          error: "stale_revision",
                          details: {
                              current: { content: theirs, revision: "a5" },
                          },
                      })
                    : { revision: "a6" },
        })
        fireEvent.click(screen.getByRole("button", { name: "Edit" }))
        const mine = ARTIFACT.replace(
            "Raise memory to 1024MB.",
            "Raise memory to 1536MB, my careful wording."
        )
        fireEvent.change(screen.getByLabelText("Artifact markdown"), {
            target: { value: mine },
        })
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
        await screen.findByText("The artifact changed while you were editing.")
        // ⌘S is ignored while the conflict is open
        fireEvent.keyDown(screen.getByLabelText("Artifact markdown"), {
            key: "s",
            metaKey: true,
        })
        expect(f.find("PUT", "/api/tasks/12/artifact")).toHaveLength(1)

        fireEvent.click(screen.getByRole("button", { name: "Merge my edits" }))
        const merged = screen.getByLabelText("Artifact markdown").value
        expect(merged).toContain(
            "<<<<<<< mine\nRaise memory to 1536MB, my careful wording.\n=======\nRaise memory to 2048MB (agent).\n>>>>>>> current"
        )
        expect(screen.getByText(/1 conflicting block/)).toBeInTheDocument()
        // saving with markers is refused
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
        expect(screen.getByText(/Resolve the <<<<<<< mine/)).toBeInTheDocument()
        expect(f.find("PUT", "/api/tasks/12/artifact")).toHaveLength(1)
        // my original text can be restored
        fireEvent.click(screen.getByRole("button", { name: "Restore my text" }))
        expect(screen.getByLabelText("Artifact markdown").value).toBe(mine)
        expect(screen.getByText(/Restored your text/)).toBeInTheDocument()
        expect(
            screen.queryByRole("button", { name: "Restore my text" })
        ).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
        await screen.findByText("Artifact saved")
        expect(f.find("PUT", "/api/tasks/12/artifact")[1].body).toEqual({
            content: mine,
            base_revision: "a5",
        })
    })

    it("keeps keystrokes typed during a save and ignores repeated ⌘S", async () => {
        let release
        const f = await setup({
            "PUT /api/tasks/12/artifact": () =>
                new Promise((r) => (release = () => r({ revision: "a2" }))),
        })
        fireEvent.click(screen.getByRole("button", { name: "Edit" }))
        const ta = screen.getByLabelText("Artifact markdown")
        fireEvent.change(ta, { target: { value: ARTIFACT + "one" } })
        fireEvent.keyDown(ta, { key: "s", metaKey: true })
        fireEvent.keyDown(ta, { key: "s", ctrlKey: true })
        fireEvent.change(ta, { target: { value: ARTIFACT + "one two" } })
        fireEvent.keyDown(ta, { key: "s", metaKey: true })
        expect(f.find("PUT", "/api/tasks/12/artifact")).toHaveLength(1)
        expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled()
        await act(async () => release())
        await screen.findByText("Artifact saved")
        // still editing, with the newer text and the new base revision
        expect(screen.getByLabelText("Artifact markdown").value).toBe(
            ARTIFACT + "one two"
        )
        expect(screen.getByText(/Edits made while saving/)).toBeInTheDocument()
        expect(screen.getAllByText("a2").length).toBeGreaterThan(0)
        fireEvent.keyDown(screen.getByLabelText("Artifact markdown"), {
            key: "s",
            metaKey: true,
        })
        await waitFor(() =>
            expect(f.find("PUT", "/api/tasks/12/artifact")).toHaveLength(2)
        )
        expect(f.find("PUT", "/api/tasks/12/artifact")[1].body).toEqual({
            content: ARTIFACT + "one two",
            base_revision: "a2",
        })
        await act(async () => release())
        await waitFor(() =>
            expect(
                screen.queryByLabelText("Artifact markdown")
            ).not.toBeInTheDocument()
        )
    })

    it("a conflict during a save keeps text typed meanwhile", async () => {
        let release
        await setup({
            "PUT /api/tasks/12/artifact": () =>
                new Promise(
                    (r) =>
                        (release = () =>
                            r(
                                reply(409, {
                                    error: "stale_revision",
                                    details: {
                                        current: {
                                            content: "# theirs",
                                            revision: "a9",
                                        },
                                    },
                                })
                            ))
                ),
        })
        fireEvent.click(screen.getByRole("button", { name: "Edit" }))
        const ta = screen.getByLabelText("Artifact markdown")
        fireEvent.change(ta, { target: { value: "# first" } })
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
        fireEvent.change(ta, { target: { value: "# first and more" } })
        await act(async () => release())
        await screen.findByText("The artifact changed while you were editing.")
        expect(screen.getByLabelText("Artifact markdown").value).toBe(
            "# first and more"
        )
    })

    it("cancelling during a save closes the editor for good", async () => {
        let release
        await setup({
            "PUT /api/tasks/12/artifact": () =>
                new Promise((r) => (release = () => r({ revision: "a3" }))),
        })
        fireEvent.click(screen.getByRole("button", { name: "Edit" }))
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
        await act(async () => release())
        await screen.findByText("Artifact saved")
        expect(
            screen.queryByLabelText("Artifact markdown")
        ).not.toBeInTheDocument()
    })

    it("comments on a selection with an anchor", async () => {
        const f = await setup({
            "POST /api/tasks/12/comments": reply(201, {
                comment: {
                    id: "c9",
                    parent_id: null,
                    anchor: {
                        section: "Plan",
                        exact: "1024MB",
                        prefix: "",
                        suffix: "",
                    },
                    body: "make it 2048",
                    intent: "change",
                    author: "me",
                    at: "2026-11-07T10:00:00Z",
                },
                job: { id: "j9", type: "assist", status: "queued" },
            }),
        })
        selectText(article(), "Raise memory")
        fireEvent.mouseUp(article())
        const toolbar = await screen.findByRole("toolbar", {
            name: "Selection actions",
        })
        fireEvent.click(within(toolbar).getByRole("button", { name: "Change" }))
        const box = screen.getByLabelText("Change")
        expect(
            screen.getByText("Raise memory", { selector: "blockquote" })
        ).toBeInTheDocument()
        fireEvent.change(box, { target: { value: "make it 2048" } })
        fireEvent.keyDown(box, { key: "Enter", metaKey: true })
        await waitFor(() =>
            expect(f.find("POST", "/api/tasks/12/comments")).toHaveLength(1)
        )
        const body = f.find("POST", "/api/tasks/12/comments")[0].body
        expect(body.intent).toBe("change")
        expect(body.body).toBe("make it 2048")
        expect(body.anchor).toEqual({
            section: "Plan",
            exact: "Raise memory",
            prefix: expect.stringContaining("Plan"),
            suffix: expect.stringContaining(" to 1024MB."),
        })
        expect(
            await screen.findByText("make it 2048", { selector: ".msg-body" })
        ).toBeInTheDocument()
        expect(screen.getByText("Center agent")).toBeInTheDocument() // job chip
        expect(
            screen.queryByRole("toolbar", { name: "Selection actions" })
        ).not.toBeInTheDocument()
    })

    it("selection composer: switch intent, cancel, escape, FAB and errors", async () => {
        await setup({
            "POST /api/tasks/12/comments": reply(500, {
                error: "x",
                message: "nope",
            }),
        })
        selectText(article(), "upload lambda")
        fireEvent.mouseUp(article())
        fireEvent.click(
            await screen.findByRole("button", { name: "Comment on selection" })
        )
        const composer = screen.getByRole("form", {
            name: "Comment on selection",
        })
        fireEvent.click(within(composer).getByRole("button", { name: "Ask" }))
        expect(
            screen.getByRole("form", { name: "Ask on selection" })
        ).toBeInTheDocument()
        const box = screen.getByLabelText("Ask")
        fireEvent.change(box, { target: { value: "which account?" } })
        fireEvent.click(
            within(
                screen.getByRole("form", { name: "Ask on selection" })
            ).getByRole("button", { name: "Send" })
        )
        expect(await screen.findByText("nope")).toBeInTheDocument()
        expect(screen.getByLabelText("Ask").value).toBe("which account?") // draft kept
        fireEvent.keyDown(screen.getByLabelText("Ask"), { key: "Escape" })
        expect(
            screen.queryByRole("form", { name: "Ask on selection" })
        ).not.toBeInTheDocument()

        selectText(article(), "upload lambda")
        fireEvent.mouseUp(article())
        fireEvent.click(
            within(
                await screen.findByRole("toolbar", {
                    name: "Selection actions",
                })
            ).getByRole("button", { name: "Comment" })
        )
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
        expect(screen.queryByRole("form")).not.toBeInTheDocument()

        // collapsed selection hides the popover
        document.getSelection().removeAllRanges()
        fireEvent.mouseUp(article())
        expect(
            screen.queryByRole("toolbar", { name: "Selection actions" })
        ).not.toBeInTheDocument()
        // selection outside the artifact is ignored
        selectText(document.querySelector(".task-title"), "Fix lambda")
        fireEvent.mouseUp(article())
        expect(
            screen.queryByRole("toolbar", { name: "Selection actions" })
        ).not.toBeInTheDocument()
    })

    it("selectionchange is debounced", async () => {
        await setup()
        jest.useFakeTimers()
        selectText(article(), "Raise memory")
        fireEvent(document, new Event("selectionchange"))
        act(() => jest.advanceTimersByTime(200))
        jest.useRealTimers()
        expect(
            screen.getByRole("toolbar", { name: "Selection actions" })
        ).toBeInTheDocument()
    })

    it("chat bar posts chat comments and shows streamed job text", async () => {
        const f = await setup({
            "POST /api/tasks/12/comments": reply(201, {
                comment: {
                    id: "c10",
                    parent_id: null,
                    anchor: null,
                    body: "add staging",
                    intent: "chat",
                    author: "me",
                    at: "2026-11-07T10:00:00Z",
                },
                job: { id: "j10", type: "assist", status: "queued" },
            }),
            "POST /api/jobs/j10/cancel": { ok: true },
        })
        const input = screen.getByLabelText("Message the center agent")
        fireEvent.change(input, {
            target: { value: "add that staging is affected too" },
        })
        fireEvent.submit(input.closest("form"))
        await waitFor(() =>
            expect(f.find("POST", "/api/tasks/12/comments")).toHaveLength(1)
        )
        expect(f.find("POST", "/api/tasks/12/comments")[0].body).toEqual({
            body: "add that staging is affected too",
            intent: "chat",
        })
        await waitFor(() => expect(input.value).toBe(""))
        act(() =>
            emit(stream, "job.updated", 12, {
                job: {
                    id: "j10",
                    type: "assist",
                    status: "running",
                    provider: "claude-sdk",
                },
            })
        )
        act(() =>
            emit(stream, "job.delta", 12, {
                job_id: "j10",
                text: "Updating Context…",
            })
        )
        expect(screen.getByText("Updating Context…")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
        await waitFor(() =>
            expect(f.find("POST", "/api/jobs/j10/cancel")).toHaveLength(1)
        )
        act(() =>
            emit(stream, "job.updated", 12, {
                job: {
                    id: "j10",
                    type: "assist",
                    status: "failed",
                    error: "provider_limit",
                    ended_at: new Date().toISOString(),
                },
            })
        )
        expect(screen.getByText("provider_limit")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
        expect(screen.queryByText("provider_limit")).not.toBeInTheDocument()
    })

    it("the chat reply shows above the input with the request, once", async () => {
        const f = await setup({
            "POST /api/tasks/12/comments": reply(201, {
                comment: {
                    id: "c12",
                    parent_id: null,
                    anchor: null,
                    body: "tell the agent to create a pr",
                    intent: "chat",
                    author: "me",
                    at: "2026-11-07T10:00:00Z",
                },
                job: { id: "j12", type: "assist", status: "queued" },
            }),
        })
        const input = screen.getByLabelText("Message the center agent")
        fireEvent.change(input, {
            target: { value: "tell the agent to create a pr" },
        })
        fireEvent.submit(input.closest("form"))
        await waitFor(() =>
            expect(f.find("POST", "/api/tasks/12/comments")).toHaveLength(1)
        )
        const panel = await screen.findByRole("region", {
            name: "Center agent reply",
        })
        expect(panel).toHaveTextContent("tell the agent to create a pr")
        act(() =>
            emit(stream, "job.updated", 12, {
                job: {
                    id: "j12",
                    type: "assist",
                    status: "done",
                    summary: "Asking it now.\n\n→ Sent to the herdr agent.",
                    ended_at: new Date().toISOString(),
                },
            })
        )
        expect(panel).toHaveTextContent("→ Sent to the herdr agent.")
        expect(document.querySelectorAll('[data-job-id="j12"]')).toHaveLength(1)
        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
        expect(
            screen.queryByRole("region", { name: "Center agent reply" })
        ).not.toBeInTheDocument()
        expect(document.querySelector('[data-job-id="j12"]')).toBeNull()
    })

    it("the latest chat exchange shows again on return until closed", async () => {
        window.localStorage.clear()
        const base = taskResponse()
        const res = {
            ...base,
            comments: [
                ...base.comments,
                {
                    id: "c30",
                    parent_id: null,
                    anchor: null,
                    body: "add a note on deletion",
                    intent: "chat",
                    author: "me",
                    at: new Date(Date.now() - 3600e3).toISOString(),
                    status: "resolved",
                    replies: [],
                },
            ],
            jobs: [
                {
                    id: "j30",
                    task_id: 12,
                    comment_id: "c30",
                    type: "assist",
                    status: "done",
                    summary: "Added a note to Context.",
                    ended_at: new Date().toISOString(),
                },
            ],
        }
        mockFetch({ "GET /api/tasks/12": res })
        const first = renderWithApp(<TaskPage id={12} />)
        const panel = await screen.findByRole("region", {
            name: "Center agent reply",
        })
        expect(panel).toHaveTextContent("add a note on deletion")
        expect(panel).toHaveTextContent("Added a note to Context.")
        // "Full chat" opens the Chat tab with the whole conversation, which
        // is not in Comments
        fireEvent.click(screen.getByRole("button", { name: "Full chat" }))
        const log = await screen.findByRole("list", {
            name: "Chat with the center agent",
        })
        expect(log).toHaveTextContent("add a note on deletion")
        expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute(
            "aria-selected",
            "true"
        )
        fireEvent.click(screen.getByRole("tab", { name: /Comments/ }))
        expect(
            document.querySelector('.side-body [data-thread-id="c30"]')
        ).toBeNull()
        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
        expect(
            screen.queryByRole("region", { name: "Center agent reply" })
        ).not.toBeInTheDocument()
        first.unmount()

        // closed here: it stays closed next time
        renderWithApp(<TaskPage id={12} />)
        await screen.findByRole("heading", { name: "Fix lambda timeout" })
        expect(
            screen.queryByRole("region", { name: "Center agent reply" })
        ).not.toBeInTheDocument()
        window.localStorage.clear()
    })

    it("an unsent chat message comes back when the page is opened again", async () => {
        await setup()
        fireEvent.change(screen.getByLabelText("Message the center agent"), {
            target: { value: "remember to check staging" },
        })
        cleanup()
        renderWithApp(<TaskPage id={12} />)
        await screen.findByRole("heading", { name: "Fix lambda timeout" })
        expect(screen.getByLabelText("Message the center agent").value).toBe(
            "remember to check staging"
        )
        window.localStorage.clear()
    })

    it("a chat job replaced while running stays visible as a chip", async () => {
        let n = 0
        const f = await setup({
            "POST /api/tasks/12/comments": () =>
                reply(201, {
                    comment: {
                        id: `c2${++n}`,
                        parent_id: null,
                        anchor: null,
                        body: "x",
                        intent: "chat",
                        author: "me",
                        at: "2026-11-07T10:00:00Z",
                    },
                    job: { id: `j2${n}`, type: "assist", status: "queued" },
                }),
        })
        const input = screen.getByLabelText("Message the center agent")
        for (const text of ["first", "second"]) {
            fireEvent.change(input, { target: { value: text } })
            fireEvent.submit(input.closest("form"))
            await waitFor(() => expect(input.value).toBe(""))
        }
        expect(f.find("POST", "/api/tasks/12/comments")).toHaveLength(2)
        const panel = screen.getByRole("region", { name: "Center agent reply" })
        expect(panel).toHaveTextContent("second")
        act(() =>
            emit(stream, "job.updated", 12, {
                job: { id: "j21", type: "assist", status: "running" },
            })
        )
        expect(document.querySelectorAll('[data-job-id="j21"]')).toHaveLength(1)
        expect(panel.querySelector('[data-job-id="j21"]')).toBeNull()
    })

    it("replies, resolves and reopens threads", async () => {
        const f = await setup({
            "POST /api/tasks/12/comments": reply(201, {
                comment: {
                    id: "c11",
                    parent_id: "c1",
                    body: "and dev?",
                    intent: "ask",
                    author: "me",
                    at: "2026-11-07T10:00:00Z",
                },
            }),
            "PATCH /api/tasks/12/comments/c1": {
                comment: { id: "c1", status: "resolved" },
            },
            "PATCH /api/tasks/12/comments/c4": reply(500, {
                error: "x",
                message: "cannot reopen",
            }),
        })
        const thread = document.querySelector('[data-thread-id="c1"]')
        fireEvent.change(within(thread).getByLabelText("Reply"), {
            target: { value: "and dev?" },
        })
        fireEvent.click(within(thread).getByRole("button", { name: "Reply" }))
        expect(await screen.findByText("and dev?")).toBeInTheDocument()
        // a plain reply is a note: it does not re-run the agent
        expect(f.find("POST", "/api/tasks/12/comments")[0].body).toEqual({
            body: "and dev?",
            intent: "note",
            parent_id: "c1",
        })
        // "Ask agent" sends the thread's intent
        fireEvent.change(within(thread).getByLabelText("Reply"), {
            target: { value: "and staging?" },
        })
        fireEvent.click(
            within(thread).getByRole("button", { name: "Ask agent" })
        )
        await waitFor(() =>
            expect(f.find("POST", "/api/tasks/12/comments")).toHaveLength(2)
        )
        expect(f.find("POST", "/api/tasks/12/comments")[1].body).toEqual({
            body: "and staging?",
            intent: "ask",
            parent_id: "c1",
        })
        await waitFor(() =>
            expect(within(thread).getByLabelText("Reply")).toHaveValue("")
        )
        // on a note thread "Ask agent" asks
        const note = document.querySelector('[data-thread-id="c3"]')
        fireEvent.change(within(note).getByLabelText("Reply"), {
            target: { value: "still valid?" },
        })
        fireEvent.click(within(note).getByRole("button", { name: "Ask agent" }))
        await waitFor(() =>
            expect(f.find("POST", "/api/tasks/12/comments")).toHaveLength(3)
        )
        expect(f.find("POST", "/api/tasks/12/comments")[2].body.intent).toBe(
            "ask"
        )
        fireEvent.click(within(thread).getByRole("button", { name: "Resolve" }))
        await waitFor(() =>
            expect(
                f.find("PATCH", "/api/tasks/12/comments/c1")[0].body
            ).toEqual({ status: "resolved" })
        )
        await screen.findByRole("button", { name: /Resolved · 2/ })
        fireEvent.click(screen.getByRole("button", { name: /Resolved · 2/ }))
        const resolved = document.querySelector('[data-thread-id="c4"]')
        fireEvent.click(
            within(resolved).getByRole("button", { name: "Reopen" })
        )
        expect(await screen.findByText("cannot reopen")).toBeInTheDocument()
    })

    it("runs Asana, re-enrich and close-out jobs", async () => {
        const job = (type) =>
            reply(202, { job: { id: `j-${type}`, type, status: "queued" } })
        const f = await setup({
            "POST /api/tasks/12/asana": job("asana_create"),
            "POST /api/tasks/12/enrich": job("enrich"),
            "POST /api/tasks/12/close-out": reply(500, {
                error: "x",
                message: "close-out failed",
            }),
        })
        fireEvent.click(screen.getByRole("button", { name: "Create in Asana" }))
        expect(
            await screen.findByText("Creating the Asana task…")
        ).toBeInTheDocument()
        expect(screen.getByText("Creating Asana task")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Re-enrich" }))
        expect(await screen.findByText("Re-enriching…")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Close out" }))
        expect(f.find("POST", "/api/tasks/12/close-out")).toHaveLength(0)
        const dlg = screen.getByRole("alertdialog", { name: "Close out T-12?" })
        fireEvent.click(within(dlg).getByRole("button", { name: "Close out" }))
        expect(await screen.findByText("close-out failed")).toBeInTheDocument()
    })

    it("snoozes from the header", async () => {
        const f = await setup({
            "PATCH /api/tasks/12": ({ body }) =>
                body.snooze === "someday maybe"
                    ? reply(400, {
                          error: "validation",
                          message: "could not parse snooze",
                      })
                    : {
                          task: sampleTask({
                              status: "waiting",
                              snooze_until: body.snooze
                                  ? "2026-11-13T14:00:00Z"
                                  : "2026-11-09T09:00:00Z",
                          }),
                          revision: "t3",
                      },
        })
        const head = document.querySelector(".task-head")
        fireEvent.click(within(head).getByRole("button", { name: /Snooze/ }))
        fireEvent.click(
            within(head).getByRole("menuitem", { name: "Next week" })
        )
        expect(await screen.findByText(/^Snoozed until/)).toBeInTheDocument()
        expect(f.find("PATCH", "/api/tasks/12")[0].body.patch.status).toBe(
            "waiting"
        )
        expect(await screen.findByText("wakes")).toBeInTheDocument()
        fireEvent.click(within(head).getByRole("button", { name: /Snooze/ }))
        fireEvent.change(within(head).getByLabelText("Custom snooze"), {
            target: { value: "friday 2pm" },
        })
        fireEvent.click(within(head).getByRole("button", { name: "Set" }))
        await waitFor(() =>
            expect(f.find("PATCH", "/api/tasks/12")).toHaveLength(2)
        )
        expect(f.find("PATCH", "/api/tasks/12")[1].body).toEqual({
            snooze: "friday 2pm",
        })
        expect(f.find("POST", "/api/tasks/12/schedules")).toHaveLength(0)
        await waitFor(() =>
            expect(screen.getAllByText(/^Snoozed until/)).toHaveLength(2)
        )
        // unparseable text shows the server's message
        fireEvent.click(within(head).getByRole("button", { name: /Snooze/ }))
        fireEvent.change(within(head).getByLabelText("Custom snooze"), {
            target: { value: "someday maybe" },
        })
        fireEvent.click(within(head).getByRole("button", { name: "Set" }))
        expect(await within(head).findByRole("alert")).toHaveTextContent(
            "could not parse snooze"
        )
    })

    it("snooze without a returned time still confirms", async () => {
        await setup({ "PATCH /api/tasks/12": { revision: "t4" } })
        const head = document.querySelector(".task-head")
        fireEvent.click(within(head).getByRole("button", { name: /Snooze/ }))
        fireEvent.change(within(head).getByLabelText("Custom snooze"), {
            target: { value: "later" },
        })
        fireEvent.click(within(head).getByRole("button", { name: "Set" }))
        expect(await screen.findByText("Snoozed")).toBeInTheDocument()
    })

    it("history drawer lists commits and shows a colored diff", async () => {
        const f = await setup({
            "GET /api/tasks/12/history": {
                commits: [
                    {
                        sha: "abcdef123456",
                        at: "2026-11-07T09:00:00Z",
                        actor: "center",
                        message: "T-0012: enrich",
                    },
                    {
                        sha: "999",
                        at: "2026-11-07T08:00:00Z",
                        actor: "me",
                        message: "T-0012: created",
                    },
                ],
            },
            "GET /api/tasks/12/history/abcdef123456": {
                diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old line\n+new line\n context\n",
            },
            "GET /api/tasks/12/history/999": reply(500, {
                error: "x",
                message: "git failed",
            }),
        })
        fireEvent.click(screen.getByRole("button", { name: "History" }))
        const drawer = await screen.findByRole("dialog", {
            name: "Revision history",
        })
        fireEvent.click(await within(drawer).findByText("T-0012: enrich"))
        expect(await within(drawer).findByText("+new line")).toHaveClass(
            "d-add"
        )
        expect(within(drawer).getByText("-old line")).toHaveClass("d-del")
        expect(within(drawer).getByText("@@ -1 +1 @@")).toHaveClass("d-hunk")
        expect(within(drawer).getByText("+++ b/x")).toHaveClass("d-file")
        expect(within(drawer).getByText("diff --git a/x b/x")).toHaveClass(
            "d-meta"
        )
        fireEvent.click(
            within(drawer).getByRole("button", { name: "← All revisions" })
        )
        fireEvent.click(within(drawer).getByText("T-0012: created"))
        expect(
            await within(drawer).findByText("git failed")
        ).toBeInTheDocument()
        expect(f.find("GET", "/api/tasks/12/history")).toHaveLength(1)
        fireEvent.keyDown(document, { key: "Escape" })
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    })

    it("history drawer: empty, error and close button", async () => {
        let n = 0
        await setup({
            "GET /api/tasks/12/history": () =>
                n++ === 0
                    ? { commits: [] }
                    : reply(500, { error: "x", message: "no git" }),
        })
        fireEvent.click(screen.getByRole("button", { name: "History" }))
        expect(await screen.findByText(/No commits yet/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Close" }))
        fireEvent.click(screen.getByRole("button", { name: "History" }))
        expect(await screen.findByText("no git")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Close history" }))
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    })

    it("schedules: add with a preset and free text, cancel", async () => {
        const f = await setup({
            "POST /api/tasks/12/schedules": ({ body }) =>
                body.when === "boom"
                    ? reply(400, {
                          error: "validation",
                          message: "can't parse when",
                      })
                    : reply(201, {
                          schedule: {
                              id: 20,
                              fire_at: "2026-11-07T14:00:00Z",
                              action: "surface",
                              status: "pending",
                              note: body.note || null,
                          },
                      }),
            "DELETE /api/schedules/3": { ok: true },
        })
        fireEvent.click(screen.getByRole("tab", { name: "Follow-ups" }))
        expect(screen.getByText("check PR")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "+ 2 hours" }))
        await waitFor(() =>
            expect(f.find("POST", "/api/tasks/12/schedules")).toHaveLength(1)
        )
        expect(f.find("POST", "/api/tasks/12/schedules")[0].body).toEqual({
            action: "surface",
            when: "in 2h",
        })
        fireEvent.change(screen.getByLabelText("Schedule when"), {
            target: { value: "friday 3pm" },
        })
        const note = screen.getByLabelText("Schedule note")
        fireEvent.change(note, { target: { value: "ping Ron" } })
        // Cmd+Enter in the note adds it; a second press while pending is ignored
        fireEvent.keyDown(note, { key: "Enter", metaKey: true })
        fireEvent.keyDown(note, { key: "Enter", metaKey: true })
        await waitFor(() =>
            expect(f.find("POST", "/api/tasks/12/schedules")).toHaveLength(2)
        )
        expect(f.find("POST", "/api/tasks/12/schedules")[1].body).toEqual({
            action: "surface",
            when: "friday 3pm",
            note: "ping Ron",
        })
        fireEvent.change(screen.getByLabelText("Schedule when"), {
            target: { value: "boom" },
        })
        fireEvent.click(screen.getByRole("button", { name: "Add follow-up" }))
        expect(await screen.findByText("can't parse when")).toBeInTheDocument()
        const sched = screen.getByText("check PR").closest("li")
        fireEvent.click(
            within(sched).getByRole("button", { name: "Cancel schedule" })
        )
        await waitFor(() =>
            expect(within(sched).getByText("cancelled")).toBeInTheDocument()
        )
    })

    it("shows activity and links tabs", async () => {
        await setup()
        fireEvent.click(screen.getByRole("tab", { name: "Activity" }))
        expect(screen.getByText("updated title, area")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("tab", { name: "Links" }))
        // the tab and the doc's Links section list the same links, the
        // capture source (Slack thread) first
        const places = [
            within(screen.getByRole("tabpanel")),
            within(screen.getByRole("region", { name: "Artifact" })),
        ]
        for (const where of places) {
            expect(where.getByText("PR #1").closest("a")).toHaveAttribute(
                "href",
                "https://github.com/x/y/pull/1"
            )
            expect(
                where.getByText("Slack thread").closest("a")
            ).toHaveAttribute("href", "https://slack.example/x")
        }
    })

    it("opens the comments sheet from the dock and closes it", async () => {
        await setup()
        fireEvent.click(screen.getByRole("button", { name: /Open comments/ }))
        expect(document.querySelector(".side")).toHaveClass("is-open")
        fireEvent.click(
            screen.getAllByRole("button", { name: "Close panel" })[0]
        )
        expect(document.querySelector(".side")).not.toHaveClass("is-open")
        fireEvent.click(screen.getByRole("button", { name: /Open comments/ }))
        fireEvent.click(
            screen.getAllByRole("button", { name: "Close panel" })[1]
        )
        expect(document.querySelector(".side")).not.toHaveClass("is-open")
    })

    it("applies live updates", async () => {
        await setup()
        act(() =>
            emit(stream, "comment.added", 12, {
                comment: {
                    id: "c20",
                    parent_id: null,
                    anchor: null,
                    body: "from agent",
                    intent: "note",
                    author: "agent:t12",
                    at: "2026-11-07T10:00:00Z",
                },
            })
        )
        expect(screen.getByText("from agent")).toBeInTheDocument()
        expect(screen.getByText("t12")).toBeInTheDocument()
    })

    it("viewer mode is read-only", async () => {
        mockFetch({
            "GET /api/tasks/12": {
                task: {
                    ...sampleTask({
                        asana: { url: "https://app.asana.com/0/1/2" },
                    }),
                    links: [
                        {
                            type: "pr",
                            url: "https://github.com/x/y/pull/1",
                            label: "PR #1",
                        },
                    ],
                },
                artifact: { content: ARTIFACT },
            },
        })
        renderWithApp(<TaskPage id={12} />, { role: "viewer" })
        await screen.findByRole("heading", { name: "Fix lambda timeout" })
        expect(screen.queryByLabelText("Status")).not.toBeInTheDocument()
        expect(
            screen.queryByRole("button", { name: "Edit" })
        ).not.toBeInTheDocument()
        expect(
            screen.queryByLabelText("Message the center agent")
        ).not.toBeInTheDocument()
        expect(
            screen.queryByRole("tab", { name: /Comments/ })
        ).not.toBeInTheDocument()
        expect(
            screen.queryByRole("button", { name: "History" })
        ).not.toBeInTheDocument()
        expect(screen.queryByText("Slack ↗")).not.toBeInTheDocument()
        expect(screen.getByText("Asana ↗")).toHaveAttribute(
            "href",
            "https://app.asana.com/0/1/2"
        )
        expect(screen.getByText("PR #1")).toBeInTheDocument()
        selectText(article(), "Raise memory")
        fireEvent.mouseUp(article())
        expect(
            screen.queryByRole("toolbar", { name: "Selection actions" })
        ).not.toBeInTheDocument()
    })

    it("shows a notice when the task stops being shared", async () => {
        mockFetch({
            "GET /api/tasks/12": {
                task: sampleTask(),
                artifact: { content: ARTIFACT },
            },
        })
        renderWithApp(<TaskPage id={12} />, { role: "viewer" })
        await screen.findByRole("heading", { name: "Fix lambda timeout" })
        act(() => emit(stream, "task.hidden", 12, { task_id: 12 }))
        expect(
            screen.getByText("This task is no longer shared")
        ).toBeInTheDocument()
        expect(article()).toBeNull()
        expect(screen.queryByText("Raise memory")).not.toBeInTheDocument()
        expect(
            screen.getByRole("link", { name: "Back to board" })
        ).toBeInTheDocument()
    })

    it("shows the task again when it is re-shared (no blank page)", async () => {
        let n = 0
        mockFetch({
            "GET /api/tasks/12": () =>
                n++ === 0
                    ? taskResponse()
                    : taskResponse({
                          task: sampleTask({ title: "Shared again" }),
                      }),
        })
        renderWithApp(<TaskPage id={12} />, { role: "viewer" })
        await screen.findByRole("heading", { name: "Fix lambda timeout" })
        act(() => emit(stream, "task.hidden", 12, { task_id: 12 }))
        expect(
            screen.getByText("This task is no longer shared")
        ).toBeInTheDocument()
        act(() =>
            emit(stream, "task.updated", 12, {
                task: sampleTask(),
                changed: ["visibility"],
            })
        )
        // still the notice until the reload brings the data back
        expect(
            screen.getByText("This task is no longer shared")
        ).toBeInTheDocument()
        expect(
            await screen.findByRole("heading", { name: "Shared again" })
        ).toBeInTheDocument()
        act(() => emit(stream, "task.hidden", 12, { task_id: 12 }))
        act(() => emit(stream, "task.created", 12, { task: sampleTask() }))
        expect(
            await screen.findByRole("heading", { name: "Shared again" })
        ).toBeInTheDocument()
    })

    it("shows not-found and retryable errors", async () => {
        mockFetch({ "GET /api/tasks/12": reply(404, { error: "not_found" }) })
        const { unmount } = renderWithApp(<TaskPage id={12} />)
        expect(await screen.findByText("T-12 not found")).toBeInTheDocument()
        unmount()
        let n = 0
        mockFetch({
            "GET /api/tasks/12": () =>
                n++ === 0
                    ? reply(500, { error: "x", message: "store down" })
                    : taskResponse(),
        })
        renderWithApp(<TaskPage id={12} />)
        expect(await screen.findByText("store down")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Retry" }))
        expect(
            await screen.findByRole("heading", { name: "Fix lambda timeout" })
        ).toBeInTheDocument()
    })

    it("shows facts for waiting tasks with due dates and errors", async () => {
        mockFetch({
            "GET /api/tasks/12": taskResponse({
                task: sampleTask({
                    status: "waiting",
                    due_at: "2026-11-09T09:00:00Z",
                    snooze_until: "2026-11-09T09:00:00Z",
                    branch: "t12-fix",
                    flags: {
                        enriching: true,
                        now: true,
                        now_reason: "Reminder",
                        error: "enrich failed",
                    },
                }),
            }),
        })
        renderWithApp(<TaskPage id={12} />)
        await screen.findByRole("heading", { name: "Fix lambda timeout" })
        expect(screen.getByText("enrich failed")).toBeInTheDocument()
        expect(screen.getByText("Reminder")).toBeInTheDocument()
        expect(screen.getByText("t12-fix")).toBeInTheDocument()
        expect(screen.getByText("wakes")).toBeInTheDocument()
        expect(screen.getByText("due")).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "Re-enrich" })).toBeDisabled()
    })
})

describe("Task page: worker flow (phase 2)", () => {
    const PR = "https://github.com/acme/aws-lambda/pull/812"

    function workerResponse(over = {}, taskOver = {}) {
        return taskResponse({
            task: sampleTask({
                status: "pr_feedback",
                slug: "k7q2",
                worker_kind: "claude",
                deliverables: [
                    {
                        repo: "aws-lambda",
                        branch: "t12-fix",
                        role: "work",
                        disposition: "pr",
                        pr: PR,
                    },
                    {
                        repo: "web-app",
                        branch: "t12-fix",
                        role: "work",
                        disposition: "pending",
                        pr: null,
                    },
                ],
                ...taskOver,
            }),
            agent: {
                state: "idle",
                kind: "claude",
                name: "t12-fix",
                session_id: "s1",
                pane_id: "p1",
                outbox: 1,
            },
            outbox: [{ id: 1, text: "fix it", reason: "pr_feedback" }],
            prs: [{ repo: "aws-lambda", number: 812, url: PR, state: "open" }],
            pr_candidates: [
                {
                    repo: "web-app",
                    url: "https://gh/pull/5",
                    reason: "no marker",
                },
            ],
            reviews: [
                {
                    folder: "aws-lambda--t12-fix--k7q2",
                    status: "GOOD_TO_GO",
                    dashboardUrl: "http://127.0.0.1:7777/",
                },
            ],
            feedback: [
                {
                    id: "gh-rc-1",
                    pr: PR,
                    round: 1,
                    kind: "review_comment",
                    author: "ron",
                    url: "https://gh/c1",
                    status: "open",
                    at: "2026-11-07T09:00:00Z",
                },
                {
                    id: "gh-ic-2",
                    pr: PR,
                    round: 1,
                    kind: "issue_comment",
                    author: "bot[bot]",
                    url: "https://gh/c2",
                    status: "no_action",
                    at: "2026-11-07T09:01:00Z",
                },
            ],
            ...over,
        })
    }

    async function setupWorker(routes = {}, response = workerResponse()) {
        const f = mockFetch({ "GET /api/tasks/12": response, ...routes })
        renderWithApp(<TaskPage id={12} />, { features: ALL_FEATURES })
        await screen.findByRole("heading", { name: "Fix lambda timeout" })
        return f
    }

    const tab = (name) =>
        screen.getByRole("tab", { name: new RegExp(`^${name}`) })

    it("the document's PR feedback section lists the feedback", async () => {
        await setupWorker()
        const doc = article()
        expect(doc).toHaveTextContent("Round 1 · 2 items · 1 open, 1 no action")
        expect(doc).toHaveTextContent("open · inline · @ron")
        expect(doc).toHaveTextContent("1 reply that needed no action")
        expect(doc.querySelector('a[href="https://gh/c1"]')).not.toBeNull()
    })

    it("shows the worker tabs and panels", async () => {
        await setupWorker()
        expect(
            screen
                .getAllByRole("tab")
                .map((t) => t.textContent.replace(/\d+$/, ""))
        ).toEqual([
            "Links",
            "Deliverables",
            "Comments",
            "Reviews",
            "Agent",
            "Feedback",
            "Activity",
            "Follow-ups",
        ])
        expect(tab("Feedback")).toHaveTextContent("Feedback1")
        // the Deliverables tab counts what blocks Done
        expect(tab("Deliverables")).toHaveTextContent(/^Deliverables\d+$/)
        fireEvent.click(tab("Agent"))
        expect(screen.getByText("s1")).toBeInTheDocument()
        expect(
            screen.getByText("fix it", { selector: "summary" })
        ).toBeInTheDocument()
        fireEvent.click(tab("Reviews"))
        expect(screen.getByText("GOOD_TO_GO")).toBeInTheDocument()
        // header: agent fact + actions
        expect(
            screen.getAllByLabelText("Agent t12-fix: idle").length
        ).toBeGreaterThan(0)
        expect(
            screen.getByRole("button", { name: "Address feedback" })
        ).toBeInTheDocument()
    })

    it("hides worker tabs and actions without server features", async () => {
        mockFetch({ "GET /api/tasks/12": workerResponse() })
        renderWithApp(<TaskPage id={12} />)
        await screen.findByRole("heading", { name: "Fix lambda timeout" })
        expect(screen.getAllByRole("tab")).toHaveLength(4)
        expect(
            screen.queryByRole("button", { name: "Address feedback" })
        ).toBeNull()
        expect(
            screen.queryByRole("button", { name: "Check PRs now" })
        ).toBeNull()
    })

    it("falls back to Comments when the current tab disappears", async () => {
        const f = await setupWorker()
        fireEvent.click(tab("Reviews"))
        f.mockClear()
        mockFetch({
            "GET /api/tasks/12": workerResponse({ reviews: [] }),
        })
        act(() => emit(stream, "pr.updated", 12, {}))
        await waitFor(() =>
            expect(screen.queryByRole("tab", { name: "Reviews" })).toBeNull()
        )
        expect(tab("Comments")).toHaveAttribute("aria-selected", "true")
    })

    it("header actions post to the worker routes and toast the delivery", async () => {
        const f = await setupWorker({
            "POST /api/tasks/12/actions/address-feedback": {
                ok: true,
                delivery: { status: "queued" },
            },
            "POST /api/tasks/12/actions/focus": reply(409, {
                error: "agent_not_found",
                message: "no agent",
            }),
            "POST /api/tasks/12/prs/poll": { claimed: 0 },
        })
        fireEvent.click(
            screen.getByRole("button", { name: "Address feedback" })
        )
        expect(
            await screen.findByText("Queued until the agent is idle")
        ).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Open in herdr" }))
        expect(await screen.findByText("no agent")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Check PRs now" }))
        expect(await screen.findByText("PRs checked")).toBeInTheDocument()
        expect(f.find("POST", "/api/tasks/12/prs/poll")).toHaveLength(1)
    })

    it("shows failed deliveries and poll errors as errors", async () => {
        await setupWorker({
            "POST /api/tasks/12/actions/address-feedback": {
                ok: false,
                delivery: { status: "failed", error: "agent_blocked" },
            },
            "POST /api/tasks/12/prs/poll": reply(500, { message: "gh down" }),
        })
        fireEvent.click(
            screen.getByRole("button", { name: "Address feedback" })
        )
        const msg = await screen.findByText(
            "Not delivered to the agent: agent_blocked"
        )
        expect(msg.closest(".toast")).toHaveClass("toast-error")
        fireEvent.click(screen.getByRole("button", { name: "Check PRs now" }))
        expect(await screen.findByText("gh down")).toBeInTheDocument()
    })

    it("a 200 poll summary with errors is shown as an error, not success", async () => {
        await setupWorker({
            "POST /api/tasks/12/prs/poll": {
                claimed: [],
                errors: ["https://github.com/o/r/pull/1: gh auth failed"],
            },
        })
        fireEvent.click(screen.getByRole("button", { name: "Check PRs now" }))
        const msg = await screen.findByText(
            "PR check failed: https://github.com/o/r/pull/1: gh auth failed"
        )
        expect(msg.closest(".toast")).toHaveClass("toast-error")
        expect(screen.queryByText("PRs checked")).not.toBeInTheDocument()
    })

    it("starts an agent and shows branch conflicts with the suggestion", async () => {
        const res = workerResponse(
            { agent: null, outbox: [] },
            { status: "ready", repos: [{ name: "aws-lambda", role: "main" }] }
        )
        let n = 0
        const f = await setupWorker(
            {
                "POST /api/tasks/12/start": () =>
                    ++n === 1
                        ? reply(409, {
                              error: "branch_conflict",
                              message: "Branch t12-fix is taken.",
                              details: { suggestion: "t12-fix-2" },
                          })
                        : reply(202, { session: { id: 1 } }),
                "GET /api/settings": { settings: {} },
            },
            res
        )
        const start = screen.getByRole("button", { name: "Start with Claude" })
        fireEvent.click(start)
        expect(
            await screen.findByText(
                "Branch t12-fix is taken. Suggested branch: t12-fix-2"
            )
        ).toBeInTheDocument()
        await waitFor(() => expect(start).not.toBeDisabled())
        fireEvent.click(start)
        expect(await screen.findByText("Starting Claude…")).toBeInTheDocument()
        expect(f.find("POST", "/api/tasks/12/start")[1].body).toEqual({
            kind: "claude",
        })
    })

    it("Start on a task without repos assigns the picked repo first", async () => {
        const res = workerResponse(
            { agent: null, outbox: [] },
            { status: "ready", repos: [] }
        )
        const f = await setupWorker(
            {
                "GET /api/repos": { repos: [{ name: "aws-batch" }] },
                "PATCH /api/tasks/12": {
                    task: sampleTask({
                        status: "ready",
                        repos: [{ name: "aws-batch", role: "main" }],
                    }),
                },
                "POST /api/tasks/12/start": reply(202, { session: { id: 1 } }),
                "GET /api/settings": { settings: {} },
            },
            res
        )
        const pick = screen.getByLabelText("Repo for the agent")
        await waitFor(() => expect(pick).not.toBeDisabled())
        fireEvent.change(pick, { target: { value: "aws-batch" } })
        fireEvent.click(
            screen.getByRole("button", { name: "Start with Claude" })
        )
        expect(await screen.findByText("Starting Claude…")).toBeInTheDocument()
        expect(f.find("PATCH", "/api/tasks/12")[0].body.patch).toEqual({
            repos: [{ name: "aws-batch", role: "main" }],
        })
        expect(f.find("POST", "/api/tasks/12/start")[0].body).toEqual({
            kind: "claude",
        })
    })

    it("a start that fails after the repo was saved keeps the repo; the retry only starts", async () => {
        const res = workerResponse(
            { agent: null, outbox: [] },
            { status: "ready", repos: [] }
        )
        let n = 0
        const f = await setupWorker(
            {
                "GET /api/repos": { repos: [{ name: "aws-batch" }] },
                "PATCH /api/tasks/12": {
                    task: sampleTask({
                        status: "ready",
                        repos: [{ name: "aws-batch", role: "main" }],
                    }),
                    revision: "r2",
                },
                "POST /api/tasks/12/start": () =>
                    ++n === 1
                        ? reply(409, {
                              error: "branch_conflict",
                              message: "Branch t12-fix is taken.",
                          })
                        : reply(202, { session: { id: 1 } }),
                "GET /api/settings": { settings: {} },
            },
            res
        )
        const pick = screen.getByLabelText("Repo for the agent")
        await waitFor(() => expect(pick).not.toBeDisabled())
        fireEvent.change(pick, { target: { value: "aws-batch" } })
        fireEvent.click(
            screen.getByRole("button", { name: "Start with Claude" })
        )
        expect(
            await screen.findByText("Branch t12-fix is taken.")
        ).toBeInTheDocument()
        // the saved repo is shown and Start no longer asks for one
        await waitFor(() =>
            expect(screen.queryByLabelText("Repo for the agent")).toBeNull()
        )
        const start = screen.getByRole("button", { name: "Start with Claude" })
        await waitFor(() => expect(start).not.toBeDisabled())
        fireEvent.click(start)
        expect(await screen.findByText("Starting Claude…")).toBeInTheDocument()
        expect(f.find("PATCH", "/api/tasks/12")).toHaveLength(1)
        expect(f.find("POST", "/api/tasks/12/start")).toHaveLength(2)
    })

    it("deliverables: no change and claims", async () => {
        let claims = 0
        const f = await setupWorker({
            "POST /api/tasks/12/deliverables/web-app": {
                task: sampleTask({ status: "pr_feedback" }),
            },
            "POST /api/tasks/12/prs/claim": () =>
                ++claims === 1
                    ? { ok: false, reason: "PR predates the deliverable" }
                    : claims === 2
                      ? reply(500, { message: "claim broke" })
                      : { ok: true },
        })
        fireEvent.click(tab("Deliverables"))
        fireEvent.click(
            screen.getByRole("button", { name: "Mark web-app as no change" })
        )
        expect(
            await screen.findByText("web-app: no change")
        ).toBeInTheDocument()
        expect(
            f.find("POST", "/api/tasks/12/deliverables/web-app")[0].body
        ).toEqual({ disposition: "no_change" })

        const claim = () =>
            fireEvent.click(
                screen.getByRole("button", { name: "Claim https://gh/pull/5" })
            )
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Claim https://gh/pull/5" })
            ).not.toBeDisabled()
        )
        claim()
        expect(
            await screen.findByText("Not claimed: PR predates the deliverable")
        ).toBeInTheDocument()
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Claim https://gh/pull/5" })
            ).not.toBeDisabled()
        )
        claim()
        expect(await screen.findByText("claim broke")).toBeInTheDocument()
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Claim https://gh/pull/5" })
            ).not.toBeDisabled()
        )
        claim()
        expect(await screen.findByText("PR claimed")).toBeInTheDocument()
        expect(f.find("POST", "/api/tasks/12/prs/claim")[0].body).toEqual({
            url: "https://gh/pull/5",
        })
    })

    it("deliverables: no change errors and claims without a reason", async () => {
        await setupWorker({
            "POST /api/tasks/12/deliverables/web-app": reply(409, {
                message: "not pending",
            }),
            "POST /api/tasks/12/prs/claim": { ok: false },
        })
        fireEvent.click(tab("Deliverables"))
        fireEvent.click(
            screen.getByRole("button", { name: "Mark web-app as no change" })
        )
        expect(await screen.findByText("not pending")).toBeInTheDocument()
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Claim https://gh/pull/5" })
            ).not.toBeDisabled()
        )
        fireEvent.click(
            screen.getByRole("button", { name: "Claim https://gh/pull/5" })
        )
        expect(
            await screen.findByText("Not claimed: rejected")
        ).toBeInTheDocument()
    })

    it("feedback: reopens no_action items", async () => {
        let n = 0
        const f = await setupWorker({
            "PATCH /api/tasks/12/feedback/gh-ic-2": () =>
                ++n === 1
                    ? reply(409, { message: "not no_action" })
                    : { ok: true },
        })
        fireEvent.click(tab("Feedback"))
        const reopen = screen.getByRole("button", {
            name: "Reopen feedback gh-ic-2",
        })
        fireEvent.click(reopen)
        expect(await screen.findByText("not no_action")).toBeInTheDocument()
        await waitFor(() => expect(reopen).not.toBeDisabled())
        fireEvent.click(reopen)
        expect(await screen.findByText("Feedback reopened")).toBeInTheDocument()
        expect(
            f.find("PATCH", "/api/tasks/12/feedback/gh-ic-2")[0].body
        ).toEqual({ status: "open" })
    })

    it("refreshes on agent.updated and updates the state at once", async () => {
        const f = await setupWorker()
        f.mockClear()
        act(() => emit(stream, "agent.updated", 12, { state: "working" }))
        expect(
            screen.getAllByLabelText("Agent t12-fix: working").length
        ).toBeGreaterThan(0)
        await waitFor(() =>
            expect(f.find("GET", "/api/tasks/12").length).toBeGreaterThan(1)
        )
    })

    it("selection: Send to agent posts actions/send with the quote", async () => {
        let n = 0
        const f = await setupWorker({
            "POST /api/tasks/12/actions/send": () =>
                ++n === 1
                    ? reply(503, { message: "herdr down" })
                    : n === 2
                      ? { ok: true, delivery: { status: "failed", error: "x" } }
                      : { ok: true, delivery: { status: "sent" } },
        })
        selectText(article(), "upload lambda")
        fireEvent.mouseUp(article())
        const toolbar = await screen.findByRole("toolbar", {
            name: "Selection actions",
        })
        fireEvent.click(
            within(toolbar).getByRole("button", { name: "Send to agent" })
        )
        const box = screen.getByLabelText("Send to agent")
        fireEvent.change(box, { target: { value: "check this" } })
        const send = () =>
            fireEvent.click(
                within(
                    screen.getByRole("form", {
                        name: "Send to agent on selection",
                    })
                ).getByRole("button", { name: "Send" })
            )
        send()
        expect(await screen.findByText("herdr down")).toBeInTheDocument()
        expect(screen.getByLabelText("Send to agent").value).toBe("check this")
        await waitFor(() => expect(n).toBe(1))
        send()
        expect(
            await screen.findByText("Not delivered to the agent: x")
        ).toBeInTheDocument()
        expect(screen.getByLabelText("Send to agent").value).toBe("check this")
        send()
        expect(await screen.findByText("Sent to the agent")).toBeInTheDocument()
        await waitFor(() =>
            expect(
                screen.queryByRole("form", {
                    name: "Send to agent on selection",
                })
            ).toBeNull()
        )
        expect(f.find("POST", "/api/tasks/12/actions/send")[2].body).toEqual({
            text: "check this",
            quote: "upload lambda",
        })
        expect(f.find("POST", "/api/tasks/12/comments")).toHaveLength(0)
    })

    it("selection: no Send to agent without a live agent", async () => {
        await setupWorker({}, workerResponse({ agent: { state: "gone" } }))
        selectText(article(), "upload lambda")
        fireEvent.mouseUp(article())
        const toolbar = await screen.findByRole("toolbar", {
            name: "Selection actions",
        })
        expect(
            within(toolbar).queryByRole("button", { name: "Send to agent" })
        ).toBeNull()
    })

    it("selection: falls back to a comment when the agent goes away mid-draft", async () => {
        const f = await setupWorker({
            "POST /api/tasks/12/comments": {
                comment: {
                    id: "c10",
                    parent_id: null,
                    anchor: null,
                    body: "later",
                    intent: "note",
                    author: "me",
                    at: "2026-11-07T10:00:00Z",
                },
            },
        })
        selectText(article(), "upload lambda")
        fireEvent.mouseUp(article())
        fireEvent.click(
            within(
                await screen.findByRole("toolbar", {
                    name: "Selection actions",
                })
            ).getByRole("button", { name: "Send to agent" })
        )
        act(() => emit(stream, "agent.updated", 12, { state: "gone" }))
        const form = await screen.findByRole("form", {
            name: "Comment on selection",
        })
        fireEvent.change(within(form).getByLabelText("Comment"), {
            target: { value: "later" },
        })
        fireEvent.click(within(form).getByRole("button", { name: "Send" }))
        await waitFor(() =>
            expect(f.find("POST", "/api/tasks/12/comments")).toHaveLength(1)
        )
        expect(f.find("POST", "/api/tasks/12/comments")[0].body.intent).toBe(
            "note"
        )
    })
})

describe("Task page: Slack thread notice", () => {
    const THREAD = "https://acme.slack.com/archives/C1/p1"
    const notice = (over) => ({
        thread: THREAD,
        gid: "9",
        attempts: 1,
        brain_job: "j_1",
        answer: "I couldn't post: the tool adds a mention.",
        error: null,
        at: "2026-11-09T10:00:00Z",
        status: "not_posted",
        ...over,
    })
    const response = (n, flags = {}) => {
        const base = taskResponse()
        return {
            ...base,
            task: {
                ...base.task,
                flags: { ...base.task.flags, ...flags },
            },
            slack_notice: n,
        }
    }

    it("warns in the header, hides the duplicate Now line and posts again", async () => {
        const f = mockFetch({
            "GET /api/tasks/12": response(notice(), {
                now: true,
                now_reason: "Slack thread not told about the Asana task",
            }),
            "POST /api/tasks/12/slack-notice": {
                result: { started: true, brain_job: "j_2" },
                slack_notice: notice({
                    status: "pending",
                    brain_job: "j_2",
                    attempts: 2,
                }),
            },
        })
        renderWithApp(<TaskPage id={12} />)
        const alert = await screen.findByRole("alert")
        expect(alert).toHaveTextContent(
            "Brain did not post the Asana link to the Slack thread."
        )
        expect(alert).toHaveTextContent("Brain: I couldn't post")
        expect(document.querySelector(".task-now")).toBeNull()
        fireEvent.click(screen.getByRole("button", { name: "Try again" }))
        expect(
            await screen.findByText("Asked Brain to post in the Slack thread")
        ).toBeInTheDocument()
        expect(f.find("POST", "/api/tasks/12/slack-notice")).toHaveLength(1)
    })

    it("check now, skipped and failed posts are reported", async () => {
        let current = notice({ status: "pending" })
        let posts = 0
        const f = mockFetch({
            "GET /api/tasks/12": () => response(current),
            "POST /api/tasks/12/slack-notice/check": () => {
                current = notice({ status: "missing" })
                return { slack_notice: current }
            },
            "POST /api/tasks/12/slack-notice": () => {
                posts += 1
                if (posts === 1)
                    return {
                        result: { skipped: "pending" },
                        slack_notice: null,
                    }
                if (posts === 2)
                    return { result: { started: false, error: "down" } }
                if (posts === 3) return { result: { skipped: "odd" } }
                if (posts === 4) return {}
                return reply(500, { message: "server down" })
            },
        })
        renderWithApp(<TaskPage id={12} />)
        fireEvent.click(
            await screen.findByRole("button", { name: "Check now" })
        )
        await waitFor(() =>
            expect(
                f.find("POST", "/api/tasks/12/slack-notice/check")
            ).toHaveLength(1)
        )
        const post = await screen.findByRole("button", {
            name: "Post to Slack",
        })
        const click = async (text) => {
            await waitFor(() => expect(post).not.toBeDisabled())
            fireEvent.click(post)
            if (text) expect(await screen.findByText(text)).toBeInTheDocument()
        }
        await click("Brain is still on it")
        await click("Brain: down")
        await click("odd")
        await click(null)
        await waitFor(() => expect(posts).toBe(4))
        await click("server down")
    })

    it("dismisses the warning", async () => {
        let current = notice()
        const f = mockFetch({
            "GET /api/tasks/12": () => response(current),
            "POST /api/tasks/12/slack-notice/dismiss": () => {
                current = notice({ status: "dismissed" })
                return { result: { dismissed: true }, slack_notice: current }
            },
        })
        renderWithApp(<TaskPage id={12} />)
        fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }))
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
        expect(
            f.find("POST", "/api/tasks/12/slack-notice/dismiss")
        ).toHaveLength(1)
    })

    it("no notice for viewers or tasks without one; the Now line stays", async () => {
        mockFetch({
            "GET /api/tasks/12": response(null, {
                now: true,
                now_reason: "Slack thread not told about the Asana task",
            }),
        })
        renderWithApp(<TaskPage id={12} />)
        await screen.findByRole("heading", { name: "Fix lambda timeout" })
        expect(screen.queryByRole("alert")).toBeNull()
        expect(document.querySelector(".task-now")).not.toBeNull()
    })
})

describe("Task page attachments", () => {
    const FILES = [
        {
            name: "shot.png",
            label: "Shot",
            url: "files/shot.png",
            size: 2048,
            kind: "image",
            added_by: "me",
            at: "2026-11-07T09:00:00Z",
            missing: false,
        },
        {
            name: "notes.md",
            label: "notes.md",
            url: "files/notes.md",
            size: 12,
            kind: "markdown",
            added_by: "agent:t12-x",
            at: "2026-11-07T09:00:00Z",
            missing: false,
        },
    ]
    const withFiles = () =>
        taskResponse({
            files: FILES,
            artifact: {
                content: `${ARTIFACT}\n## Attachments\n- ![Shot](files/shot.png)\n- [notes.md](files/notes.md)\n`,
                revision: "a1",
            },
        })

    it("lists files, opens the viewer from the tab and the artifact", async () => {
        const f = await setup({
            "GET /api/tasks/12": withFiles(),
            "GET /api/tasks/12/files/notes.md": () => "unused",
        })
        // the artifact embeds the image from the files route
        const img = article().querySelector('img[data-file="shot.png"]')
        expect(img.getAttribute("src")).toBe("/api/tasks/12/files/shot.png")
        fireEvent.click(img)
        let dialog = screen.getByRole("dialog", { name: "Shot" })
        expect(dialog.querySelector("img.fv-image").getAttribute("src")).toBe(
            "/api/tasks/12/files/shot.png"
        )
        fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
        expect(screen.queryByRole("dialog")).toBeNull()

        fireEvent.click(screen.getByRole("tab", { name: /Files/ }))
        expect(screen.getByText(/^2\.0 KB · /)).toBeInTheDocument()
        expect(screen.getByText(/· agent:t12-x$/)).toBeInTheDocument()
        // markdown opens rendered
        global.fetch = jest.fn(async () => ({
            ok: true,
            text: async () => "# Notes\n\n- one",
        }))
        fireEvent.click(screen.getByRole("button", { name: "notes.md" }))
        dialog = screen.getByRole("dialog", { name: "notes.md" })
        expect(
            await within(dialog).findByRole("heading", { name: "Notes" })
        ).toBeInTheDocument()
        fireEvent.keyDown(document, { key: "Escape" })
        expect(screen.queryByRole("dialog")).toBeNull()
        expect(f).toBeTruthy()
    })

    it("uploads picked, dropped and pasted files and deletes one", async () => {
        const f = await setup({
            "GET /api/tasks/12": withFiles(),
            "POST /api/tasks/12/files": { file: { name: "x" } },
            "DELETE /api/tasks/12/files/shot.png": { removed: "shot.png" },
        })
        fireEvent.click(screen.getByRole("tab", { name: /Files/ }))
        const pick = new File(["a"], "report.pdf", { type: "application/pdf" })
        fireEvent.change(screen.getByTestId("file-input"), {
            target: { files: [pick] },
        })
        await screen.findByText("Attached report.pdf")
        expect(f.find("POST", "/api/tasks/12/files")[0].url).toBe(
            "/api/tasks/12/files?name=report.pdf"
        )
        expect(f.find("POST", "/api/tasks/12/files")[0].body).toBe(pick)

        // drop anywhere on the page
        const page = document.querySelector(".page.task")
        const drop = new File(["b"], "clip.mp4", { type: "video/mp4" })
        const dataTransfer = { types: ["Files"], files: [drop] }
        fireEvent.dragOver(page, { dataTransfer })
        expect(page).toHaveClass("is-dropping")
        expect(screen.getByText("Drop to attach to T-12")).toBeInTheDocument()
        fireEvent.drop(page, { dataTransfer })
        await waitFor(() =>
            expect(f.find("POST", "/api/tasks/12/files")).toHaveLength(2)
        )
        expect(page).not.toHaveClass("is-dropping")

        // a pasted screenshot gets a dated name
        const shot = new File(["c"], "image.png", { type: "image/png" })
        const paste = new Event("paste", { bubbles: true, cancelable: true })
        paste.clipboardData = { files: [shot] }
        act(() => {
            document.body.dispatchEvent(paste)
        })
        await waitFor(() =>
            expect(f.find("POST", "/api/tasks/12/files")).toHaveLength(3)
        )
        expect(f.find("POST", "/api/tasks/12/files")[2].url).toMatch(
            /name=pasted-\d{8}-\d{6}\.png$/
        )

        // delete asks first
        const row = screen.getByText("Shot").closest("li")
        fireEvent.click(within(row).getByRole("button", { name: "Delete" }))
        fireEvent.click(
            within(screen.getByRole("alertdialog")).getByRole("button", {
                name: "Delete",
            })
        )
        await screen.findByText("Deleted Shot")
        expect(f.find("DELETE", "/api/tasks/12/files/shot.png")).toHaveLength(1)
    })

    it("a failed upload shows the error", async () => {
        await setup({
            "GET /api/tasks/12": withFiles(),
            "POST /api/tasks/12/files": reply(413, {
                error: "file_too_large",
                message: "file is larger than 250 MB",
            }),
        })
        fireEvent.click(screen.getByRole("tab", { name: /Files/ }))
        fireEvent.change(screen.getByTestId("file-input"), {
            target: { files: [new File(["a"], "big.mov")] },
        })
        expect(
            await screen.findByText("file is larger than 250 MB")
        ).toBeInTheDocument()
    })
})

describe("Task page attachments: drop zone", () => {
    it("a drop on the Files tab zone uploads once and clears the page hint", async () => {
        const f = await setup({
            "GET /api/tasks/12": taskResponse({ files: [] }),
            "POST /api/tasks/12/files": { file: { name: "x" } },
        })
        fireEvent.click(screen.getByRole("tab", { name: /Files/ }))
        const zone = document.querySelector(".files-drop")
        const page = document.querySelector(".page.task")
        const file = new File(["a"], "a.txt")
        const dataTransfer = { types: ["Files"], files: [file] }
        fireEvent.dragOver(zone, { dataTransfer })
        expect(page).toHaveClass("is-dropping")
        fireEvent.drop(zone, { dataTransfer })
        expect(page).not.toHaveClass("is-dropping")
        await screen.findByText("Attached a.txt")
        expect(f.find("POST", "/api/tasks/12/files")).toHaveLength(1)
    })
})
