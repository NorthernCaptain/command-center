/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// High-level Asana operations for command-center tasks: create in the
// current sprint section, keep the managed tracking block and external link
// attachments in sync, comment and complete.
//
// Duplicate protection for creation: the caller records an intent (nonce)
// before calling createForTask, which writes the marker line
// "Command-Center-Task: T-<id> <nonce>" into the managed block. On a re-run
// (timeout after Asana created the task, restart between POST and the task
// update, update failure) the caller passes the earlier markers and
// createForTask adopts the existing Asana task instead of creating another.
// Lookup: GET /tasks?project=<gid>&modified_since=<intent time - slack>
// with opt_fields=notes. It is a plain list query (works with a PAT, no
// premium search API, no search-index lag) and modified_since keeps it to the
// handful of tasks touched since the intent. A failed POST is never taken as
// "not created": the marker lookup runs before the error is re-thrown.

import { taskKey } from "../../contracts/schemas.js"
import { ValidationError } from "../../util/errors.js"
import { systemClock } from "../../util/clock.js"
import {
    buildDescriptionHtml,
    buildTrackingBlockHtml,
    collectRefs,
    mergeManagedBlock,
} from "./asanaNotes.js"
import { pickSection } from "./sprintSection.js"
import { asanaStatusKey } from "./asanaNotes.js"

export const SECTION_CACHE_MS = 24 * 60 * 60 * 1000
/** Clock-skew slack subtracted from the intent time for modified_since. */
export const MARKER_LOOKBACK_MS = 10 * 60 * 1000

/** Idempotency marker written into the Asana notes at creation. */
export function creationMarker(taskId, nonce) {
    return `Command-Center-Task: ${taskKey(taskId)} ${nonce}`
}

function notesHaveMarker(notes, marker) {
    const text = String(notes || "")
    let idx = text.indexOf(marker)
    while (idx >= 0) {
        const next = text.charAt(idx + marker.length)
        if (!next || /\s/.test(next)) return true
        idx = text.indexOf(marker, idx + 1)
    }
    return false
}

function assertGid(gid) {
    if (typeof gid !== "string" || !/^\d+$/.test(gid)) {
        throw new ValidationError("invalid Asana gid", { gid })
    }
    return gid
}

/**
 * Task gid from an Asana URL ("/0/<project>/<task>[/f]",
 * "/1/<ws>/project/<p>/task/<task>", "/1/<ws>/task/<task>"), or null.
 */
export function parseAsanaTaskGid(url) {
    let u
    try {
        u = new URL(String(url))
    } catch {
        return null
    }
    if (!/(^|\.)asana\.com$/i.test(u.hostname)) return null
    const parts = u.pathname.split("/").filter(Boolean)
    const taskIdx = parts.indexOf("task")
    if (taskIdx >= 0)
        return /^\d+$/.test(parts[taskIdx + 1]) ? parts[taskIdx + 1] : null
    if (parts[0] === "0" && /^\d+$/.test(parts[2] || "")) return parts[2]
    return null
}

/**
 * @param {{ client: { request: Function, list: Function },
 *           config: { projectGid: string, assigneeGid?: string },
 *           clock?: object, publicBaseUrl?: string|null|(() => string|null), log?: object,
 *           timeZone?: string, sectionCacheMs?: number }} deps
 */
