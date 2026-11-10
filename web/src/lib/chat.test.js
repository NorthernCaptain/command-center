/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import {
    CHAT_RESTORE_MS,
    chatThreads,
    closedChat,
    isChatThread,
    latestChat,
    rememberClosedChat,
    splitChat,
} from "./chat.js"

const NOW = Date.parse("2026-11-09T12:00:00Z")
const chat = (id, at, over = {}) => ({
    id,
    parent_id: null,
    intent: "chat",
    author: "me",
    body: `ask ${id}`,
    at,
    ...over,
})

describe("latestChat", () => {
    const comments = [
        chat("c1", "2026-11-09T10:00:00Z"),
        chat("c2", "2026-11-09T11:00:00Z"),
        chat("c3", "2026-11-09T11:30:00Z", { intent: "ask" }),
        chat("c4", "2026-11-09T11:40:00Z", { author: "center" }),
        null,
    ]
    const jobs = [
        { id: "j2b", comment_id: "c2" },
        { id: "j2a", comment_id: "c2" },
        { id: "j1", comment_id: "c1" },
        null,
    ]

    it("the newest chat request with its latest job", () => {
        expect(latestChat(comments, jobs, NOW)).toEqual({
            job: { id: "j2b", comment_id: "c2" },
            prompt: "ask c2",
        })
    })

    it("nothing when old, unanswered or absent", () => {
        expect(latestChat(comments, jobs, NOW + CHAT_RESTORE_MS)).toBeNull()
        expect(latestChat(comments, [], NOW)).toBeNull()
        expect(latestChat(null, null, NOW)).toBeNull()
        expect(latestChat([chat("c9", "bad")], jobs, NOW)).toBeNull()
        expect(latestChat([chat("c9", undefined)], jobs, NOW)).toBeNull()
    })
})

describe("closed chat memory", () => {
    afterEach(() => {
        jest.restoreAllMocks()
        window.localStorage.clear()
    })

    it("remembers per task", () => {
        expect(closedChat(2)).toBeNull()
        rememberClosedChat(2, "j1")
        expect(closedChat(2)).toBe("j1")
        expect(closedChat(3)).toBeNull()
    })

    it("storage errors are ignored", () => {
        jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked")
        })
        jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked")
        })
        expect(() => rememberClosedChat(2, "j1")).not.toThrow()
        expect(closedChat(2)).toBeNull()
    })
})

describe("chatThreads", () => {
    it("Leo's chat threads, oldest first", () => {
        const list = [
            chat("b", "2026-11-09T11:00:00Z"),
            chat("x", "2026-11-09T09:00:00Z", { intent: "change" }),
            chat("r", "2026-11-09T09:30:00Z", { parent_id: "b" }),
            chat("a", "2026-11-09T10:00:00Z"),
            chat("n", undefined),
            null,
        ]
        expect(chatThreads(list).map((t) => t.id)).toEqual(["n", "a", "b"])
        expect(chatThreads(null)).toEqual([])
        expect(isChatThread(null)).toBe(false)
        expect(isChatThread(chat("a", "x"))).toBe(true)
    })
})

describe("splitChat", () => {
    it("comments keep their order; the chat is apart", () => {
        const note = chat("n1", "2026-11-09T12:00:00Z", { intent: "note" })
        const c = chat("c1", "2026-11-09T10:00:00Z")
        expect(splitChat([note, c])).toEqual({ comments: [note], chats: [c] })
        expect(splitChat(undefined)).toEqual({ comments: [], chats: [] })
    })
})
