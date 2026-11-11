# 06 — UI, artifact pages and inline comments

## Look & feel: dark, mobile-first

- **Dark mode is the default** and the primary design target. Colors are
  CSS tokens on `:root`. A light theme is optional later, never required.
- **Mobile-first, responsive.** One SPA serves desktop and phone, with no
  separate mobile app. Breakpoints: phone (< 640px, single column), tablet,
  desktop (two-pane task page). Touch targets ≥ 44px, no hover-only
  actions, iOS safe-area insets.
- **Installable PWA** (manifest + icon, standalone display), so it opens
  from the home screen like an app. Web Push comes in phase 3.

## Access: owner edits, tailnet reads

I run `tailscale serve` on this Mac. Anyone on the tailnet who can reach the
port can **read**. Only **I** (Tailscale user `owner@example.com`) can
**create, edit, comment, chat, change status, trigger agents or Asana**.

### Listeners

| Listener | Who reaches it | Identity |
|---|---|---|
| `127.0.0.1:7789` ("tailnet listener") | `tailscale serve --bg --https=8443 http://127.0.0.1:7789` → `https://<mac>.<tailnet>.ts.net:8443`, and technically any local process | `Tailscale-User-Login` header (owner login → owner, other logins → viewer); paired-device cookie optional |
| `127.0.0.1:7788` ("local listener") | local processes: `cc` CLI, herdr worker agents (MCP), my desktop browser | bearer token (agents/CLI) or owner session cookie (browser, bootstrapped by `cc open`) |

**My Tailscale login is enough for owner access** (decided 2026-11-08; the
original design also required a paired device, which left the tailnet
link read-only until I paired). `tailscale serve` sets
`Tailscale-User-Login`; a request carrying `owner@example.com` is owner.
Any other login is a viewer; no header is 401.

- **Accepted trade-off:** both listeners are on loopback, so a local
  process that sends `Tailscale-User-Login: owner@example.com` to 7789 gets
  owner access. Local processes running as me can already read the bearer
  token in `~/.config/command-center/token`, so on a single-user Mac this
  adds little.
- **Paired devices are optional.** `cc pair` (or Settings → Devices) still
  pairs a phone with a 6-digit code and a revocable
  `HttpOnly; Secure; SameSite=Strict` cookie. Push subscriptions made from
  a paired device are tied to it, so revoking the phone stops its pushes.
- Owner writes also check `Origin` against the served host (CSRF).
- The MCP endpoint and token-auth routes are **not mounted** on the tailnet
  listener at all. Never `tailscale funnel`.
- Possible hardening for the spike: whether `tailscale serve` can proxy to
  a unix socket only Tailscale can connect to. That would remove local
  forging entirely and make the headers trustworthy for viewers too.

### Roles

| Role | Who | Can |
|---|---|---|
| **owner** | tailnet listener: login `owner@example.com` (paired-device cookie optional). Local listener: bearer token or owner cookie | everything |
| **viewer** | any other tailnet login (and tagged devices with no user login) | read **shared** tasks: home lists, task pages (the **current** artifact), links, PR/Asana status. No history, comments, chat, capture, buttons or command bar. |
| — | no identity | 401 |

Enforcement is **server-side middleware**, not hidden buttons: every
non-GET route and every agent/Asana/herdr action requires `owner`. The UI
gets the role from `/api/me` and renders read-only (no capture box, no
selection popover, no action bar). The SSE stream for viewers carries only
events for shared tasks, with internal fields stripped.

### What viewers never see

