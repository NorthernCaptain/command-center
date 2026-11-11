/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import ChatBar from "./ChatBar.jsx"
import { chatDraft, saveChatDraft } from "../lib/chat.js"

const input = () => screen.getByLabelText("Message the center agent")

describe("ChatBar", () => {
    afterEach(() => window.localStorage.clear())

    it("keeps an unsent draft per task and clears it once sent", async () => {
        const onSend = jest.fn(async () => {})
        const first = render(<ChatBar draftKey="7" onSend={onSend} />)
        fireEvent.change(input(), { target: { value: "half a thought" } })
        expect(chatDraft("7")).toBe("half a thought")
        first.unmount()

        // back on the page: the draft is restored
        render(<ChatBar draftKey="7" onSend={onSend} />)
        expect(input().value).toBe("half a thought")
        fireEvent.submit(input().closest("form"))
        await waitFor(() => expect(input().value).toBe(""))
        expect(onSend).toHaveBeenCalledWith("half a thought")
        expect(chatDraft("7")).toBe("")
    })

    it("a failed send keeps the draft; no key saves nothing", async () => {
        saveChatDraft("8", "keep me")
        const onSend = jest.fn(async () => {
            throw new Error("offline")
        })
        const bar = render(<ChatBar draftKey="8" onSend={onSend} />)
        fireEvent.submit(input().closest("form"))
        await waitFor(() => expect(onSend).toHaveBeenCalled())
        await waitFor(() => expect(input()).not.toBeDisabled())
        expect(input().value).toBe("keep me")
        expect(chatDraft("8")).toBe("keep me")
        bar.unmount()

        render(<ChatBar onSend={onSend} />)
        expect(input().value).toBe("")
        fireEvent.change(input(), { target: { value: "x" } })
        expect(window.localStorage.length).toBe(1) // only task 8's draft
    })
})
