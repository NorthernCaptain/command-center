/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { isLiveAgent } from "../components/AgentChip.jsx"
import ArtifactEditor from "../components/ArtifactEditor.jsx"
import ArtifactView from "../components/ArtifactView.jsx"
import FileViewer from "../components/FileViewer.jsx"
import FilesPanel from "../components/FilesPanel.jsx"
import { fileEntry, pastedFile } from "../lib/files.js"
import { allLinks, withLinksSection } from "../lib/links.js"
import { withFeedbackSection } from "../lib/feedback.js"
import {
    closedChat,
    latestChat,
    rememberClosedChat,
    splitChat,
} from "../lib/chat.js"
import ChatBar from "../components/ChatBar.jsx"
import ChatPanel from "../components/ChatPanel.jsx"
import CommentsPanel from "../components/CommentsPanel.jsx"
import HistoryDrawer from "../components/HistoryDrawer.jsx"
import JobChips from "../components/JobChips.jsx"
import JobPanel from "../components/JobPanel.jsx"
import Link from "../components/Link.jsx"
import SelectionPopover from "../components/SelectionPopover.jsx"
import { EmptyState, SkeletonDoc } from "../components/Skeleton.jsx"
import TaskHeader from "../components/TaskHeader.jsx"
import useDockHeight from "../lib/useDockHeight.js"
import {
    ActivityList,
    LinksList,
    SchedulesPanel,
} from "../components/TaskSidePanels.jsx"
import {
    AgentPanel,
    DeliverablesPanel,
    FeedbackPanel,
    ReviewsPanel,
} from "../components/WorkerPanels.jsx"
import { WORKER_KIND_LABELS } from "../components/StartAgent.jsx"
import { useApp } from "../components/AppContext.jsx"
import { useToast } from "../components/Toasts.jsx"
import { api, errorMessage } from "../lib/api.js"
import { taskKey } from "../lib/constants.js"
import { doneMessage } from "../lib/done.js"
import { upsertById, upsertComment, upsertJob, useTask } from "../lib/hooks.js"
import {
    hasConflictMarkers,
    normalizeEol,
    threeWayMerge,
} from "../lib/merge.js"
import { snoozeTask } from "../lib/snooze.js"
import {
    blockingDeliverables,
    changeRecordBlocker,
    actionToast,
    pollError,
    visibleTabs,
    workerError,
} from "../lib/worker.js"
import { formatDue } from "../lib/time.js"

const SKIPPED_NOTICE = {
    pending: "Brain is still on it",
    already_posted: "Already posted",
    no_brain: "Brain is not configured",
    no_slack: "This task has no Slack thread",
    no_asana: "This task has no Asana task yet",
}

function sameIds(a, b) {
    return (
        a.length === b.length && a.every((x, i) => String(x) === String(b[i]))
    )
}

