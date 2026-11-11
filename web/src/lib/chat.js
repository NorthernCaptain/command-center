/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// The task chat. Every message from the chat bar is a comment thread
// (intent "chat") and the center agent's answer is a reply on it, so the
// whole conversation is the task's chat threads in order (the Chat tab).
// The reply panel above the chat input survives leaving the page: the
// assist job that answers a thread names it (job.comment_id), so the latest
// exchange is found again on load. A panel Leo closed stays closed on this
// device.

/** How long the last chat exchange is shown again on load. */
export const CHAT_RESTORE_MS = 24 * 60 * 60 * 1000

const KEY = (taskId) => `cc.chat.closed.${taskId}`

/** A thread Leo started from the chat bar. */
export function isChatThread(t) {
    return Boolean(
        t && t.intent === "chat" && !t.parent_id && t.author === "me"
    )
}

/** The task chat, oldest first. */
export function chatThreads(threads) {
    return (threads || [])
        .filter(isChatThread)
        .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))
}

/**
 * Split the task's threads: { comments } (everything else, in order) and
 * { chats } (the chat, oldest first).
 */
export function splitChat(threads) {
    const all = threads || []
    return {
        comments: all.filter((t) => !isChatThread(t)),
        chats: chatThreads(all),
    }
}

/**
 * The latest chat request on the task with the job answering it, when it
 * is recent: { job, prompt } or null.
 */
export function latestChat(comments, jobs, now = Date.now()) {
    const last = chatThreads(comments).at(-1)
    if (!last) return null
    const at = Date.parse(last.at)
    if (!Number.isFinite(at) || now - at > CHAT_RESTORE_MS) return null
    // jobs come newest first: the latest run for that thread
    const job = (jobs || []).find((j) => j && j.comment_id === last.id)
    return job ? { job, prompt: last.body } : null
}

/** Job id of the chat panel closed on this device for the task, or null. */
export function closedChat(taskId) {
    try {
        return window.localStorage.getItem(KEY(taskId))
    } catch {
        return null
    }
}

/** Remember that the panel for `jobId` was closed (best effort). */
export function rememberClosedChat(taskId, jobId) {
    try {
        window.localStorage.setItem(KEY(taskId), String(jobId))
    } catch {
        // storage blocked: it just shows again next time
    }
}

const DRAFT_KEY = (taskId) => `cc.chatDraft.${taskId}`

/** The unsent chat text saved on this device for the task ("" if none). */
export function chatDraft(taskId) {
    try {
        return window.localStorage.getItem(DRAFT_KEY(taskId)) || ""
    } catch {
        return ""
    }
}

/** Save (or, when empty, forget) the unsent chat text (best effort). */
export function saveChatDraft(taskId, text) {
    try {
        if (text && text.trim())
            window.localStorage.setItem(DRAFT_KEY(taskId), text)
        else window.localStorage.removeItem(DRAFT_KEY(taskId))
    } catch {
        // storage blocked: the draft lives only while the page is open
    }
}
