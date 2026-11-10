/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { render, screen } from "@testing-library/react"
import ChatPanel from "./ChatPanel.jsx"

const turn = (id, over = {}) => ({
    id,
    parent_id: null,
    intent: "chat",
    author: "me",
    body: `question ${id}`,
    at: "2026-11-09T10:00:00Z",
    status: "resolved",
    replies: [],
    ...over,
})

describe("ChatPanel", () => {
    it("shows the whole chat in order, center replies as Markdown", () => {
        const threads = [
            turn("a", {
                replies: [
                    {
                        id: "a1",
                        author: "center",
                        body: "Noted:\n\n- **aws-lambda**\n- <b>raw</b>",
                        at: "2026-11-09T10:00:05Z",
                    },
                    { id: "a2", author: "me", body: "thanks", at: "x" },
                ],
            }),
            turn("b", { status: "working" }),
            turn("c", { status: "open", resolution: "center failed: boom" }),
            turn("d", { status: "open", author: undefined }),
        ]
        const scroll = Element.prototype.scrollIntoView
        render(<ChatPanel threads={threads} />)
        const log = screen.getByRole("list", {
            name: "Chat with the center agent",
        })
        expect(log.querySelectorAll(".chat-turn")).toHaveLength(4)
        expect(log.textContent.indexOf("question a")).toBeLessThan(
            log.textContent.indexOf("question b")
        )
        const md = log.querySelector(".chat-md")
        expect(md.querySelector("strong")).toHaveTextContent("aws-lambda")
        // raw HTML is escaped, never rendered
        expect(md.querySelector("b")).toBeNull()
        expect(screen.getByText("thanks")).toBeInTheDocument()
        expect(screen.getByText("center is answering…")).toBeInTheDocument()
        expect(screen.getByText("center failed: boom")).toHaveClass(
            "chat-failed"
        )
        expect(screen.getByText("?")).toBeInTheDocument()
        if (scroll && scroll.mock) expect(scroll).toHaveBeenCalled()
    })

    it("is empty without a chat", () => {
        render(<ChatPanel threads={null} />)
        expect(screen.getByText(/No chat yet/)).toBeInTheDocument()
    })
})
