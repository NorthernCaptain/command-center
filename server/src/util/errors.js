/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Typed errors shared across modules. HTTP layer maps `status` to responses.

export class AppError extends Error {
    constructor(code, message, { status = 400, details = undefined } = {}) {
        super(message)
        this.code = code
        this.status = status
        this.details = details
    }
}

export class NotFoundError extends AppError {
    constructor(what) {
        super("not_found", `${what} not found`, { status: 404 })
    }
}

/** Optimistic concurrency failure. `current` = { content|task, revision }. */
export class StaleRevisionError extends AppError {
    constructor(current) {
        super("stale_revision", "base_revision does not match current", {
            status: 409,
            details: { current },
        })
        this.current = current
    }
}

export class ValidationError extends AppError {
    constructor(message, details) {
        super("validation", message, { status: 400, details })
    }
}

export class ForbiddenError extends AppError {
    constructor(message = "owner access required") {
        super("forbidden", message, { status: 403 })
    }
}

/** Provider hit a usage / credit limit; job runner may fall back. */
export class LimitError extends AppError {
    constructor(message) {
        super("provider_limit", message, { status: 503 })
    }
}
