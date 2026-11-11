/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react"
import { AppContext } from "../components/AppContext.jsx"
import { ToastProvider } from "../components/Toasts.jsx"
import Home, { mergeJob } from "./Home.jsx"
import { mockFetch, reply, sampleTask } from "../../test/helpers.js"
import {
    ALL_FEATURES,
    emit,
    freshStream,
    renderWithApp,
} from "../../test/render.jsx"

const board = {
    lanes: {
        now: [
            sampleTask({
                id: 1,
                title: "Talk to Ron about 123",
                kind: "reminder",
                status: "waiting",
                flags: {
                    now: true,
                    now_reason: "Reminder due",
                    enriching: false,
                },
            }),
        ],
        active: [
            sampleTask({ id: 2, title: "iOS crash on upload", area: "mobile" }),
        ],
        prs: [],
        ready: [],
        inbox: [
            sampleTask({
                id: 3,
                title: "Slack thread",
                status: "inbox",
                flags: { enriching: true },
            }),
        ],
        waiting: [
            sampleTask({
                id: 4,
                title: "Waiting on Ron",
                status: "waiting",
                snooze_until: "2026-11-09T09:00:00Z",
            }),
        ],
        done: [
            sampleTask({
                id: 5,
                title: "Shipped",
                status: "done",
                done_at: "2026-11-06T09:00:00Z",
            }),
        ],
    },
}

let stream
beforeEach(() => {
    stream = freshStream()
    window.localStorage.clear()
})

function setup(routes = {}, opts) {
    const f = mockFetch({ "GET /api/board": board, ...routes })
    renderWithApp(<Home />, opts)
    return f
}