export function createAsanaService({
    client,
    config,
    clock = systemClock,
    publicBaseUrl = null,
    log,
    timeZone,
    sectionCacheMs = SECTION_CACHE_MS,
    githubOrg = null,
} = {}) {
    let sectionCache = null // { at: ms, sections }
    // publicBaseUrl may be a string or a getter (the tailnet URL can be
    // detected after startup), so resolve it on every use.
    function baseUrl() {
        const v =
            typeof publicBaseUrl === "function"
                ? publicBaseUrl()
                : publicBaseUrl
        return v ? String(v).replace(/\/+$/, "") : null
    }

    /**
     * { field, option } gids of the Asana "Status" value for the task, or
     * null (status not mapped, or config.statusField not set).
     */
    function statusValue(task) {
        const sf = config.statusField
        const key = asanaStatusKey(task && task.status)
        const option = key && sf && sf.options && sf.options[key]
        return sf && sf.gid && option
            ? { field: String(sf.gid), option: String(option) }
            : null
    }

    function artifactUrlFor(task) {
        const base = baseUrl()
        return base && task?.id ? `${base}/t/${task.id}` : null
    }

    /** @returns {Promise<{ sections: object[], cached: boolean }>} */
    async function listSections({ force = false } = {}) {
        const now = clock.now().getTime()
        if (!force && sectionCache && now - sectionCache.at < sectionCacheMs) {
            return { sections: sectionCache.sections, cached: true }
        }
        const sections = await client.list(
            `/projects/${assertGid(config.projectGid)}/sections`,
            { query: { opt_fields: "name" } }
        )
        sectionCache = { at: now, sections }
        return { sections, cached: false }
    }

    /**
     * On a miss with a cached list, refetch once (bypassing the cache): this
     * week's section is often created after the list was cached.
     * @returns {Promise<{gid: string, name: string} | null>}
     */
    async function resolveSprintSection(date = clock.now()) {
        const first = await listSections()
        let picked = pickSection(first.sections, date)
        if (!picked && first.cached) {
            picked = pickSection(
                (await listSections({ force: true })).sections,
                date
            )
        }
        return picked ? { gid: picked.gid, name: picked.name } : null
    }

    /** Attachments the task should have: [{ url, name }]. */
    function desiredAttachments(task) {
        const out = []
        const artifactUrl = artifactUrlFor(task)
        if (artifactUrl) {
            out.push({
                url: artifactUrl,
                name: `Command Center ${taskKey(task.id)}`,
            })
        }
        const { branches, prs } = collectRefs(task, { org: githubOrg })
        for (const b of branches) {
            out.push({
                url: b.url,
                name: b.repo ? `${b.repo} @ ${b.branch}` : b.branch,
            })
        }
        for (const p of prs) out.push({ url: p.url, name: `PR ${p.label}` })
        return out
    }

    /** Add external link attachments that are not yet tracked. */
    async function addMissingAttachments(gid, task) {
        return (await addAttachments(gid, task)).have
    }

    /**
     * Same, also reporting the URLs that could not be attached.
     * @returns {Promise<{ have: string[], failed: string[] }>}
     */
    async function addAttachments(gid, task) {
        const have = [...(task?.asana?.attachments || [])]
        const failed = []
        for (const { url, name } of desiredAttachments(task)) {
            if (have.includes(url)) continue
            try {
                await client.request("POST", "/attachments", {
                    form: {
                        parent: gid,
                        resource_subtype: "external",
                        url,
                        name,
                    },
                })
                have.push(url)
            } catch (err) {
                // The task exists already; a failed link is retried next sync.
                failed.push(url)
                log?.warn?.(
                    { gid, url, err: err?.message },
                    "asana attachment failed"
                )
            }
        }
        return { have, failed }
    }

    /** "https://github.com/<org>/<repo>/tree/<branch>" -> { repo, branch }. */
    function parseBranchUrl(url) {
        const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/(.+)$/.exec(
            String(url)
        )
        if (!m || !githubOrg || m[1].toLowerCase() !== githubOrg.toLowerCase())
            return null
        try {
            return {
                repo: decodeURIComponent(m[2]),
                branch: m[3].split("/").map(decodeURIComponent).join("/"),
            }
        } catch {
            return null
        }
    }

    /**
     * Remove branch links this service attached that the task no longer
     * shows (a deliverable moved to its PR's branch, so the old one was
     * never pushed). Only "<repo> @ <branch>" GitHub tree links for the
     * task's own repos are touched; other attachments, including links Leo
     * or a teammate added, stay. A link no longer on the Asana task is just
     * forgotten.
     * @returns {Promise<{ have: string[], failed: string[] }>}
     */
    async function removeStaleBranches(gid, task, have) {
        const want = new Set(desiredAttachments(task).map((x) => x.url))
        const repos = new Set([
            ...(task.repos || []).map((r) => r && r.name),
            ...(task.deliverables || []).map((d) => d && d.repo),
        ])
        const stale = new Map()
        for (const url of have) {
            if (want.has(url)) continue
            const ref = parseBranchUrl(url)
            if (ref && repos.has(ref.repo))
                stale.set(url, `${ref.repo} @ ${ref.branch}`)
        }
        if (!stale.size) return { have, failed: [] }
        let items
        try {
            items = await client.list("/attachments", {
                query: { parent: gid, opt_fields: "name,view_url" },
            })
        } catch (err) {
            log?.warn?.({ gid, err: err?.message }, "asana attachments list")
            // retry the cleanup on the next sync
            return { have, failed: [...stale.keys()] }
        }
        const gone = new Set()
        const failed = []
        for (const [url, name] of stale) {
            const ours = (items || []).filter(
                (i) => i && i.view_url === url && i.name === name
            )
            let ok = true
            for (const item of ours) {
                try {
                    await client.request("DELETE", `/attachments/${item.gid}`)
                } catch (err) {
                    ok = false
                    log?.warn?.(
                        { gid, url, err: err?.message },
                        "asana attachment delete failed"
                    )
                }
            }
            if (ok) gone.add(url)
            else failed.push(url)
        }
        return { have: have.filter((u) => !gone.has(u)), failed }
    }

    function trackingBlock(task, marker = null) {
        return buildTrackingBlockHtml({
            task,
            artifactUrl: artifactUrlFor(task),
            timeZone,
            marker,
            org: githubOrg,
        })
    }

    /** Attachment URLs already on the Asana task (best effort). */
    async function existingAttachmentUrls(gid) {
        try {
            const items = await client.list("/attachments", {
                query: { parent: gid, opt_fields: "name,view_url" },
            })
            return items.map((a) => a?.view_url).filter(Boolean)
        } catch (err) {
            log?.warn?.({ gid, err: err?.message }, "asana attachments list")
            return []
        }
    }

    /**
     * Find a task in the project whose notes carry one of the markers and
     * that was modified since `since` (ISO). Returns null when none.
     * @returns {Promise<{ gid, url, section_gid } | null>}
     */
    async function findByMarker(markers, since) {
        const list = (markers || []).filter(Boolean)
        if (!list.length) return null
        const query = {
            project: assertGid(config.projectGid),
            opt_fields: "name,notes,permalink_url,memberships.section",
        }
        if (since) query.modified_since = since
        const tasks = await client.list("/tasks", { query })
        const hit = tasks.find((t) =>
            list.some((m) => notesHaveMarker(t?.notes, m))
        )
        if (!hit) return null
        const membership = (hit.memberships || []).find((m) => m?.section)
        return {
            gid: String(hit.gid),
            url: hit.permalink_url ?? null,
            section_gid: membership ? String(membership.section.gid) : null,
        }
    }

    /** Result shape of createForTask for an Asana task that already exists. */
    async function adopt(task, found) {
        const gid = assertGid(found.gid)
        log?.info?.({ task_id: task.id, gid }, "asana task adopted")
        const have = await existingAttachmentUrls(gid)
        const attachments = await addMissingAttachments(gid, {
            ...task,
            asana: {
                ...(task.asana || {}),
                attachments: [...(task?.asana?.attachments || []), ...have],
            },
        })
        return {
            gid,
            url: found.url ?? null,
            section_gid: found.section_gid ?? null,
            no_section: !found.section_gid,
            attachments,
            adopted: true,
        }
    }

    async function findQuietly(markers, since) {
        try {
            return await findByMarker(markers, since)
        } catch (err) {
            log?.warn?.({ err: err?.message }, "asana marker lookup failed")
            return null
        }
    }

    /**
     * Create the Asana task for a command-center task (or adopt the one an
     * earlier attempt created, see the header comment).
     * @param {object} task
     * @param {object} prose { summary, context, acceptance[], approach }
     * @param {{ marker?: string, priorMarkers?: string[],
     *           since?: string }} [opts] marker: written into the new task's
     *   notes. priorMarkers: markers of earlier attempts (searched first).
     *   since: ISO lower bound for the lookup (earliest intent).
     * @returns {Promise<{ gid, url, section_gid, no_section, attachments,
     *                     adopted? }>}
     */
    /**
     * Put a just-created task into the sprint section. The task exists
     * already, so a failure is logged and reported as "no section" rather
     * than failing the whole create (a retry would duplicate it).
     * @returns {Promise<string|null>} the section gid, or null
     */
    async function moveToSection(gid, section) {
        try {
            await client.request(
                "POST",
                `/sections/${assertGid(section.gid)}/addTask`,
                { body: { task: gid } }
            )
            return section.gid
        } catch (err) {
            log?.warn?.(
                { gid, section: section.name, err: err?.message },
                "asana task created but not moved to the sprint section"
            )
            return null
        }
    }

    async function createForTask(task, prose = {}, opts = {}) {
        const { marker = null, priorMarkers = [], since = null } = opts
        if (priorMarkers.length) {
            // Throws when the lookup itself fails: creating blindly could
            // duplicate a task an earlier attempt already made.
            const found = await findByMarker(priorMarkers, since)
            if (found) return adopt(task, found)
        }
        const projectGid = assertGid(config.projectGid)
        const section = await resolveSprintSection()
        const html_notes = mergeManagedBlock(
            buildDescriptionHtml({ prose, sourceUrl: task?.source?.url }),
            trackingBlock(task, marker)
        )
        // Asana needs projects (or workspace/parent) to create a task; the
        // sprint section is set afterwards with POST /sections/{gid}/addTask.
        const body = { name: task.title, html_notes, projects: [projectGid] }
        if (config.assigneeGid) body.assignee = config.assigneeGid
        const status = statusValue(task)
        if (status) body.custom_fields = { [status.field]: status.option }
        let created
        try {
            created = await client.request("POST", "/tasks", {
                query: { opt_fields: "gid,permalink_url" },
                body,
            })
        } catch (err) {
            // A timeout/5xx may still have created the task.
            const found = marker ? await findQuietly([marker], since) : null
            if (found) return adopt(task, found)
            throw err
        }
        const gid = String(created.gid)
        const sectionGid = section ? await moveToSection(gid, section) : null
        log?.info?.(
            {
                task_id: task.id,
                gid,
                section: sectionGid ? section.name : null,
            },
            "asana task created"
        )
        const attachments = await addMissingAttachments(gid, task)
        return {
            gid,
            url: created.permalink_url ?? null,
            section_gid: sectionGid,
            no_section: !sectionGid,
            attachments,
        }
    }

    /**
     * Regenerate the managed block, set the Status custom field, and add
     * missing attachments.
     * @returns {Promise<{ attachments: string[], failed: string[] }>}
     *   attachments: every URL now attached (persist it even when some
     *   failed); failed: URLs to retry (the sync is incomplete).
     */
    async function syncTracking(task) {
        const gid = assertGid(task?.asana?.gid)
        const current = await client.request("GET", `/tasks/${gid}`, {
            query: {
                opt_fields:
                    "html_notes,custom_fields.gid,custom_fields.enum_value.gid",
            },
        })
        const body = {}
        const next = mergeManagedBlock(current?.html_notes, trackingBlock(task))
        if (next !== current?.html_notes) body.html_notes = next
        // the Status custom field follows the task status (when mapped)
        const status = statusValue(task)
        if (status) {
            const field = (current?.custom_fields || []).find(
                (c) => String(c.gid) === status.field
            )
            const now =
                field && field.enum_value ? String(field.enum_value.gid) : null
            if (now !== status.option)
                body.custom_fields = { [status.field]: status.option }
        }
        if (Object.keys(body).length)
            await client.request("PUT", `/tasks/${gid}`, { body })
        const added = await addAttachments(gid, task)
        const removed = await removeStaleBranches(gid, task, added.have)
        return {
            attachments: removed.have,
            failed: [...added.failed, ...removed.failed],
        }
    }

    async function comment(gid, text) {
        return client.request("POST", `/tasks/${assertGid(gid)}/stories`, {
            body: { text: String(text) },
        })
    }

    /** A rich-text comment (Asana `html_text`, built by asanaNotes). */
    async function commentHtml(gid, html) {
        return client.request("POST", `/tasks/${assertGid(gid)}/stories`, {
            body: { html_text: String(html) },
        })
    }

    async function complete(gid) {
        return client.request("PUT", `/tasks/${assertGid(gid)}`, {
            body: { completed: true },
        })
    }

    /** @returns {Promise<{ gid, name, notes, permalink_url, completed }>} */
    async function getTask(gid) {
        const t = await client.request("GET", `/tasks/${assertGid(gid)}`, {
            query: { opt_fields: "name,notes,permalink_url,completed" },
        })
        return {
            gid,
            name: t?.name ?? null,
            notes: t?.notes ?? "",
            permalink_url: t?.permalink_url ?? null,
            completed: Boolean(t?.completed),
        }
    }

    return {
        resolveSprintSection,
        createForTask,
        findByMarker,
        syncTracking,
        comment,
        commentHtml,
        complete,
        getTask,
        artifactUrlFor,
    }
}
