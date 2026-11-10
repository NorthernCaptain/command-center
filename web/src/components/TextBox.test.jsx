/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { createRef } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import TextBox, { isSubmitKey, submitHint } from "./TextBox.jsx"

function setup(props = {}) {
    const onSubmit = jest.fn()
    const onChange = jest.fn()
    render(
        <TextBox
            aria-label="box"
            value="hello"
            onChange={onChange}
            onSubmit={onSubmit}
            {...props}
        />
    )
    return { box: screen.getByLabelText("box"), onSubmit, onChange }
}

describe("TextBox", () => {
    test("Enter (plain or Shift) never submits; it is a newline", () => {
        const { box, onSubmit } = setup()
        expect(box.tagName).toBe("TEXTAREA")
        fireEvent.keyDown(box, { key: "Enter" })
        fireEvent.keyDown(box, { key: "Enter", shiftKey: true })
        fireEvent.keyDown(box, { key: "a", metaKey: true })
        expect(onSubmit).not.toHaveBeenCalled()
    })

    test("Cmd+Enter and Ctrl+Enter submit", () => {
        const { box, onSubmit } = setup()
        fireEvent.keyDown(box, { key: "Enter", metaKey: true })
        fireEvent.keyDown(box, { key: "Enter", ctrlKey: true })
        expect(onSubmit).toHaveBeenCalledTimes(2)
    })

    test("a caller's onKeyDown runs first and can cancel the submit", () => {
        const onKeyDown = jest.fn((e) => e.preventDefault())
        const { box, onSubmit } = setup({ onKeyDown })
        fireEvent.keyDown(box, { key: "Enter", metaKey: true })
        expect(onKeyDown).toHaveBeenCalled()
        expect(onSubmit).not.toHaveBeenCalled()
    })

    test("works without onSubmit and forwards object / function refs", () => {
        const ref = createRef()
        const { box } = setup({ onSubmit: undefined, ref })
        fireEvent.keyDown(box, { key: "Enter", metaKey: true })
        expect(ref.current).toBe(box)
        const fn = jest.fn()
        render(
            <TextBox aria-label="b2" value="" onChange={() => {}} ref={fn} />
        )
        expect(fn).toHaveBeenCalledWith(screen.getByLabelText("b2"))
    })

    test("grows with its content up to maxRows, then scrolls", () => {
        const spy = jest
            .spyOn(HTMLElement.prototype, "scrollHeight", "get")
            .mockReturnValue(500)
        try {
            const { box } = setup({ maxRows: 3, value: "a\nb\nc\nd\ne" })
            // jsdom: line-height "normal" -> 20px fallback; 2px UA padding x2
            expect(box.style.height).toBe("64px")
            expect(box.style.overflowY).toBe("auto")
        } finally {
            spy.mockRestore()
        }
    })

    test("a scrolling box keeps the caret in view while typing", () => {
        const spy = jest
            .spyOn(HTMLElement.prototype, "scrollHeight", "get")
            .mockReturnValue(500)
        try {
            const props = {
                "aria-label": "box",
                maxRows: 3,
                onChange: () => {},
            }
            const { rerender } = render(<TextBox {...props} value="a\nb" />)
            const box = screen.getByLabelText("box")
            // typing at the end: follows the end
            box.setSelectionRange(3, 3)
            rerender(<TextBox {...props} value="a\nb\nc" />)
            expect(box.scrollTop).toBe(500)
            // editing earlier in the text: the scroll position stays (jsdom
            // moves the caret to the end on a new value: pin it at the start)
            const caret = jest
                .spyOn(HTMLTextAreaElement.prototype, "selectionEnd", "get")
                .mockReturnValue(0)
            box.scrollTop = 40
            rerender(<TextBox {...props} value="x\na\nb\nc" />)
            expect(box.scrollTop).toBe(40)
            caret.mockRestore()
        } finally {
            spy.mockRestore()
        }
    })

    test("isSubmitKey ignores IME composition", () => {
        expect(
            isSubmitKey({
                key: "Enter",
                metaKey: true,
                nativeEvent: { isComposing: true },
            })
        ).toBe(false)
        expect(isSubmitKey({ key: "Enter", ctrlKey: true })).toBe(true)
        expect(isSubmitKey({ key: "Enter" })).toBe(false)
    })

    test("submitHint per platform", () => {
        expect(submitHint("MacIntel")).toBe("⌘⏎")
        expect(submitHint("iPhone")).toBe("⌘⏎")
        expect(submitHint("Win32")).toBe("Ctrl+⏎")
        expect(submitHint("")).toBe("Ctrl+⏎")
        expect(typeof submitHint()).toBe("string")
    })
})