export default function TaskPage({ id }) {
    const { isOwner, features } = useApp()
    const toast = useToast()
    const { data, setData, deltas, error, loading, hidden, reload } =
        useTask(id)
    const [tab, setTab] = useState("comments")
    const [sheetOpen, setSheetOpen] = useState(false)
    // the last chat request and its live reply, shown above the chat input
    const [chat, setChat] = useState(null)
    // chat jobs closed from the panel don't come back as chips (the one in
    // the panel isn't a chip either; a replaced, still running one is)
    const closedChatJobs = useRef(new Set())
    const [historyOpen, setHistoryOpen] = useState(false)
    const [editing, setEditing] = useState(null)
    const [orphans, setOrphans] = useState([])
    // attachments: the file shown in the viewer, uploads in flight, and a
    // drag with files over the page
    const [viewing, setViewing] = useState(null)
    const [uploading, setUploading] = useState(0)
    const [dropping, setDropping] = useState(false)
    const uploadRef = useRef(null)
    // a pasted screenshot (or copied file) outside text fields is attached
    useEffect(() => {
        if (!isOwner) return undefined
        const onPaste = (e) => {
            const t = e.target
            if (
                t &&
                t.closest &&
                t.closest("input, textarea, [contenteditable='true']")
            )
                return
            const list = [...((e.clipboardData && e.clipboardData.files) || [])]
            if (!list.length || !uploadRef.current) return
            e.preventDefault()
            uploadRef.current(
                list.map((f) =>
                    !f.name || /^image\.[a-z0-9]+$/i.test(f.name)
                        ? pastedFile(f)
                        : f
                )
            )
        }
        document.addEventListener("paste", onPaste)
        return () => document.removeEventListener("paste", onPaste)
    }, [isOwner])
    // Focused thread; n bumps on every explicit focus so the artifact
    // scrolls to it again even when it is already the active one.
    const [focus, setFocus] = useState({ id: null, n: 0 })
    const activeId = focus.id
    const focusThread = useCallback(
        (cid) => setFocus((f) => ({ id: cid, n: f.n + 1 })),
        []
    )
    const artifactRef = useRef(null)
    // Latest editor state for async handlers (⌘S / Save) and a re-entry
    // guard that flips synchronously, before React re-renders.
    const editingRef = useRef(editing)
    editingRef.current = editing
    const savingRef = useRef(false)

    const onOrphans = useCallback(
        (ids) => setOrphans((prev) => (sameIds(prev, ids) ? prev : ids)),
        []
    )
    const closeHistory = useCallback(() => setHistoryOpen(false), [])
    // the dock grows with the chat reply: the page reserves its real height
    const dockRef = useRef(null)
    useDockHeight(dockRef, Boolean(isOwner && data && !hidden))
    // back on the page: the latest chat exchange (saved as a comment thread
    // and its assist job) shows again unless it was closed here
    const chatFor = useRef(null)
    // the chat bar's threads are the Chat tab, the rest are comments (kept
    // stable: the artifact re-highlights when its threads change)
    const comments = data ? data.comments : null
    const { comments: threads, chats } = useMemo(
        () => splitChat(comments),
        [comments]
    )
    const loadedId = data && data.task ? String(data.task.id) : null
    useEffect(() => {
        if (!isOwner || !loadedId || chatFor.current === loadedId) return
        chatFor.current = loadedId
        const last = latestChat(data.comments, data.jobs)
        if (last && closedChat(loadedId) === last.job.id) {
            closedChatJobs.current.add(last.job.id)
            setChat(null)
        } else setChat(last)
    }, [isOwner, loadedId, data])

    if (hidden) {
        return (
            <div className="page task">
                <EmptyState title="This task is no longer shared" glyph="◌">
                    <p>The owner made it private.</p>
                    <Link to="/" className="btn btn-ghost">
                        Back to board
                    </Link>
                </EmptyState>
            </div>
        )
    }
    if (loading && !data) {
        return (
            <div className="page task">
                <SkeletonDoc />
            </div>
        )
    }
    if (error && !data) {
        return (
            <div className="page task">
                <EmptyState
                    title={
                        error.status === 404
                            ? `${taskKey(id)} not found`
                            : "Can't load this task"
                    }
                    glyph="!"
                >
                    <p>
                        {error.status === 404
                            ? "It may be private or deleted."
                            : errorMessage(error)}
                    </p>
                    <div className="row-gap">
                        {error.status !== 404 ? (
                            <button
                                type="button"
                                className="btn"
                                onClick={reload}
                            >
                                Retry
                            </button>
                        ) : null}
                        <Link to="/" className="btn btn-ghost">
                            Back to board
                        </Link>
                    </div>
                </EmptyState>
            </div>
        )
    }

    if (!data) {
        // e.g. between a state change and the reload that brings data back
        return (
            <div className="page task">
                <SkeletonDoc />
            </div>
        )
    }

    const { task, artifact } = data
    // source link (e.g. the Slack thread) + task links, for the tab and doc
    const links = allLinks(task)
    const openCount = threads.filter((t) => t.status !== "resolved").length
    const tabs = visibleTabs(data, features)
    const currentTab = tabs.some((t) => t.id === tab) ? tab : "comments"
    const openFeedback = (data.feedback || []).filter(
        (f) => f.status === "open"
    ).length
    const agentLive = Boolean(features.workers) && isLiveAgent(data.agent)
    const tabCount = {
        comments: openCount,
        feedback: openFeedback,
        // deliverables that keep the task from Done
        files: (data.files || []).length,
        deliverables:
            blockingDeliverables(task, data.prs).length +
            (changeRecordBlocker(data.change_record) ? 1 : 0),
    }

    async function uploadFiles(list) {
        setUploading((n) => n + list.length)
        let ok = 0
        for (const f of list) {
            try {
                await api.uploadFile(id, f)
                ok++
            } catch (err) {
                toast.error(err)
            } finally {
                setUploading((n) => n - 1)
            }
        }
        if (ok) {
            toast.success(
                list.length === 1
                    ? `Attached ${list[0].name}`
                    : `Attached ${ok} of ${list.length} files`
            )
            reload()
        }
    }
    uploadRef.current = uploadFiles

    async function deleteFile(f) {
        try {
            await api.deleteFile(id, f.name)
            toast.success(`Deleted ${f.label || f.name}`)
            reload()
        } catch (err) {
            toast.error(err)
            throw err
        }
    }

    const filesBase = `/api/tasks/${encodeURIComponent(id)}/files/`
    const openFile = (name) => setViewing(fileEntry(data.files, name))
    const dragHasFiles = (e) =>
        [...((e.dataTransfer && e.dataTransfer.types) || [])].includes("Files")
    const dropProps = isOwner
        ? {
              onDragOver: (e) => {
                  if (!dragHasFiles(e)) return
                  e.preventDefault()
                  if (!dropping) setDropping(true)
              },
              onDragLeave: (e) => {
                  if (!e.currentTarget.contains(e.relatedTarget))
                      setDropping(false)
              },
              onDrop: (e) => {
                  setDropping(false)
                  // the Files tab's drop zone already took it
                  if (e.defaultPrevented || !dragHasFiles(e)) return
                  e.preventDefault()
                  const dropped = [...e.dataTransfer.files]
                  if (dropped.length) uploadFiles(dropped)
              },
          }
        : {}

    function addJob(job) {
        if (job)
            setData((prev) => ({ ...prev, jobs: upsertJob(prev.jobs, job) }))
    }

    async function patch(p) {
        try {
            const res = await api.patchTask(id, p, data.revision)
            setData((prev) => ({
                ...prev,
                task: res.task || prev.task,
                revision: res.revision || prev.revision,
            }))
            if (res.job) addJob(res.job)
            if (res.close_out) toast.info(doneMessage(id, res))
        } catch (err) {
            if (err.isStale) {
                toast.info("The task changed meanwhile. Reloaded, try again.")
                reload()
            } else toast.error(err)
        }
    }

    async function snooze(choice) {
        try {
            const res = await snoozeTask(api, task, choice)
            setData((prev) => ({
                ...prev,
                task: res.task || prev.task,
                revision: res.revision || prev.revision,
            }))
            toast.success(
                res.at ? `Snoozed until ${formatDue(res.at)}` : "Snoozed"
            )
        } catch (err) {
            toast.error(err)
            throw err
        }
    }

    async function runJob(fn, label) {
        try {
            const res = await fn(id)
            addJob(res && res.job)
            toast.info(label)
        } catch (err) {
            toast.error(err)
        }
    }

    // --- worker agent / PRs (phase 2) ---------------------------------------
    async function startAgent(kind, repo) {
        try {
            // a task without repos gets the picked one as its main repo;
            // the saved task is applied at once, so a failed start leaves
            // the repo assigned and a retry goes straight to start
            if (repo) {
                const res = await api.patchTask(
                    id,
                    { repos: [{ name: repo, role: "main" }] },
                    data.revision
                )
                setData((prev) => ({
                    ...prev,
                    task: (res && res.task) || prev.task,
                    revision: (res && res.revision) || prev.revision,
                }))
            }
            await api.startTask(id, { kind })
            toast.info(`Starting ${WORKER_KIND_LABELS[kind] || kind}…`)
            reload()
        } catch (err) {
            toast.error(workerError(err))
        }
    }

    function showActionToast(name, res) {
        const shown = actionToast(name, res)
        toast[shown.kind](shown.text)
        return shown
    }

    async function workerAction(name, body) {
        try {
            const res = await api.taskAction(id, name, body)
            showActionToast(name, res)
            reload()
        } catch (err) {
            toast.error(workerError(err))
        }
    }

    async function pollPrs() {
        try {
            const failed = pollError(await api.pollPrs(id))
            if (failed) toast.error(failed)
            else toast.success("PRs checked")
            reload()
        } catch (err) {
            toast.error(err)
        }
    }

    // the Asana link in the task's Slack thread: post (again) / ask Brain now
    async function slackNotice(action) {
        try {
            const call = {
                check: api.checkSlackNotice,
                dismiss: api.dismissSlackNotice,
                post: api.postSlackNotice,
            }[action]
            const res = await call(id)
            if (res && res.slack_notice !== undefined)
                setData((prev) => ({ ...prev, slack_notice: res.slack_notice }))
            const r = (res && res.result) || {}
            if (action === "post") {
                if (r.started)
                    toast.success("Asked Brain to post in the Slack thread")
                else if (r.error) toast.error(`Brain: ${r.error}`)
                else if (r.skipped)
                    toast.info(SKIPPED_NOTICE[r.skipped] || r.skipped)
            }
            reload()
        } catch (err) {
            toast.error(err)
            throw err
        }
    }

    async function noChange(repo) {
        try {
            const res = await api.setDeliverable(id, repo, "no_change")
            if (res && res.task)
                setData((prev) => ({ ...prev, task: res.task }))
            toast.success(`${repo}: no change`)
            reload()
        } catch (err) {
            toast.error(err)
            throw err
        }
    }

    async function claim(url) {
        let res
        try {
            res = await api.claimPr(id, url)
        } catch (err) {
            toast.error(err)
            throw err
        }
        if (res && res.ok === false) {
            toast.error(`Not claimed: ${res.reason || "rejected"}`)
            throw new Error(res.reason || "not claimed")
        }
        toast.success("PR claimed")
        reload()
    }

    async function reopenFeedback(item) {
        try {
            await api.reopenFeedback(id, item.id)
            toast.success("Feedback reopened")
            reload()
        } catch (err) {
            toast.error(err)
            throw err
        }
    }

    async function cancelJob(job) {
        try {
            await api.cancelJob(job.id)
        } catch (err) {
            toast.error(err)
        }
    }

    async function postComment(payload) {
        try {
            const res = await api.addComment(id, payload)
            if (res && res.comment) {
                setData((prev) => ({
                    ...prev,
                    comments: upsertComment(prev.comments, res.comment),
                }))
            }
            addJob(res && res.job)
            return res
        } catch (err) {
            toast.error(err)
            throw err
        }
    }

    async function onSelectionSubmit({ intent, body, anchor }) {
        if (intent === "agent") {
            let res
            try {
                res = await api.taskAction(id, "send", {
                    text: body,
                    quote: anchor && anchor.exact,
                })
            } catch (err) {
                toast.error(workerError(err))
                throw err
            }
            const shown = showActionToast("send", res)
            reload()
            // keep the draft when it did not reach the agent
            if (shown.kind === "error") throw new Error(shown.text)
            return
        }
        const res = await postComment({ intent, body, anchor })
        setTab("comments")
        if (res && res.comment) focusThread(res.comment.id)
    }

    async function setCommentStatus(thread, status) {
        try {
            const res = await api.setCommentStatus(id, thread.id, status)
            const comment = (res && res.comment) || { ...thread, status }
            setData((prev) => ({
                ...prev,
                comments: upsertComment(prev.comments, comment),
            }))
        } catch (err) {
            toast.error(err)
        }
    }

    // --- artifact editing ---------------------------------------------------
    // editing = { text, baseRevision, baseContent, conflict, saving, note,
    //             mine } where `mine` is my text from before a merge or
    //             overwrite decision, restorable until a save succeeds.
    function startEdit() {
        // Edit in LF: the textarea normalizes line ends anyway.
        const content = normalizeEol(artifact.content)
        setEditing({
            text: content,
            baseRevision: artifact.revision,
            baseContent: content,
            conflict: null,
            saving: false,
            note: null,
            mine: null,
        })
    }

    async function saveEdit() {
        const cur = editingRef.current
        // ⌘S can fire while a save is in flight or a conflict is open.
        if (!cur || cur.saving || cur.conflict || savingRef.current) return
        if (hasConflictMarkers(cur.text)) {
            setEditing((e) =>
                e
                    ? {
                          ...e,
                          note: "Resolve the <<<<<<< mine / >>>>>>> current conflict blocks before saving.",
                      }
                    : e
            )
            return
        }
        const sent = cur.text
        const base = cur.baseRevision
        savingRef.current = true
        setEditing((e) => (e ? { ...e, saving: true } : e))
        try {
            const res = await api.putArtifact(id, sent, base)
            const revision = (res && res.revision) || null
            setData((prev) => ({
                ...prev,
                artifact: {
                    content: sent,
                    revision: revision || prev.artifact.revision,
                },
            }))
            // Keep anything typed while the request was in flight.
            setEditing((e) => {
                if (!e || e.text === sent) return null
                return {
                    ...e,
                    saving: false,
                    baseRevision: revision || e.baseRevision,
                    baseContent: sent,
                    mine: null,
                    note: "Saved. Edits made while saving are not saved yet.",
                }
            })
            toast.success("Artifact saved")
        } catch (err) {
            if (err.isStale) {
                let conflict = err.current
                if (!conflict || typeof conflict.content !== "string") {
                    try {
                        const fresh = await api.getTask(id)
                        conflict = fresh.artifact
                    } catch {
                        conflict = { content: "", revision: null }
                    }
                }
                setEditing((e) => (e ? { ...e, saving: false, conflict } : e))
            } else {
                toast.error(err)
                setEditing((e) => (e ? { ...e, saving: false } : e))
            }
        } finally {
            savingRef.current = false
        }
    }

    function reloadFromConflict() {
        const c = editing.conflict
        setData((prev) => ({
            ...prev,
            artifact: { content: c.content, revision: c.revision },
        }))
        setEditing(null)
    }

    function mergeConflict() {
        setEditing((e) => {
            const c = e.conflict
            const merged = threeWayMerge(e.baseContent, e.text, c.content)
            return {
                ...e,
                text: merged.text,
                baseRevision: c.revision,
                baseContent: c.content,
                conflict: null,
                saving: false,
                mine: e.mine || e.text,
                note: merged.clean
                    ? "Merged onto the latest revision. Review and save."
                    : `${merged.conflicts} conflicting block(s) kept both versions between <<<<<<< mine and >>>>>>> current. Edit them, then save.`,
            }
        })
    }

    function keepMine() {
        setEditing((e) => ({
            ...e,
            baseRevision: e.conflict.revision,
            baseContent: e.conflict.content,
            conflict: null,
            mine: e.mine || e.text,
            note: "Saving will overwrite the latest revision with your text.",
        }))
    }

    function restoreMine() {
        setEditing((e) => ({
            ...e,
            text: e.mine,
            note: "Restored your text. Saving will overwrite the latest revision.",
        }))
    }

    const panel =
        currentTab === "comments" ? (
            <CommentsPanel
                threads={threads}
                orphanIds={orphans}
                activeId={activeId}
                onFocus={(cid) => {
                    focusThread(cid)
                    setSheetOpen(false)
                }}
                onReply={(thread, body, intent = "note") =>
                    postComment({ body, intent, parent_id: thread.id })
                }
                onStatus={setCommentStatus}
            />
        ) : currentTab === "chat" ? (
            <ChatPanel threads={chats} />
        ) : currentTab === "agent" ? (
            <AgentPanel
                agent={data.agent}
                outbox={data.outbox}
                task={task}
                onAction={workerAction}
            />
        ) : currentTab === "deliverables" ? (
            <DeliverablesPanel
                deliverables={task.deliverables}
                prs={data.prs}
                changeRecord={data.change_record}
                candidates={data.pr_candidates}
                onNoChange={noChange}
                onClaim={claim}
            />
        ) : currentTab === "feedback" ? (
            <FeedbackPanel feedback={data.feedback} onReopen={reopenFeedback} />
        ) : currentTab === "reviews" ? (
            <ReviewsPanel reviews={data.reviews} />
        ) : currentTab === "activity" ? (
            <ActivityList events={data.events} />
        ) : currentTab === "schedules" ? (
            <SchedulesPanel
                schedules={data.schedules}
                onAdd={async (input) => {
                    try {
                        const res = await api.addSchedule(id, input)
                        if (res && res.schedule) {
                            setData((prev) => ({
                                ...prev,
                                schedules: upsertById(
                                    prev.schedules,
                                    res.schedule
                                ),
                            }))
                        }
                        toast.success("Follow-up scheduled")
                    } catch (err) {
                        toast.error(err)
                        throw err
                    }
                }}
                onCancel={async (s) => {
                    try {
                        await api.deleteSchedule(s.id)
                        setData((prev) => ({
                            ...prev,
                            schedules: upsertById(prev.schedules, {
                                ...s,
                                status: "cancelled",
                            }),
                        }))
                    } catch (err) {
                        toast.error(err)
                    }
                }}
            />
        ) : currentTab === "files" ? (
            <FilesPanel
                taskId={id}
                files={data.files}
                uploading={uploading}
                canEdit={isOwner}
                onUpload={uploadFiles}
                onOpen={(f) => setViewing(f)}
                onDelete={deleteFile}
            />
        ) : (
            <LinksList links={links} taskId={id} onOpenFile={openFile} />
        )

    return (
        <div
            className={`page task${isOwner ? " is-owner" : " is-viewer"}${dropping ? " is-dropping" : ""}`}
            {...dropProps}
        >
            <nav className="crumbs">
                <Link to="/">← Board</Link>
            </nav>
            <TaskHeader
                task={task}
                isOwner={isOwner}
                agent={data.agent}
                features={features}
                onStart={startAgent}
                onAction={workerAction}
                onPollPrs={pollPrs}
                onPatch={patch}
                onSnooze={snooze}
                onAsana={() =>
                    runJob(api.createAsana, "Creating the Asana task…")
                }
                onEnrich={() => runJob(api.enrich, "Re-enriching…")}
                onCloseOut={() => runJob(api.closeOut, "Closing out…")}
                onHistory={() => setHistoryOpen(true)}
                slackNotice={data.slack_notice || null}
                onSlackPost={() => slackNotice("post")}
                onSlackCheck={() => slackNotice("check")}
                onSlackDismiss={() => slackNotice("dismiss")}
            />

            <div className="task-body">
                <section className="task-main" aria-label="Artifact">
                    {isOwner ? (
                        <div className="doc-toolbar">
                            <span className="doc-rev">
                                rev <code>{artifact.revision || "—"}</code>
                            </span>
                            {editing ? null : (
                                <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    onClick={startEdit}
                                >
                                    Edit
                                </button>
                            )}
                        </div>
                    ) : null}
                    {editing ? (
                        <ArtifactEditor
                            editing={editing}
                            onChange={(text) =>
                                setEditing((e) => ({ ...e, text }))
                            }
                            onSave={saveEdit}
                            onCancel={() => setEditing(null)}
                            onReload={reloadFromConflict}
                            onMerge={mergeConflict}
                            onKeepMine={keepMine}
                            onRestoreMine={restoreMine}
                        />
                    ) : (
                        <ArtifactView
                            rootRef={artifactRef}
                            content={withFeedbackSection(
                                // attachments have their own section
                                withLinksSection(
                                    artifact.content,
                                    links.filter((l) => l.type !== "file")
                                ),
                                data.feedback
                            )}
                            filesBase={filesBase}
                            onOpenFile={openFile}
                            threads={isOwner ? threads : []}
                            activeId={activeId}
                            focusKey={focus.n}
                            onOrphans={onOrphans}
                            onMarkClick={(cid) => {
                                focusThread(cid)
                                setTab("comments")
                                setSheetOpen(true)
                            }}
                        />
                    )}
                    {isOwner && !editing ? (
                        <SelectionPopover
                            rootRef={artifactRef}
                            agentLive={agentLive}
                            onSubmit={onSelectionSubmit}
                        />
                    ) : null}
                </section>

                {isOwner ? (
                    <aside
                        className={`side${sheetOpen ? " is-open" : ""}`}
                        aria-label="Task panels"
                    >
                        <div className="sheet-bar">
                            <span className="sheet-grip" aria-hidden="true" />
                            <button
                                type="button"
                                className="icon-btn sheet-close"
                                aria-label="Close panel"
                                onClick={() => setSheetOpen(false)}
                            >
                                ×
                            </button>
                        </div>
                        <div className="side-tabs" role="tablist">
                            {tabs.map((t) => (
                                <button
                                    key={t.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={currentTab === t.id}
                                    className={`side-tab${currentTab === t.id ? " is-current" : ""}`}
                                    onClick={() => setTab(t.id)}
                                >
                                    {t.label}
                                    {tabCount[t.id] ? (
                                        <span className="lane-count">
                                            {tabCount[t.id]}
                                        </span>
                                    ) : null}
                                </button>
                            ))}
                        </div>
                        <div className="side-body" role="tabpanel">
                            {panel}
                        </div>
                    </aside>
                ) : null}
            </div>

            {isOwner ? (
                <div className="dock" ref={dockRef}>
                    {chat ? (
                        <JobPanel
                            key={chat.job.id}
                            job={chat.job}
                            prompt={chat.prompt}
                            className="dock-reply"
                            onCancel={cancelJob}
                            onMore={() => {
                                setTab("chat")
                                setSheetOpen(true)
                            }}
                            moreLabel="Full chat"
                            onClose={() => {
                                closedChatJobs.current.add(chat.job.id)
                                rememberClosedChat(loadedId, chat.job.id)
                                setChat(null)
                            }}
                        />
                    ) : null}
                    <JobChips
                        jobs={(data.jobs || []).filter(
                            (j) =>
                                !(chat && j.id === chat.job.id) &&
                                !closedChatJobs.current.has(j.id)
                        )}
                        deltas={deltas}
                        onCancel={cancelJob}
                    />
                    <div className="dock-row">
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm dock-comments"
                            onClick={() => setSheetOpen(true)}
                            aria-label={`Open comments (${openCount})`}
                        >
                            ☰ <span className="lane-count">{openCount}</span>
                        </button>
                        <ChatBar
                            onSend={async (body) => {
                                const res = await postComment({
                                    body,
                                    intent: "chat",
                                })
                                if (res && res.job)
                                    setChat({ job: res.job, prompt: body })
                            }}
                        />
                    </div>
                </div>
            ) : null}

            {isOwner ? (
                <HistoryDrawer
                    taskId={id}
                    open={historyOpen}
                    onClose={closeHistory}
                />
            ) : null}
            {sheetOpen ? (
                <button
                    type="button"
                    className="scrim scrim-sheet"
                    aria-label="Close panel"
                    onClick={() => setSheetOpen(false)}
                />
            ) : null}
            {viewing ? (
                <FileViewer
                    taskId={id}
                    file={viewing}
                    onClose={() => setViewing(null)}
                />
            ) : null}
            {dropping ? (
                <div className="drop-hint" aria-hidden="true">
                    Drop to attach to {taskKey(id)}
                </div>
            ) : null}
        </div>
    )
}
