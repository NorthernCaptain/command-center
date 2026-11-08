/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { render, screen } from "@testing-library/react"
import { ActivityList } from "./TaskSidePanels.jsx"

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
