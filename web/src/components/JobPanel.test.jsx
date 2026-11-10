/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { act, fireEvent, screen } from "@testing-library/react"
import JobPanel, { mergeJob } from "./JobPanel.jsx"
import { mockFetch } from "../../test/helpers.js"
import { emit, freshStream, renderWithApp } from "../../test/render.jsx"

const JOB = { id: "j1", type: "assist", status: "running" }

// jsdom has no layout: give the panel a fixed box over a taller content
function sizes(el, { scrollHeight, clientHeight }) {
    Object.defineProperty(el, "scrollHeight", {
        configurable: true,
        get: () => scrollHeight,
    })
    Object.defineProperty(el, "clientHeight", {
        configurable: true,
        get: () => clientHeight,
    })
}

describe("JobPanel", () => {
    let stream
    beforeEach(() => {
        stream = freshStream()
        mockFetch({ "GET /api/jobs/j1": { job: JOB } })
    })

    it("follows the streamed reply unless scrolled up", async () => {
        renderWithApp(<JobPanel job={JOB} prompt="why?" />)
        const panel = await screen.findByRole("region", {
            name: "Center agent reply",
        })
        sizes(panel, { scrollHeight: 900, clientHeight: 300 })
        act(() =>
            emit(stream, "job.delta", 1, { job_id: "j1", text: "part one " })
        )
        expect(panel.scrollTop).toBe(900)

        // scrolled up to read: stays put
        panel.scrollTop = 100
        fireEvent.scroll(panel)
        sizes(panel, { scrollHeight: 1200, clientHeight: 300 })
        act(() =>
            emit(stream, "job.delta", 1, { job_id: "j1", text: "part two" })
        )
        expect(panel.scrollTop).toBe(100)

        // back at the bottom: follows again
        panel.scrollTop = 890
        fireEvent.scroll(panel)
        act(() =>
            emit(stream, "job.delta", 1, { job_id: "j1", text: " three" })
        )
        expect(panel.scrollTop).toBe(1200)
    })

    it("offers the extra link when given", async () => {
        const onMore = jest.fn()
        renderWithApp(
            <JobPanel
                job={JOB}
                prompt="x"
                onMore={onMore}
                moreLabel="Full chat"
            />
        )
        fireEvent.click(
            await screen.findByRole("button", { name: "Full chat" })
        )
        expect(onMore).toHaveBeenCalled()
    })

    it("mergeJob never moves a job back", () => {
        const done = { id: "j1", status: "done" }
        expect(mergeJob(done, { id: "j1", status: "running" })).toBe(done)
        expect(mergeJob(done, { id: "j2", status: "done" })).toBe(done)
        expect(mergeJob(JOB, done).status).toBe("done")
    })
})
