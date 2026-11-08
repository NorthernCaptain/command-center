/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// In-process event bus. Every state change is published here; the SSE
// endpoint fans events out to browsers (filtered per role).
//
// Event shape: { type: string, task_id: number|null, data: object, at: ISO }
// Types: see docs/implementation/contracts.md#bus-events

import { EventEmitter } from "node:events"

export function createBus({ clock } = {}) {
    const emitter = new EventEmitter()
    emitter.setMaxListeners(1000)
    const now = () => (clock ? clock.now() : new Date()).toISOString()
    return {
        emit(type, { task_id = null, data = {} } = {}) {
            const event = { type, task_id, data, at: now() }
            emitter.emit("event", event)
            return event
        },
        subscribe(fn) {
            emitter.on("event", fn)
            return () => emitter.off("event", fn)
        },
        listenerCount() {
            return emitter.listenerCount("event")
        },
    }
}
