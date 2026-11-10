/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { fireEvent, render, screen } from "@testing-library/react"
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

describe("LinksList", () => {
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
