/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */
import {
    isParentLink,
    parentIdOf,
    parentLabel,
    spinOffLabel,
    taskIdOfUrl,
    taskUrl,
} from "./family.js"

describe("family helpers", () => {
    test("taskIdOfUrl / taskUrl", () => {
        expect(taskIdOfUrl("/t/12")).toBe(12)
        expect(taskIdOfUrl(" /t/T-12/ ")).toBe(12)
        expect(taskIdOfUrl("https://example.com/t/12")).toBeNull()
        expect(taskIdOfUrl(null)).toBeNull()
        expect(taskUrl(7)).toBe("/t/7")
    })

    test("parent links: role, or the legacy label", () => {
        expect(isParentLink(null)).toBe(false)
        expect(isParentLink({ url: "/t/2", role: "parent" })).toBe(true)
        expect(
            isParentLink({
                url: "/t/2",
                role: null,
                label: "spun off from T-2",
            })
        ).toBe(true)
        expect(
            isParentLink({ url: "/t/2", role: "spin_off", label: "x" })
        ).toBe(false)
        expect(isParentLink({ url: "/t/2", label: "see also" })).toBe(false)
        expect(
            isParentLink({ url: "https://x", role: "parent", label: "p" })
        ).toBe(false)
        expect(
            parentIdOf({
                links: [
                    { url: "/t/9", role: "spin_off" },
                    { url: "/t/4", role: "parent" },
                ],
            })
        ).toBe(4)
        expect(parentIdOf({ links: [] })).toBeNull()
        expect(parentIdOf(null)).toBeNull()
    })

    test("labels", () => {
        expect(parentLabel(24)).toBe("spun off from T-24")
        expect(parentLabel(24, 29)).toBe("spun off from T-29, under T-24")
        expect(parentLabel(24, null)).toBe("spun off from T-24")
        expect(spinOffLabel({ id: 32, title: " Merge queue " })).toBe(
            "T-32: Merge queue"
        )
        expect(spinOffLabel({ id: 32 })).toBe("T-32")
    })
})