describe("Home", () => {
    it("All: Inbox, Active and PRs in one list under lane headers, remembered", async () => {
        const lanes = {
            ...board.lanes,
            prs: [sampleTask({ id: 6, title: "Upload PR", status: "pr_open" })],
        }
        mockFetch({ "GET /api/board": { lanes } })
        const first = renderWithApp(<Home />)
        await screen.findByText("Upload PR")
        const tab = screen.getByRole("tab", { name: /All/ })
        expect(tab).toHaveTextContent("3")
        // not the default: the first lane with tasks is
        expect(tab).toHaveAttribute("aria-selected", "false")
        expect(document.getElementById("lane-all")).toBeNull()
        fireEvent.click(tab)
        const all = document.getElementById("lane-all")
        expect(all).toHaveClass("is-current")
        expect(
            within(all)
                .getAllByRole("heading", { level: 3 })
                .map((h) => h.textContent)
        ).toEqual(["Inbox1", "Active1", "PRs1"])
        const rows = [...all.querySelectorAll(".row")]
        expect(rows.map((r) => r.dataset.taskId)).toEqual(["3", "2", "6"])
        expect(rows.map((r) => r.querySelector(".lane-dot").className)).toEqual(
            [
                "lane-dot lane-dot-inbox",
                "lane-dot lane-dot-active",
                "lane-dot lane-dot-prs",
            ]
        )
        // Now rows get the dot of their own lane (a waiting reminder)
        const now = document.getElementById("lane-now")
        expect(now.querySelector(".lane-dot")).toHaveClass("lane-dot-waiting")
        expect(now.querySelector(".lane-dot")).toHaveAttribute(
            "title",
            "Waiting · Reminder"
        )
        first.unmount()

        // the pill is remembered on this device
        mockFetch({ "GET /api/board": { lanes } })
        renderWithApp(<Home />)
        await screen.findAllByText("Upload PR")
        expect(screen.getByRole("tab", { name: /All/ })).toHaveAttribute(
            "aria-selected",
            "true"
        )
    })

    it("All says so when Inbox, Active and PRs are empty; storage errors are ignored", async () => {
        jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked")
        })
        jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked")
        })
        mockFetch({
            "GET /api/board": { lanes: { done: board.lanes.done } },
        })
        renderWithApp(<Home />)
        await screen.findByText("Shipped")
        fireEvent.click(screen.getByRole("tab", { name: /All/ }))
        expect(screen.getByText("Nothing open.")).toBeInTheDocument()
        jest.restoreAllMocks()
    })

    it("renders lanes with Now first", async () => {
        setup()
        expect(
            await screen.findByText("Talk to Ron about 123")
        ).toBeInTheDocument()
        const now = screen
            .getByRole("heading", { name: /Now/ })
            .closest("section")
        expect(within(now).getByText("Reminder due")).toBeInTheDocument()
        expect(screen.getByText("iOS crash on upload")).toBeInTheDocument()
        expect(screen.getByText("1 enriching…")).toBeInTheDocument()
        expect(screen.getByText(/^wakes /)).toBeInTheDocument()
        expect(screen.getByText(/^done /)).toBeInTheDocument()
        // pills in order; Ready has no tasks, so no pill
        expect(
            screen
                .getAllByRole("tab")
                .map((t) => t.textContent.replace(/\d+$/, ""))
        ).toEqual(["All", "Inbox", "Active", "PRs", "Waiting", "Done"])
        // the first non-empty lane is open
        expect(screen.getByRole("tab", { name: /Inbox/ })).toHaveAttribute(
            "aria-selected",
            "true"
        )
        fireEvent.click(screen.getByRole("tab", { name: /Active/ }))
        expect(screen.getByRole("tab", { name: /Active/ })).toHaveAttribute(
            "aria-selected",
            "true"
        )
        expect(document.getElementById("lane-active")).toHaveClass("is-current")
        expect(document.getElementById("lane-inbox")).not.toHaveClass(
            "is-current"
        )
        // links go to the task page
        expect(
            screen.getByText("iOS crash on upload").closest("a")
        ).toHaveAttribute("href", "/t/2")
    })

    it("Enter adds a line; Cmd+Enter captures", async () => {
        const f = setup({
            "POST /api/tasks": reply(201, {
                task: sampleTask({ id: 9, title: "New" }),
                revision: "r",
            }),
        })
        await screen.findByText("Talk to Ron about 123")
        const box = screen.getByLabelText("Capture a task")
        fireEvent.change(box, {
            target: { value: "check why lambda X times out" },
        })
        // plain Enter is a newline: nothing is sent
        fireEvent.keyDown(box, { key: "Enter" })
        fireEvent.keyDown(box, { key: "Enter", shiftKey: true })
        expect(f.find("POST", "/api/tasks")).toHaveLength(0)
        fireEvent.change(box, {
            target: { value: "check why lambda X times out\nsee logs" },
        })
        fireEvent.keyDown(box, { key: "Enter", metaKey: true })
        await screen.findByText(/Captured T-9/)
        expect(f.find("POST", "/api/tasks")[0].body).toEqual({
            text: "check why lambda X times out\nsee logs",
        })
        expect(box.value).toBe("")
        await waitFor(() => expect(f.find("GET", "/api/board").length).toBe(2))
    })

    it("sends bare URLs with the url field", async () => {
        const f = setup({ "POST /api/tasks": reply(201, { task: null }) })
        await screen.findByText("Talk to Ron about 123")
        const box = screen.getByLabelText("Capture a task")
        fireEvent.change(box, {
            target: { value: "https://acme.slack.com/archives/C1/p123" },
        })
        fireEvent.click(screen.getByRole("button", { name: "Create task" }))
        await screen.findByText("Captured")
        expect(f.find("POST", "/api/tasks")[0].body).toEqual({
            text: "https://acme.slack.com/archives/C1/p123",
            url: "https://acme.slack.com/archives/C1/p123",
        })
    })

    it("'more options' opens the full form", async () => {
        const f = setup({
            "POST /api/tasks": reply(201, { task: sampleTask({ id: 10 }) }),
        })
        await screen.findByText("Talk to Ron about 123")
        const box = screen.getByLabelText("Capture a task")
        fireEvent.change(box, { target: { value: "rotate keys" } })
        fireEvent.click(screen.getByText("more options"))
        const form = box.closest("form")
        const selects = within(form).getAllByRole("combobox")
        fireEvent.change(selects[0], { target: { value: "security" } })
        fireEvent.change(selects[1], { target: { value: "agent_task" } })
        fireEvent.change(form.querySelector('input[type="datetime-local"]'), {
            target: { value: "2026-11-09T10:00" },
        })
        fireEvent.click(within(form).getByLabelText("Create in Asana"))
        fireEvent.click(
            within(form).getAllByRole("button", { name: "Create task" })[1]
        )
        await waitFor(() =>
            expect(f.find("POST", "/api/tasks")).toHaveLength(1)
        )
        expect(f.find("POST", "/api/tasks")[0].body).toEqual({
            text: "rotate keys",
            area: "security",
            kind: "agent_task",
            due_at: new Date(2026, 10, 9, 10, 0).toISOString(),
            wants_asana: true,
        })
    })

    it("toggles options and cancels the form", async () => {
        setup()
        await screen.findByText("Talk to Ron about 123")
        fireEvent.click(screen.getByText("more options"))
        expect(screen.getByText("fewer options")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
        expect(screen.queryByText("fewer options")).not.toBeInTheDocument()
    })

    it("sends '>' text to the center agent and streams the job", async () => {
        const f = setup({
            "POST /api/command": reply(202, {
                job: { id: "j1", type: "command", status: "queued" },
            }),
        })
        await screen.findByText("Talk to Ron about 123")
        const box = screen.getByLabelText("Capture a task")
        fireEvent.change(box, {
            target: { value: "> snooze everything waiting on Ron to Monday" },
        })
        expect(
            screen.getByText(/Command · the center agent/)
        ).toBeInTheDocument()
        fireEvent.keyDown(box, { key: "Enter", metaKey: true })
        await screen.findByText("snooze everything waiting on Ron to Monday")
        expect(f.find("POST", "/api/command")[0].body).toEqual({
            text: "snooze everything waiting on Ron to Monday",
        })
        act(() =>
            emit(stream, "job.updated", null, {
                job: { id: "j1", type: "command", status: "running" },
            })
        )
        act(() =>
            emit(stream, "job.delta", null, {
                job_id: "j1",
                text: "Looking at the board",
            })
        )
        expect(screen.getByText("Looking at the board")).toBeInTheDocument()
        act(() =>
            emit(stream, "job.updated", null, {
                job: {
                    id: "j1",
                    type: "command",
                    status: "done",
                    summary: "Snoozed 2 tasks",
                },
            })
        )
        expect(screen.getByText("Snoozed 2 tasks")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
        expect(screen.queryByText("Snoozed 2 tasks")).not.toBeInTheDocument()
    })

    it("command panel fetches the stored job on mount and after a reconnect", async () => {
        let stored = { id: "j3", type: "command", status: "running" }
        const f = setup({
            "POST /api/command": reply(202, {
                job: { id: "j3", type: "command", status: "queued" },
            }),
            "GET /api/jobs/j3": () => ({ job: stored }),
        })
        await screen.findByText("Talk to Ron about 123")
        const box = screen.getByLabelText("Capture a task")
        fireEvent.change(box, { target: { value: "> what is overdue?" } })
        fireEvent.keyDown(box, { key: "Enter", metaKey: true })
        await waitFor(() =>
            expect(f.find("GET", "/api/jobs/j3")).toHaveLength(1)
        )
        // the job finished while the stream was down
        stored = {
            id: "j3",
            type: "command",
            status: "done",
            summary: "T-4 is overdue",
        }
        act(() => emit(stream, "stream.reconnected", null, {}))
        expect(await screen.findByText("T-4 is overdue")).toBeInTheDocument()
        expect(f.find("GET", "/api/jobs/j3")).toHaveLength(2)
    })

    it("Ctrl+Enter on '>' text sends to the command endpoint and Hide closes it", async () => {
        const f = setup({
            "POST /api/command": reply(202, {
                job: { id: "j2", type: "command", status: "queued" },
            }),
        })
        await screen.findByText("Talk to Ron about 123")
        const box = screen.getByLabelText("Capture a task")
        fireEvent.change(box, { target: { value: "> what is overdue?" } })
        fireEvent.keyDown(box, { key: "Enter", ctrlKey: true })
        await screen.findByRole("button", { name: "Hide" })
        expect(f.find("POST", "/api/command")[0].body).toEqual({
            text: "what is overdue?",
        })
        fireEvent.click(screen.getByRole("button", { name: "Hide" }))
        expect(screen.queryByText("what is overdue?")).not.toBeInTheDocument()
    })

    it("toasts capture errors", async () => {
        setup({
            "POST /api/tasks": reply(400, {
                error: "validation",
                message: "text, title or url is required",
            }),
            "POST /api/command": reply(503, {
                error: "unavailable",
                message: "center offline",
            }),
        })
        await screen.findByText("Talk to Ron about 123")
        const box = screen.getByLabelText("Capture a task")
        fireEvent.change(box, { target: { value: "x" } })
        fireEvent.keyDown(box, { key: "Enter", metaKey: true })
        expect(
            await screen.findByText("text, title or url is required")
        ).toBeInTheDocument()
        fireEvent.change(box, { target: { value: ">do it" } })
        fireEvent.click(
            screen.getByRole("button", { name: "Send to center agent" })
        )
        expect(await screen.findByText("center offline")).toBeInTheDocument()
        // empty input is a no-op
        fireEvent.change(box, { target: { value: "  " } })
        fireEvent.keyDown(box, { key: "Enter", metaKey: true })
        fireEvent.change(box, { target: { value: ">  " } })
        fireEvent.keyDown(box, { key: "Enter", metaKey: true })
    })

    it("marks a task done and snoozes another", async () => {
        const f = setup({
            "PATCH /api/tasks/2": {
                task: sampleTask({ id: 2, status: "done" }),
                revision: "r2",
            },
            "PATCH /api/tasks/1": ({ body }) =>
                body.snooze === "whenever"
                    ? reply(400, {
                          error: "validation",
                          message: "could not parse snooze",
                      })
                    : {
                          task: sampleTask({
                              id: 1,
                              status: "waiting",
                              snooze_until: body.snooze
                                  ? "2026-11-13T14:00:00Z"
                                  : body.patch.snooze_until,
                          }),
                          revision: "r3",
                      },
        })
        await screen.findByText("Talk to Ron about 123")
        fireEvent.click(screen.getByRole("button", { name: "Mark T-2 done" }))
        await screen.findByText("T-2 done")
        expect(f.find("PATCH", "/api/tasks/2")[0].body).toEqual({
            patch: { status: "done" },
        })

        const nowRow = screen.getByText("Talk to Ron about 123").closest("li")
        fireEvent.click(within(nowRow).getByRole("button", { name: /Snooze/ }))
        fireEvent.click(
            within(nowRow).getByRole("menuitem", { name: "Tomorrow 9am" })
        )
        await screen.findByText(/T-1 snoozed until/)
        const body = f.find("PATCH", "/api/tasks/1")[0].body
        expect(body.patch.status).toBe("waiting")
        expect(new Date(body.patch.snooze_until).getHours()).toBe(9)

        // custom text goes to the server's parser as a real snooze
        fireEvent.click(within(nowRow).getByRole("button", { name: /Snooze/ }))
        fireEvent.change(within(nowRow).getByLabelText("Custom snooze"), {
            target: { value: "friday 2pm" },
        })
        fireEvent.click(within(nowRow).getByRole("button", { name: "Set" }))
        await waitFor(() =>
            expect(f.find("PATCH", "/api/tasks/1")).toHaveLength(2)
        )
        expect(f.find("PATCH", "/api/tasks/1")[1].body).toEqual({
            snooze: "friday 2pm",
        })
        expect(f.find("POST", "/api/tasks/1/schedules")).toHaveLength(0)
        await waitFor(() =>
            expect(screen.getAllByText(/T-1 snoozed until/)).toHaveLength(2)
        )

        // unreadable text: the server's 400 message, menu stays open
        fireEvent.click(within(nowRow).getByRole("button", { name: /Snooze/ }))
        fireEvent.change(within(nowRow).getByLabelText("Custom snooze"), {
            target: { value: "whenever" },
        })
        fireEvent.click(within(nowRow).getByRole("button", { name: "Set" }))
        const alert = await within(nowRow).findByRole("alert")
        expect(alert).toHaveTextContent(
            'Can\'t snooze until "whenever": could not parse snooze'
        )
        expect(within(nowRow).getByRole("menu")).toBeInTheDocument()
        // typing clears the inline error
        fireEvent.change(within(nowRow).getByLabelText("Custom snooze"), {
            target: { value: "whenever!" },
        })
        expect(within(nowRow).queryByRole("alert")).not.toBeInTheDocument()
    })

    it("keeps the snooze menu open on errors and closes on Escape", async () => {
        setup({
            "PATCH /api/tasks/1": reply(500, {
                error: "boom",
                message: "store failed",
            }),
        })
        await screen.findByText("Talk to Ron about 123")
        const nowRow = screen.getByText("Talk to Ron about 123").closest("li")
        fireEvent.click(within(nowRow).getByRole("button", { name: /Snooze/ }))
        fireEvent.click(
            within(nowRow).getByRole("menuitem", { name: "2 hours" })
        )
        expect(await within(nowRow).findByRole("alert")).toHaveTextContent(
            "store failed"
        )
        expect(within(nowRow).getByRole("menu")).toBeInTheDocument()
        fireEvent.keyDown(document, { key: "Escape" })
        expect(within(nowRow).queryByRole("menu")).not.toBeInTheDocument()
        fireEvent.click(within(nowRow).getByRole("button", { name: /Snooze/ }))
        fireEvent.pointerDown(document.body)
        expect(within(nowRow).queryByRole("menu")).not.toBeInTheDocument()
    })

    it("toasts done errors", async () => {
        setup({ "PATCH /api/tasks/2": reply(403, { error: "forbidden" }) })
        await screen.findByText("Talk to Ron about 123")
        fireEvent.click(screen.getByRole("button", { name: "Mark T-2 done" }))
        expect(
            await screen.findByText("Owner access required")
        ).toBeInTheDocument()
    })

    it("searches with the '/' shortcut", async () => {
        const f = setup({
            "GET /api/tasks": {
                tasks: [sampleTask({ id: 77, title: "Lambda memory" })],
                total: 1,
            },
        })
        await screen.findByText("Talk to Ron about 123")
        fireEvent.keyDown(document, { key: "/" })
        const search = screen.getByLabelText("Search")
        expect(document.activeElement).toBe(search)
        fireEvent.change(search, { target: { value: "lambda" } })
        expect(await screen.findByText("Lambda memory")).toBeInTheDocument()
        expect(f.find("GET", "/api/tasks")[0].url).toBe(
            "/api/tasks?q=lambda&limit=50"
        )
        expect(
            screen.queryByText("Talk to Ron about 123")
        ).not.toBeInTheDocument()
        fireEvent.keyDown(search, { key: "Escape" })
        expect(
            await screen.findByText("Talk to Ron about 123")
        ).toBeInTheDocument()
    })

    it("search results drop hidden tasks and refresh on reconnect", async () => {
        let rows = [
            sampleTask({ id: 77, title: "Lambda memory" }),
            sampleTask({ id: 78, title: "Lambda cold start" }),
        ]
        const f = setup({
            "GET /api/tasks": () => ({ tasks: rows, total: rows.length }),
        })
        await screen.findByText("Talk to Ron about 123")
        fireEvent.change(screen.getByLabelText("Search"), {
            target: { value: "lambda" },
        })
        expect(await screen.findByText("Lambda memory")).toBeInTheDocument()
        // T-77 becomes private: gone at once, and the search runs again
        rows = rows.filter((t) => t.id !== 77)
        act(() => emit(stream, "task.hidden", 77, {}))
        expect(screen.queryByText("Lambda memory")).not.toBeInTheDocument()
        expect(screen.getByText("Lambda cold start")).toBeInTheDocument()
        await waitFor(() => expect(f.find("GET", "/api/tasks")).toHaveLength(2))
        // a missed change is picked up after a reconnect
        rows = []
        act(() => emit(stream, "stream.reconnected", null, {}))
        expect(
            await screen.findByText("Nothing matches “lambda”")
        ).toBeInTheDocument()
        // hiding a task that is not in the results changes nothing
        act(() => emit(stream, "task.hidden", 5, {}))
    })

    it("search results are dropped and re-fetched when the role changes", async () => {
        let calls = 0
        mockFetch({
            "GET /api/board": board,
            "GET /api/tasks": () => {
                calls++
                return calls === 1
                    ? {
                          tasks: [sampleTask({ id: 90, title: "Private x" })],
                          total: 1,
                      }
                    : { tasks: [], total: 0 }
            },
        })
        const wrap = (role) => (
            <ToastProvider>
                <AppContext.Provider
                    value={{
                        me: { role, login: null, mode: "tailnet" },
                        isOwner: role === "owner",
                        refreshMe: jest.fn(),
                    }}
                >
                    <Home />
                </AppContext.Provider>
            </ToastProvider>
        )
        const r = render(wrap("owner"))
        await screen.findByText("Talk to Ron about 123")
        fireEvent.change(screen.getByLabelText("Search"), {
            target: { value: "private" },
        })
        expect(await screen.findByText("Private x")).toBeInTheDocument()
        r.rerender(wrap("viewer")) // e.g. the device was revoked
        expect(screen.queryByText("Private x")).not.toBeInTheDocument()
        expect(
            await screen.findByText("Nothing matches “private”")
        ).toBeInTheDocument()
        expect(calls).toBe(2)
    })

    it("shows empty and error search results", async () => {
        let fail = false
        setup({
            "GET /api/tasks": () =>
                fail
                    ? reply(500, { error: "x", message: "fts broke" })
                    : { tasks: [], total: 0 },
        })
        await screen.findByText("Talk to Ron about 123")
        const search = screen.getByLabelText("Search")
        fireEvent.change(search, { target: { value: "zzz" } })
        expect(
            await screen.findByText("Nothing matches “zzz”")
        ).toBeInTheDocument()
        fail = true
        fireEvent.change(search, { target: { value: "yyy" } })
        expect(await screen.findByText("fts broke")).toBeInTheDocument()
    })

    it("is read-only for viewers", async () => {
        setup({}, { role: "viewer" })
        await screen.findByText("Talk to Ron about 123")
        expect(
            screen.queryByLabelText("Capture a task")
        ).not.toBeInTheDocument()
        expect(
            screen.queryByRole("button", { name: /Mark T-2 done/ })
        ).not.toBeInTheDocument()
        expect(
            screen.queryByRole("button", { name: /Snooze/ })
        ).not.toBeInTheDocument()
        expect(screen.getByLabelText("Search")).toBeInTheDocument()
    })

    it("shows an error state with retry", async () => {
        let n = 0
        mockFetch({
            "GET /api/board": () =>
                n++ === 0
                    ? reply(500, { error: "x", message: "db locked" })
                    : board,
        })
        renderWithApp(<Home />)
        expect(await screen.findByText("db locked")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Retry" }))
        expect(
            await screen.findByText("Talk to Ron about 123")
        ).toBeInTheDocument()
    })

    it("shows the empty state", async () => {
        mockFetch({ "GET /api/board": { lanes: {} } })
        renderWithApp(<Home />)
        expect(await screen.findByText("No tasks yet")).toBeInTheDocument()
        mockFetch({ "GET /api/board": { lanes: {} } })
    })

    it("shows the viewer empty state and quiet lanes", async () => {
        mockFetch({ "GET /api/board": { lanes: {} } })
        renderWithApp(<Home />, { role: "viewer" })
        expect(
            await screen.findByText("Nothing has been shared yet.")
        ).toBeInTheDocument()
    })

    it("renders quiet lanes when Now is empty", async () => {
        mockFetch({
            "GET /api/board": {
                lanes: { done: [sampleTask({ id: 8, status: "done" })] },
            },
        })
        renderWithApp(<Home />)
        expect(
            await screen.findByText("All clear. Nothing needs you right now.")
        ).toBeInTheDocument()
        expect(screen.getByText("Inbox zero.")).toBeInTheDocument()
        expect(screen.getByRole("tab", { name: /Done/ })).toHaveAttribute(
            "aria-selected",
            "true"
        )
    })

    it("refreshes the board on SSE events", async () => {
        const f = setup()
        await screen.findByText("Talk to Ron about 123")
        act(() => emit(stream, "task.created", 99, { task: {} }))
        await waitFor(
            () => expect(f.find("GET", "/api/board").length).toBe(2),
            { timeout: 2000 }
        )
    })
})

describe("mergeJob", () => {
    const s = { id: "j1", status: "running", summary: null }
    test("applies newer or same-stage views of the same job", () => {
        expect(
            mergeJob(s, { id: "j1", status: "done", summary: "ok" })
        ).toEqual({ id: "j1", status: "done", summary: "ok" })
        expect(mergeJob(s, { id: "j1", status: "parked" }).status).toBe(
            "parked"
        )
    })
    test("ignores stale stages, other jobs and empty responses", () => {
        const done = { id: "j1", status: "done" }
        expect(mergeJob(done, { id: "j1", status: "running" })).toBe(done)
        expect(mergeJob(s, { id: "j1", status: "queued" })).toBe(s)
        expect(mergeJob(s, { id: "j2", status: "done" })).toBe(s)
        expect(mergeJob(s, null)).toBe(s)
    })
})

describe("Home: phase 2/3", () => {
    const today = () => {
        const d = new Date()
        const p = (n) => String(n).padStart(2, "0")
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }
    const prBoard = {
        lanes: {
            ...board.lanes,
            prs: [
                sampleTask({
                    id: 7,
                    title: "Needs PR",
                    status: "ready_for_pr",
                }),
                sampleTask({
                    id: 8,
                    title: "Has feedback",
                    status: "pr_feedback",
                }),
            ],
        },
        agents: { 2: "working", 8: "blocked" },
    }
    const digest = {
        digest: {
            date: today(),
            summary: "Morning: 1 in Now",
            sections: [
                {
                    id: "now",
                    title: "Now",
                    items: [{ id: 1, title: "Talk to Ron" }],
                },
            ],
        },
    }

    beforeEach(() => localStorage.clear())

    it("shows agent chips, PR badges and the digest with the features on", async () => {
        setup(
            { "GET /api/board": prBoard, "GET /api/digest": digest },
            { features: ALL_FEATURES }
        )
        expect(
            await screen.findByRole("region", { name: "Morning digest" })
        ).toBeInTheDocument()
        expect(screen.getByLabelText("Agent working")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("tab", { name: /PRs/ }))
        expect(screen.getByLabelText("Agent blocked")).toBeInTheDocument()
        expect(screen.getByText("create PR")).toBeInTheDocument()
        expect(screen.getByText("review feedback")).toBeInTheDocument()
        act(() => emit(stream, "agent.updated", 2, { state: "idle" }))
        expect(screen.getByLabelText("Agent idle")).toBeInTheDocument()
    })

    it("herdr: every task with a live agent, from any lane, grouped by lane", async () => {
        setup(
            {
                "GET /api/board": {
                    ...prBoard,
                    // 5 (done) has a gone agent: not attached any more
                    agents: {
                        1: "idle",
                        2: "working",
                        8: "blocked",
                        5: "gone",
                    },
                },
                "GET /api/digest": { digest: null },
            },
            { features: ALL_FEATURES }
        )
        await screen.findByText("iOS crash on upload")
        expect(
            screen
                .getAllByRole("tab")
                .map((t) => t.textContent.replace(/\d+$/, ""))
        ).toEqual(["All", "herdr", "Inbox", "Active", "PRs", "Waiting", "Done"])
        const tab = screen.getByRole("tab", { name: /herdr/ })
        expect(tab).toHaveTextContent("3")
        // never the default pill, and not rendered until picked
        expect(tab).toHaveAttribute("aria-selected", "false")
        expect(document.getElementById("lane-herdr")).toBeNull()
        fireEvent.click(tab)
        const lane = document.getElementById("lane-herdr")
        expect(lane).toHaveClass("is-current")
        expect(
            within(lane)
                .getAllByRole("heading", { level: 3 })
                .map((h) => h.textContent)
        ).toEqual(["Now1", "Active1", "PRs1"])
        const ids = () =>
            [...lane.querySelectorAll(".row")].map((r) => r.dataset.taskId)
        expect(ids()).toEqual(["1", "2", "8"])
        expect(lane.querySelector(".lane-dot").className).toBe(
            "lane-dot lane-dot-now"
        )
        // live: an agent that goes away leaves, a new one joins
        act(() => emit(stream, "agent.updated", 2, { state: "gone" }))
        act(() => emit(stream, "agent.updated", 3, { state: "working" }))
        expect(ids()).toEqual(["1", "8", "3"])
        expect(tab).toHaveTextContent("3")
        act(() => emit(stream, "agent.updated", 1, { state: null }))
        expect(ids()).toEqual(["8", "3"])
    })

    it("herdr says so when no agent runs", async () => {
        setup(
            {
                "GET /api/board": { lanes: board.lanes },
                "GET /api/digest": { digest: null },
            },
            { features: ALL_FEATURES }
        )
        await screen.findByText("iOS crash on upload")
        fireEvent.click(screen.getByRole("tab", { name: /herdr/ }))
        expect(screen.getByText("No herdr agents running.")).toBeInTheDocument()
    })

    it("herdr lists agents on tasks done before the board's window", async () => {
        const old = sampleTask({
            id: 40,
            title: "Old shipped",
            status: "done",
            done_at: "2026-09-01T09:00:00Z",
        })
        setup(
            {
                "GET /api/board": {
                    lanes: board.lanes,
                    agents: { 2: "working", 40: "idle" },
                    // 2 is on the board already: listed once
                    agent_tasks: [old, sampleTask({ id: 2 })],
                },
                "GET /api/digest": { digest: null },
            },
            { features: ALL_FEATURES }
        )
        await screen.findByText("iOS crash on upload")
        const tab = screen.getByRole("tab", { name: /herdr/ })
        expect(tab).toHaveTextContent("2")
        fireEvent.click(tab)
        const lane = document.getElementById("lane-herdr")
        expect(
            within(lane)
                .getAllByRole("heading", { level: 3 })
                .map((h) => h.textContent)
        ).toEqual(["Active1", "Done1"])
        expect(within(lane).getByText("Old shipped")).toBeInTheDocument()
        // not added to the Done lane itself
        expect(
            within(document.getElementById("lane-done")).queryByText(
                "Old shipped"
            )
        ).toBeNull()
    })

    it("an empty board with an agent on an old task still shows herdr", async () => {
        setup(
            {
                "GET /api/board": {
                    lanes: {},
                    agents: { 40: "idle" },
                    agent_tasks: [
                        sampleTask({
                            id: 40,
                            title: "Old shipped",
                            status: "done",
                        }),
                    ],
                },
                "GET /api/digest": { digest: null },
            },
            { features: ALL_FEATURES }
        )
        const tab = await screen.findByRole("tab", { name: /herdr/ })
        expect(screen.queryByText("No tasks yet")).toBeNull()
        fireEvent.click(tab)
        expect(
            within(document.getElementById("lane-herdr")).getByText(
                "Old shipped"
            )
        ).toBeInTheDocument()
    })

    it("no herdr pill for a viewer", async () => {
        setup(
            { "GET /api/board": prBoard },
            { features: ALL_FEATURES, role: "viewer" }
        )
        await screen.findByText("iOS crash on upload")
        expect(screen.queryByRole("tab", { name: /herdr/ })).toBeNull()
    })

    it("search results carry the agent chip", async () => {
        setup(
            {
                "GET /api/board": prBoard,
                "GET /api/digest": { digest: null },
                "GET /api/tasks": { tasks: [sampleTask({ id: 2 })], total: 1 },
            },
            { features: ALL_FEATURES }
        )
        await screen.findByText("iOS crash on upload")
        fireEvent.change(screen.getByLabelText("Search"), {
            target: { value: "lambda" },
        })
        const results = await screen.findByRole("region", {
            name: "Search results",
        })
        await waitFor(() =>
            expect(
                within(results).getByLabelText("Agent working")
            ).toBeInTheDocument()
        )
    })

    it("hides chips, badges and the digest without the features", async () => {
        const f = setup({
            "GET /api/board": prBoard,
            "GET /api/digest": digest,
        })
        await screen.findByText("iOS crash on upload")
        expect(screen.queryByLabelText("Agent working")).toBeNull()
        expect(screen.queryByRole("tab", { name: /herdr/ })).toBeNull()
        fireEvent.click(screen.getByRole("tab", { name: /PRs/ }))
        expect(screen.queryByText("create PR")).toBeNull()
        expect(
            screen.queryByRole("region", { name: "Morning digest" })
        ).toBeNull()
        expect(f.find("GET", "/api/digest")).toHaveLength(0)
    })
})

describe("Home layout", () => {
    it("the Ready pill shows when the lane has tasks", async () => {
        mockFetch({
            "GET /api/board": {
                lanes: {
                    ...board.lanes,
                    inbox: [],
                    ready: [
                        sampleTask({
                            id: 9,
                            title: "Reopened",
                            status: "ready",
                        }),
                    ],
                },
            },
        })
        renderWithApp(<Home />)
        expect(await screen.findByText("Reopened")).toBeInTheDocument()
        expect(
            screen
                .getAllByRole("tab")
                .map((t) => t.textContent.replace(/\d+$/, ""))
        ).toEqual(["All", "Inbox", "Ready", "Active", "PRs", "Waiting", "Done"])
        expect(screen.getByRole("tab", { name: /Ready/ })).toHaveAttribute(
            "aria-selected",
            "true"
        )
    })

    it("search goes into the top bar slot when there is one", async () => {
        const slot = document.createElement("div")
        slot.id = "topbar-slot"
        document.body.appendChild(slot)
        try {
            setup()
            await screen.findByText("Talk to Ron about 123")
            const input = screen.getByRole("searchbox", { name: "Search" })
            expect(slot.contains(input)).toBe(true)
            expect(input.closest(".home-top")).toBeNull()
        } finally {
            slot.remove()
        }
    })

    it("without a top bar the search stays at the top of the page", async () => {
        setup()
        await screen.findByText("Talk to Ron about 123")
        expect(
            screen
                .getByRole("searchbox", { name: "Search" })
                .closest(".home-top")
        ).not.toBeNull()
    })
})

describe("Home row actions", () => {
    const withRepo = {
        lanes: {
            ...board.lanes,
            inbox: [
                sampleTask({
                    id: 7,
                    title: "Has a repo",
                    status: "inbox",
                    repos: [{ name: "aws-batch", role: "main" }],
                }),
            ],
        },
        agents: { 2: "idle" },
    }

    it("Start launches the agent; herdr switches to the agent's workspace", async () => {
        const f = mockFetch({
            "GET /api/board": withRepo,
            "POST /api/tasks/7/start": reply(202, { session: { id: 1 } }),
            "POST /api/tasks/2/actions/focus": { ok: true },
        })
        renderWithApp(<Home />, { features: ALL_FEATURES })
        fireEvent.click(
            await screen.findByRole("button", {
                name: "Start an agent for T-7",
            })
        )
        expect(
            await screen.findByText("T-7: starting the agent…")
        ).toBeInTheDocument()
        expect(f.find("POST", "/api/tasks/7/start")[0].body).toEqual({})
        fireEvent.click(screen.getByRole("tab", { name: /Active/ }))
        fireEvent.click(screen.getByRole("button", { name: /herdr/ }))
        expect(
            await screen.findByText("herdr: switched to T-2")
        ).toBeInTheDocument()
    })

    it("errors from Start and herdr are toasted", async () => {
        mockFetch({
            "GET /api/board": withRepo,
            "POST /api/tasks/7/start": reply(409, {
                error: "agent_running",
                message: "T-7 already has a live agent",
            }),
            "POST /api/tasks/2/actions/focus": reply(409, {
                error: "no_agent",
                message: "T-2 has no live agent",
            }),
        })
        renderWithApp(<Home />, { features: ALL_FEATURES })
        fireEvent.click(
            await screen.findByRole("button", {
                name: "Start an agent for T-7",
            })
        )
        expect(
            await screen.findByText("T-7 already has a live agent")
        ).toBeInTheDocument()
        fireEvent.click(screen.getByRole("tab", { name: /Active/ }))
        fireEvent.click(screen.getByRole("button", { name: /herdr/ }))
        expect(
            await screen.findByText("T-2 has no live agent")
        ).toBeInTheDocument()
    })
})
