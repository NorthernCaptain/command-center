/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */
import {
    AppError,
    NotFoundError,
    StaleRevisionError,
    ValidationError,
    ForbiddenError,
    LimitError,
} from "./errors.js"

test("error classes carry code and status", () => {
    expect(new AppError("x", "m")).toMatchObject({ code: "x", status: 400 })
    expect(new NotFoundError("task 1")).toMatchObject({
        code: "not_found",
        status: 404,
        message: "task 1 not found",
    })
    const cur = { content: "c", revision: "r" }
    const s = new StaleRevisionError(cur)
    expect(s).toMatchObject({ code: "stale_revision", status: 409 })
    expect(s.current).toBe(cur)
    expect(s.details).toEqual({ current: cur })
    expect(new ValidationError("bad", { f: 1 })).toMatchObject({
        status: 400,
        details: { f: 1 },
    })
    expect(new ForbiddenError()).toMatchObject({ status: 403 })
    expect(new ForbiddenError("no").message).toBe("no")
    expect(new LimitError("limit")).toMatchObject({
        code: "provider_limit",
        status: 503,
    })
    expect(new LimitError("x")).toBeInstanceOf(AppError)
})
