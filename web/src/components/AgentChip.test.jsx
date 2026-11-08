/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { render, screen } from "@testing-library/react"
import AgentChip, { isLiveAgent } from "./AgentChip.jsx"

describe("AgentChip", () => {
    it("renders the state with an accessible label", () => {
        render(<AgentChip state="working" name="t5-fix" />)
        const chip = screen.getByLabelText("Agent t5-fix: working")
        expect(chip).toHaveClass("agent-working")
        expect(chip).toHaveTextContent("●working")
    })

    it("handles unknown states and no name", () => {
        render(<AgentChip state="weird" />)
        expect(screen.getByLabelText("Agent weird")).toHaveTextContent("·weird")
    })

    it("renders nothing without a state", () => {
        const { container } = render(<AgentChip state={null} />)
        expect(container).toBeEmptyDOMElement()
    })
})

describe("isLiveAgent", () => {
    it("is true for any state but gone", () => {
        expect(isLiveAgent({ state: "idle" })).toBe(true)
        expect(isLiveAgent("blocked")).toBe(true)
        expect(isLiveAgent({ state: "gone" })).toBe(false)
        expect(isLiveAgent(null)).toBe(false)
        expect(isLiveAgent({})).toBe(false)
    })
})
