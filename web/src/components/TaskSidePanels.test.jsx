/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { fireEvent, render, screen, within } from "@testing-library/react"
import { ActivityList, LinksList } from "./TaskSidePanels.jsx"

const at = "2026-11-08T19:00:00Z"

describe("ActivityList", () => {
    it("explains the Slack thread events", () => {
        render(
            <ActivityList
                events={[
                    {
                        type: "slack_asana_link",
                        actor: "center",
                        at,
                        data: { brain_job: "j_abc" },
                    },
                    {
                        type: "slack_asana_link_failed",
                        actor: "center",
                        at,
                        data: { error: "brain down" },
                    },
                    { type: "slack_asana_link", actor: "center", at },
                    { type: "slack_asana_link_failed", actor: "center", at },
                ]}
            />
        )
        expect(
            screen.getByText(
                "asked Brain to post the Asana link in the Slack thread (j_abc)"
            )
        ).toBeInTheDocument()
        expect(
            screen.getByText(
                "could not post the Asana link to Slack: brain down"
            )
        ).toBeInTheDocument()
        expect(
            screen.getByText(
                "asked Brain to post the Asana link in the Slack thread (job)"
            )
        ).toBeInTheDocument()
        expect(
            screen.getByText(
                "could not post the Asana link to Slack: unknown error"
            )
        ).toBeInTheDocument()
    })
})

describe("ActivityList: task family events", () => {
    it("explains spin-offs and moves", () => {
        const ev = (type, data) => ({ type, actor: "agent:x", at, data })
        render(
            <ActivityList
                events={[
                    ev("spun_off", { task_id: 32 }),
                    ev("spun_off", { task_id: 33, by: 29 }),
                    ev("spun_off", { task_id: 32, moved_from: 29 }),
                    ev("reparented", { from: 29, to: 24 }),
                    ev("reparented", { from: null, to: 24 }),
                    ev("spin_off_moved", { task_id: 32 }),
                ]}
            />
        )
        for (const text of [
            "spun off T-32",
            "spun off T-33 (from T-29)",
            "T-32 moved here from T-29",
            "moved under T-24 (was under T-29)",
            "moved under T-24",
            "spin-off T-32 moved away",
        ])
            expect(screen.getByText(text)).toBeInTheDocument()
    })
})

describe("LinksList", () => {
    it("groups task links at the top: parent, then spin-offs", () => {
        window.history.replaceState(null, "", "/t/29")
        const { container } = render(
            <LinksList
                links={[
                    {
                        id: "w",
                        type: "pr",
                        url: "https://example.com/pr/1",
                        label: "PR",
                    },
                    {
                        id: "s",
                        type: "doc",
                        url: "/t/32",
                        label: "T-32: Merge queue",
                        role: "spin_off",
                    },
                    { id: "o", type: "doc", url: "/t/7", label: "see T-7" },
                    {
                        id: "p",
                        type: "doc",
                        url: "/t/24",
                        label: "spun off from T-24",
                        role: null,
                    },
                ]}
            />
        )
        const heads = [...container.querySelectorAll("h3")].map(
            (h) => h.textContent
        )
        expect(heads).toEqual(["Tasks3", "Links1"])
        const [tasks, rest] = container.querySelectorAll("ul.links")
        expect(
            within(tasks)
                .getAllByRole("link")
                .map((a) => a.getAttribute("href"))
        ).toEqual(["/t/24", "/t/32", "/t/7"])
        expect(
            [...tasks.querySelectorAll(".link-type")].map((t) => t.textContent)
        ).toEqual(["parent", "spin-off", "task"])
        expect(within(rest).getByText("PR")).toBeInTheDocument()
        expect(container.firstChild.tagName).toBe("H3")
    })

    it("only task links: no Links group; none: no headers", () => {
        const { container, unmount } = render(
            <LinksList
                links={[{ id: "p", type: "doc", url: "/t/24", role: "parent" }]}
            />
        )
        expect(
            [...container.querySelectorAll("h3")].map((h) => h.textContent)
        ).toEqual(["Tasks1"])
        unmount()
        const other = render(
            <LinksList
                links={[{ id: "a", type: "doc", url: "https://example.com/d" }]}
            />
        )
        expect(other.container.querySelector("h3")).toBeNull()
    })

    it("task links route in this tab; folders are file://; web opens a new tab", () => {
        window.scrollTo = jest.fn() // the router scrolls to top on navigate
        window.history.replaceState(null, "", "/t/5")
        render(
            <LinksList
                links={[
                    {
                        id: "a",
                        type: "doc",
                        url: "/t/2",
                        label: "spun off from T-2",
                    },
                    {
                        id: "b",
                        type: "folder",
                        url: "/Users/me/tree/x",
                        label: "tree",
                    },
                    {
                        id: "c",
                        type: "pr",
                        url: "https://github.com/acme/r/pull/1",
                    },
                ]}
            />
        )
        const app = screen.getByText("spun off from T-2").closest("a")
        expect(app).toHaveAttribute("href", "/t/2")
        expect(app).not.toHaveAttribute("target")
        fireEvent.click(app)
        expect(window.location.pathname).toBe("/t/2")
        expect(screen.getByText("tree").closest("a")).toHaveAttribute(
            "href",
            "file:///Users/me/tree/x"
        )
        const web = screen
            .getByText("https://github.com/acme/r/pull/1")
            .closest("a")
        expect(web).toHaveAttribute("target", "_blank")
    })

    it("shows an empty state", () => {
        render(<LinksList links={[]} />)
        expect(screen.getByText("No links yet.")).toBeInTheDocument()
    })
})

describe("LinksList attachments", () => {
    it("opens a file link in the viewer on a plain click", () => {
        const onOpenFile = jest.fn()
        render(
            <LinksList
                taskId={4}
                onOpenFile={onOpenFile}
                links={[
                    {
                        id: "f",
                        type: "file",
                        url: "files/a.png",
                        label: "Shot",
                    },
                ]}
            />
        )
        const link = screen.getByRole("link", { name: /Shot/ })
        expect(link).toHaveAttribute("href", "/api/tasks/4/files/a.png")
        fireEvent.click(link, { metaKey: true })
        expect(onOpenFile).not.toHaveBeenCalled()
        fireEvent.click(link)
        expect(onOpenFile).toHaveBeenCalledWith("a.png")
    })

    it("without a viewer the link just opens the file", () => {
        render(
            <LinksList
                taskId={4}
                links={[
                    { id: "f", type: "file", url: "files/a.md", label: "A" },
                ]}
            />
        )
        const link = screen.getByRole("link", { name: /A/ })
        expect(fireEvent.click(link)).toBe(true)
    })
})
