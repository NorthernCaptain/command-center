/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Task families: a spin-off points at its parent with a "doc" link to
// "/t/<parent>" (role "parent"), and the parent lists each spin-off with a
// link to "/t/<child>" (role "spin_off"). Spin-offs made before the roles
// existed carry only the parent link, labelled "spun off from T-<n>".

import { taskKey } from "./schemas.js"

export const PARENT_ROLE = "parent"
export const SPIN_OFF_ROLE = "spin_off"

const TASK_URL_RE = /^\/t\/(?:T-)?(\d{1,9})\/?$/i
const LEGACY_PARENT_RE = /^spun off from T-\d+/i

/** "/t/12" | "/t/T-12" -> 12; anything else null. */
export function taskIdOfUrl(url) {
    const m = TASK_URL_RE.exec(String(url || "").trim())
    return m ? Number(m[1]) : null
}

export const taskUrl = (id) => `/t/${id}`

/** Is this link the task's pointer to its parent? */
export function isParentLink(l) {
    if (!l || taskIdOfUrl(l.url) === null) return false
    return (
        l.role === PARENT_ROLE ||
        (!l.role && LEGACY_PARENT_RE.test(String(l.label || "")))
    )
}

/** The task's parent id, or null. */
export function parentIdOf(task) {
    const l = ((task && task.links) || []).find(isParentLink)
    return l ? taskIdOfUrl(l.url) : null
}

/** Label of a spin-off's parent link (who spun it off, when not the parent). */
export function parentLabel(parentId, fromId = parentId) {
    return fromId && fromId !== parentId
        ? `spun off from ${taskKey(fromId)}, under ${taskKey(parentId)}`
        : `spun off from ${taskKey(parentId)}`
}

/** Label of a parent's link to one spin-off. */
export function spinOffLabel(child) {
    const title = String((child && child.title) || "").trim()
    const key = taskKey(child.id)
    return title ? `${key}: ${title.slice(0, 200)}` : key
}
