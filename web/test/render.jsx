/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { render } from "@testing-library/react"
import { AppContext, featuresOf } from "../src/components/AppContext.jsx"
import { ToastProvider } from "../src/components/Toasts.jsx"
import { createEventStream, setEventStream } from "../src/lib/events.js"

/** Fresh, never-connected event stream; use stream.dispatch() to emit. */
export function freshStream() {
    const stream = createEventStream({ EventSource: null })
    setEventStream(stream)
    return stream
}

/** Every optional server feature on (pass as renderWithApp features). */
export const ALL_FEATURES = {
    workers: true,
    github: true,
    push: true,
    soc2: true,
    digest: true,
}

export function renderWithApp(
    ui,
    { role = "owner", mode = "local", refreshMe = jest.fn(), features } = {}
) {
    const me = { role, login: null, mode, features }
    const value = {
        me,
        isOwner: role === "owner",
        features: featuresOf(me),
        refreshMe,
    }
    return render(
        <ToastProvider>
            <AppContext.Provider value={value}>{ui}</AppContext.Provider>
        </ToastProvider>
    )
}

export function emit(stream, type, task_id, data) {
    stream.dispatch({ type, task_id, data, at: null })
}
