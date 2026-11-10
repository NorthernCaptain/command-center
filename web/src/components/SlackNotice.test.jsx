/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import SlackNotice, { noticeNeedsAttention } from "./SlackNotice.jsx"

const THREAD = "https://acme.slack.com/archives/C1/p1"
const base = {
    thread: THREAD,
    gid: "9",
    attempts: 1,
    brain_job: null,
    answer: null,
    error: null,
    at: null,
}

describe("SlackNotice", () => {
    it("missing: a warning with Post to Slack and the thread", async () => {
        const onPost = jest.fn(async () => {})
        render(
            <SlackNotice
                notice={{ ...base, status: "missing", attempts: 0 }}
                onPost={onPost}
            />
        )
        expect(screen.getByRole("alert")).toHaveTextContent(
            "The Slack thread has not been told about the Asana task."
        )
        expect(screen.getByRole("link", { name: "Thread ↗" })).toHaveAttribute(
            "href",
            THREAD
        )
        fireEvent.click(screen.getByRole("button", { name: "Post to Slack" }))
        await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1))
    })

    it("not posted: Brain's answer (clipped), the job and Try again", async () => {
        const onPost = jest.fn(async () => {
            throw new Error("toasted")
        })
        render(
            <SlackNotice
                notice={{
                    ...base,
                    status: "not_posted",
                    attempts: 2,
                    brain_job: "j_1",
                    answer: `The tool adds a mention. ${"x".repeat(500)}`,
                    at: new Date().toISOString(),
                }}
                onPost={onPost}
            />
        )
        const alert = screen.getByRole("alert")
        expect(alert).toHaveTextContent(
            "Brain did not post the Asana link to the Slack thread."
        )
        expect(alert).toHaveTextContent("try 2")
        expect(alert).toHaveTextContent("Brain: The tool adds a mention.")
        expect(alert.querySelector("blockquote").textContent).toMatch(/…$/)
        expect(screen.getByTitle("Brain job")).toHaveTextContent("j_1")
        const btn = screen.getByRole("button", { name: "Try again" })
        fireEvent.click(btn)
        fireEvent.click(btn) // busy: ignored
        await waitFor(() => expect(btn).not.toBeDisabled())
        expect(onPost).toHaveBeenCalledTimes(1)
    })

    it("failed shows the error; unknown asks to check the thread", () => {
        const { rerender } = render(
            <SlackNotice
                notice={{ ...base, status: "failed", error: "down" }}
            />
        )
        expect(screen.getByRole("alert")).toHaveTextContent("Error: down")
        rerender(<SlackNotice notice={{ ...base, status: "unknown" }} />)
        expect(screen.getByRole("alert")).toHaveTextContent(/check it/)
    })

    it("pending: a status line with Check now", async () => {
        const onCheck = jest.fn(async () => {})
        render(
            <SlackNotice
                notice={{ ...base, status: "pending", brain_job: "j_2" }}
                onCheck={onCheck}
            />
        )
        expect(screen.getByRole("status")).toHaveTextContent(/Posting/)
        fireEvent.click(screen.getByRole("button", { name: "Check now" }))
        await waitFor(() => expect(onCheck).toHaveBeenCalled())
    })

    it("posted: one quiet line, no button; nothing for no notice", () => {
        const { container, rerender } = render(
            <SlackNotice
                notice={{ ...base, status: "posted", answer: "RESULT: POSTED" }}
            />
        )
        expect(screen.getByRole("status")).toHaveTextContent(
            "✓ Slack thread told about the Asana task"
        )
        expect(screen.queryByRole("button")).toBeNull()
        expect(container.querySelector("blockquote")).toBeNull()
        rerender(<SlackNotice notice={null} />)
        expect(container).toBeEmptyDOMElement()
        rerender(<SlackNotice notice={{ ...base, status: "weird" }} />)
        expect(container).toBeEmptyDOMElement()
    })

    it("noticeNeedsAttention", () => {
        expect(noticeNeedsAttention(null)).toBe(false)
        expect(noticeNeedsAttention({ status: "posted" })).toBe(false)
        expect(noticeNeedsAttention({ status: "pending" })).toBe(false)
        expect(noticeNeedsAttention({ status: "missing" })).toBe(true)
        expect(noticeNeedsAttention({ status: "weird" })).toBe(false)
    })
})