- Tasks that are not **shared**. Rule (decided): **a task is shared when
  it has an Asana task.** Colleagues can see it in Asana anyway, and the
  Asana description links to the artifact page. Everything else
  (reminders, personal todos, tasks not yet in Asana) is private. A
  per-task toggle overrides in either direction (e.g. keep a sensitive
  security task private even though it's in Asana).
- **But a shared task's artifact is shared in full.** Viewers get the whole
  current artifact, including the original capture text the center seeds
  into **Context** (e.g. a pasted Slack message or email). Nothing in the
  artifact is redacted. If the source is sensitive, make the task
  **private** with the visibility toggle (or edit Context first) before it
  gets an Asana task.
- Center-agent chat history and job details, herdr pane output, agent
  names, pane ids, tokens, local paths beyond repo/branch names.
- Comment threads (they're my working notes to the agent). Phase 1:
  owner-only. Could be opened up later.
- **History.** The history drawer reads git commits of the whole task
  folder, including `comments.jsonl` and `events.jsonl`. Old artifact
  revisions may also hold content removed before the task was shared. So
  `/api/tasks/:id/history` is **owner-only**. Viewers only ever get the
  current rendered artifact plus whitelisted `task.json` fields (title,
  status, area, repos/branch, PR and Asana links, and the PR feedback
  summary). A later sanitized viewer
  history, if wanted, would be artifact-only and start at the moment the
  task became shared.

### Phone layout (owner)

```
┌──────────────────────────┐
│ ☰  Command Center   🔍 ⚙ │
│ [+ link or task…      ⏎] │  ← capture box on top; dictation via the OS keyboard
├──────────────────────────┤
│ NOW (4)                  │
│ ⏰ Talk to Ron re 123  ⋯ │  ← swipe right: done · swipe left: snooze
│ ⛔ T-118 agent blocked ⋯ │
│ 🔀 T-115 ready_for_pr [PR]│  ← primary action inline
├──────────────────────────┤
│ Active · PRs · Inbox · … │  ← lane tabs (horizontal scroll)
└──────────────────────────┘
```

- Task page on phone: artifact full width. Comments open as a bottom
  sheet. Chat bar pinned above the keyboard. Long-press selection opens
  the Comment / Ask / Change popover (native selection on iOS Safari).
- Action buttons (Create PR, Address feedback, Snooze, Done) sit in a sticky
  bottom action bar.
- "Open agent" links to herdr-web-ui for that pane (phase 2).
- Viewers get the same layout, read-only.

## Home page (desktop, owner view)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [ + paste a Slack link, or type a task / reminder…                 ⏎ ]  🔍   │
├──────────────────────────────────────────────────────────────────────────────┤
│  NOW                                                                         │
│   ⏰ Talk to Ron about 123                         due 10:00   [done][snooze] │
│   ⛔ T-118 tailscale ACL for QA   agent blocked: approval     [open in herdr] │
│   🔀 T-115 lambda timeout         ready_for_pr · GOOD_TO_GO   [Create PR]     │
│   💬 T-112 tsnet ACL              pr_feedback · 3 new comments · agent on it  │
│   ↩  T-109 SOC2 access review     follow-up fired: "check comments"           │
├──────────────────────────────────────────────────────────────────────────────┤
│  ACTIVE (4)        ● working  ◐ idle  ⛔ blocked                              │
│   T-121 iOS crash on upload         mobile   ● t121-ios-crash     2m ago     │
│   …                                                                          │
│  PRs (3: open · feedback · CI)  ·  READY (3)  ·  INBOX (5, 1 enriching…)     │
│  WAITING (7)  ·  DONE (this week)                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Single capture box. Paste a URL or text; ⏎ creates the task right away,
  and enrichment runs in the background. `Shift+⏎` opens the full form
  (area, flags, due date).
- Filters: area chips, status, source, has-PR. Search box uses FTS (`/`
  focuses it). `Cmd+K` palette for jump-to-task.
- Live: rows update over SSE (agent overlay, enrichment, status).
- Lane pills under Now show one lane at a time. **All** (first pill) is
  Inbox, Active and PRs in one list, in that order, each under a small
  lane header. Each row starts with a dot in its lane's color (Inbox
  blue, Active green, …). The chosen pill is remembered per device.
- Home command bar (same box, prefix `>` or `Cmd+Enter`): talk to the
  center agent about the whole board ("snooze everything waiting on Ron to
  Monday").

## Task page

```
┌──────────────────────────────── T-115 lambda timeout ───────────────────────┐
│ status: active ▾  area: backend  Asana ↗  Slack ↗   [Start] [Open in herdr]│
│ agent: t115-lambda-timeout ● working · aws-lambda--t115-fix-upload…--k7q2 │
│ PRs: —   review: GOOD_TO_GO ↗      [Create PR] [Address feedback] [Clean]  │
│ follow-ups: "check PR comments" in 1h 52m  [+ schedule]                     │
├──────────────────────────────────────────────┬──────────────────────────────┤
│  rendered artifact.md                        │  Comments  (2 open)          │
│                                              │  ┌ "…cold start >10s…"       │
│  ## Summary                                  │  │ me: is this prod only?     │
│  The upload lambda ▓cold start >10s▓ …       │  │ center: prod + staging,    │
│                                              │  │   see CW query ↗ ✓resolved │
│  ## Decisions                                │  └                           │
│  2026-11-07 · agent · raise memory to 1024 …│  Activity                     │
│                                              │  · agent added PR #812        │
│                                              │  · review GOOD_TO_GO          │
├──────────────────────────────────────────────┴──────────────────────────────┤
│  💬 Tell the center agent…  ("add that staging is affected too")       ⏎  │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Chat bar** → `assist` job (intent "chat"), scoped to this task. Its
  reply shows live in a panel above the input (and as a comment). It can
  edit sections, rename the task, and pass my message on to the task's
  herdr agent, verbatim, when it opens with an instruction to the agent
  ("tell the agent to create a PR", "agent: …"); the reply says whether it
  was sent, queued or why not. The latest exchange shows again when I
  come back to the page (for a day) until I close it. Every request and
  reply is kept: the side panel's **Chat** tab (and "Full chat" on the
  reply panel) shows the whole conversation, oldest first; chat threads
  are not repeated in Comments. Each chat job gets the last few exchanges
  (up to 8, about 12k characters), so "add my note" or "update the
  artifact" picks up what was said before, and facts or corrections I
  state (the right repo, extra scope) go into the artifact. "Add this link"
  adds a task link (Links tab and the rendered Links section), only for
  URLs I wrote; the Links and PR feedback sections are never edited as
  text.
- The artifact's **Links** and **PR feedback** sections are filled at
  display time: links from the task, feedback per PR and round (status,
  place, summary, comment / reply links, commit, the agent's note; replies
  that needed no action as a count), headed by "All feedback addressed"
  once every item that needed work is resolved (or how many are open);
  the PR feedback tab shows the same line. The file keeps only
  placeholders.
- **Files**: attach screenshots, videos, .md docs, PDFs and other files
  with the Files tab's button, by dropping them anywhere on the page, or
  by pasting a screenshot (outside text fields). They are copied next to
  the artifact, listed in its Attachments section (images and videos shown
  inline, videos playable in place) and in the Links tab. Clicking one
  opens a viewer: images, video, audio, rendered Markdown, PDFs in the
  browser's viewer, text as text, anything else as a download. Delete asks
  first.
- **Revision history** drawer: every git commit of the task folder, with
  author (me / center / agent name, from the `Actor:` trailer) and a diff.
  This is the audit trail.
- I can also edit the Markdown directly (a simple editor toggle). Edits
  follow the same revision rules.

## Inline comments (Google-Docs-like)

Interaction:
1. Select text in the rendered artifact → a small popover appears:
   **Comment**, **Ask**, **Change**.
2. Type → ⏎. The selection is highlighted and a thread opens in the side
   panel.
3. `Change` → `edit_artifact` job scoped to that range. `Ask` → `answer`
   job. `Comment` → note only. The agent replies in the thread and resolves
   it (or leaves it open if it needs me).
4. Clicking a paragraph without selecting text anchors to the whole block.

### Anchoring (the hard part)

Artifacts change constantly (agents write to them), so anchors must survive
edits. Use the **W3C Web Annotation text-quote selector** plus a
section hint:

```json
{
  "section": "Summary",
  "exact": "cold start >10s",
  "prefix": "The upload lambda ",
  "suffix": " when the bucket",
  "revision": 14
}
```

- On render, re-anchor: search for `prefix+exact+suffix` within the section,
  then `exact` alone, then a fuzzy match (diff-match-patch style) across
  the doc. If nothing matches, the comment becomes **orphaned**. It shows
  in the panel with its quoted text, unhighlighted.
- Rendering: markdown-it → HTML with `data-section` on headings and blocks.
  Highlights are applied as DOM ranges after render, so the Markdown file
  never contains comment markers. Agents keep a clean file to edit.
- Libraries to evaluate in the spike: `@apache-annotator/dom` (text-quote
  matching), or a small custom matcher plus `diff-match-patch`.

### Comments to herdr workers

Phase 2: a comment with intent **"Send to agent"** on an active task.
It is forwarded with `herdr agent prompt <name> "Re T-115 artifact, about
'<quote>': <comment>"`, so the inline-comment UX also reaches the worker. It
is only sent when the agent is idle/done. Otherwise it is queued and the
thread shows "queued for agent".

## Notifications

- macOS: `herdr notification show "<title>" --body … --sound request`
  (lands where I already look), with `osascript display notification`
  as fallback.
- Phone: Web Push from the PWA (phase 3). Until then, the phone shows the
  Now lane when opened.
- Triggers: reminder due, agent blocked, task moved to review, follow-up
  fired, enrichment failed.
