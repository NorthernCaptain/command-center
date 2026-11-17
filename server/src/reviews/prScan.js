/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// PR scan for the reviews dashboard (docs/09-pr-reviews.md): GraphQL
// queries, normalization of a PR node, and classification against our
// login (decision, attempts, new / re-review, eligibility).

// our decision reviews only (comment-only ones never crowd them out),
// paged back by the scan when there are more than 100 (ownReviewsBefore)
const OWN_STATES = "APPROVED, CHANGES_REQUESTED, DISMISSED"
const OWN_NODES = `pageInfo { hasPreviousPage startCursor }
        nodes { id author { __typename login } state submittedAt commit { oid } }`

/** One PR's decision reviews by us before a cursor (paging back). */
export function ownReviewsBeforeQuery(number) {
    return `query($owner: String!, $name: String!, $me: String!, $before: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: ${Number(number)}) {
      reviews(last: 100, before: $before, author: $me, states: [${OWN_STATES}]) { ${OWN_NODES} }
    }
  }
}`
}

const BASE_FIELDS = `
    number url title isDraft baseRefName headRefOid createdAt updatedAt
    mergedAt closedAt state additions deletions changedFiles mergeable
    reviewDecision
    author { __typename login }
    reviews(last: 100, author: $me, states: [${OWN_STATES}]) { ${OWN_NODES} }
    firstOwn: reviews(first: 1, author: $me, states: [COMMENTED, ${OWN_STATES}]) {
        nodes { submittedAt }
    }
    lastOwn: reviews(last: 1, author: $me, states: [COMMENTED, ${OWN_STATES}]) {
        nodes { submittedAt }
    }
`
const COMMENT_NODES = `pageInfo { hasPreviousPage startCursor }
        nodes { author { __typename login } createdAt }`

/**
 * Open PRs also need the author's answers since our review (re-review). A
 * reply in a review thread is a review of its author, so the author's own
 * reviews (author filter: others' activity never pushes them out) hold the
 * thread replies; conversation comments can't be filtered by author, so
 * the newest 100 come with their cursor and the scan pages back further
 * when they don't reach our review (olderCommentsNeeded).
 */
function prFields(author) {
    const own = author
        ? `authorActivity: reviews(last: 50, author: ${JSON.stringify(author)}) {
        nodes { author { __typename login } submittedAt }
    }`
        : ""
    return `${BASE_FIELDS}
    commits(last: 1) {
        nodes { commit { oid committedDate statusCheckRollup { state } } }
    }
    comments(last: 100) { ${COMMENT_NODES} }
    reviewRequests(first: 50) {
        nodes { requestedReviewer { __typename ... on User { login } } }
    }
    reRequests: timelineItems(last: 20, itemTypes: [REVIEW_REQUESTED_EVENT]) {
        nodes { ... on ReviewRequestedEvent {
            createdAt requestedReviewer { __typename ... on User { login } }
        } }
    }
    ${own}
`
}

/** One PR's conversation comments before a cursor (paging back). */
export function commentsBeforeQuery(number) {
    return `query($owner: String!, $name: String!, $before: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: ${Number(number)}) {
      comments(last: 100, before: $before) { ${COMMENT_NODES} }
    }
  }
}`
}

/**
 * Does the node need older conversation comments? Only while our change
 * request stands and the fetched comments start after it: an answer may be
 * older than the newest 100.
 */
export function olderCommentsNeeded(node, me) {
    const page = node?.comments?.pageInfo
    if (!page || !page.hasPreviousPage || !page.startCursor) return false
    const ours = (node.reviews?.nodes || [])
        .filter(
            (r) =>
                r &&
                lower(r.author?.login) === lower(me) &&
                DECISIONS.includes(r.state) &&
                r.submittedAt
        )
        .sort((a, b) => ms(a.submittedAt) - ms(b.submittedAt))
    const last = ours.at(-1)
    if (!last || last.state !== "CHANGES_REQUESTED") return false
    const oldest = (node.comments.nodes || [])
        .map((c) => c && c.createdAt)
        .filter(Boolean)
        .sort()[0]
    return Boolean(oldest && after(oldest, last.submittedAt))
}

/**
 * Open PRs of a repo, light (number, update time, author), plus its
 * default branch; the details come by number for the changed ones only, in
 * small batches (a heavy query over many PRs times out with a 502).
 */
export const OPEN_PRS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequests(states: OPEN, first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number updatedAt author { __typename login } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

/**
 * Recently closed / merged PRs (first scan of a repo: stats history). Only
 * the light fields: a heavy query over many closed PRs times out (502).
 */
export const CLOSED_PRS_QUERY = `query($owner: String!, $name: String!, $me: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequests(states: [MERGED, CLOSED], first: 25, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ${BASE_FIELDS} }
    }
  }
}`

/**
 * Some PRs by number: numbers, or { number, author } (the author's own
 * reviews then come with the author filter).
 */
export function prsByNumberQuery(items) {
    const parts = items
        .map((i) =>
            typeof i === "object" && i
                ? { number: Number(i.number), author: i.author || null }
                : { number: Number(i), author: null }
        )
        .filter((i) => Number.isInteger(i.number) && i.number > 0)
        .map(
            (i) =>
                `p${i.number}: pullRequest(number: ${i.number}) { ${prFields(i.author)} }`
        )
    return `query($owner: String!, $name: String!, $me: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    ${parts.join("\n    ")}
  }
}`
}

const DECISIONS = ["APPROVED", "CHANGES_REQUESTED"]
// a dismissed review was a decision too (attempts), but no longer counts
const ATTEMPTS = [...DECISIONS, "DISMISSED"]

const lower = (s) => String(s || "").toLowerCase()
const ms = (iso) => (iso ? new Date(iso).getTime() : NaN)
const after = (a, b) => !b || ms(a) > ms(b)

/**
 * Why a PR can't be reviewed automatically, or null: not open, or a
 * draft. A bot's PR (e.g. an agent app opening the team's PRs) and a
 * stacked PR (based on another PR's branch) are reviewed like any other.
 * The one rule for the scanner, the queue and the dashboard.
 * @param {{ state, is_draft }} pr
 */
export function ineligibleReason(pr) {
    if (pr.state !== "OPEN") return pr.state === "MERGED" ? "merged" : "closed"
    if (pr.is_draft) return "draft"
    return null
}

/** Is the PR based on another branch than the default (or main / master)? */
export function stackedBase(pr) {
    const bases = new Set(["main", "master", pr.default_branch].filter(Boolean))
    return pr.base && !bases.has(pr.base) ? pr.base : null
}

/** A bot account (GraphQL Bot, "x[bot]", or a configured name). */
export function isBotAuthor(author, extraBots = []) {
    if (!author) return true // a deleted account: never review it
    if (author.__typename === "Bot") return true
    const login = lower(author.login)
    return login.endsWith("[bot]") || extraBots.map(lower).includes(login)
}

const people = (list) =>
    (list || []).filter(Boolean).map((c) => ({
        login: (c.author && c.author.login) || null,
        bot: isBotAuthor(c.author),
        createdAt: c.createdAt || null,
    }))

/** GraphQL PR node -> flat PR. */
export function normalizeNode(node) {
    const head = (node.commits?.nodes || [])[0]?.commit || null
    const replies = [
        ...(node.authorActivity?.nodes || []),
        ...(node.activity?.nodes || []),
    ]
        .filter(Boolean)
        .map((r) => ({ author: r.author, createdAt: r.submittedAt }))
    return {
        number: node.number,
        url: node.url || null,
        title: node.title || "",
        author: node.author?.login || null,
        author_bot: isBotAuthor(node.author),
        is_draft: Boolean(node.isDraft),
        base: node.baseRefName || null,
        head_sha: node.headRefOid || head?.oid || null,
        head_committed_at: head?.committedDate || null,
        state: node.state || "OPEN",
        created_at: node.createdAt || null,
        updated_at: node.updatedAt || null,
        merged_at: node.mergedAt || null,
        closed_at: node.closedAt || null,
        additions: node.additions ?? null,
        deletions: node.deletions ?? null,
        changed_files: node.changedFiles ?? null,
        ci_state: head?.statusCheckRollup?.state || null,
        mergeable: node.mergeable || null,
        review_decision: node.reviewDecision || null,
        reviews: (node.reviews?.nodes || []).filter(Boolean).map((r) => ({
            id: r.id,
            login: r.author?.login || null,
            state: r.state || null,
            submittedAt: r.submittedAt || null,
            commit: r.commit?.oid || null,
        })),
        comments: [...people(node.comments?.nodes), ...people(replies)],
        // our earliest submitted review of any kind (comment-only too)
        first_own_at: node.firstOwn?.nodes?.[0]?.submittedAt || null,
        // our latest submitted review of any kind (a thread reply too)
        last_own_at: node.lastOwn?.nodes?.[0]?.submittedAt || null,
        // users GitHub lists as requested reviewers (pending requests; a
        // team request is not ours)
        review_requests: (node.reviewRequests?.nodes || [])
            .map((n) => n && n.requestedReviewer && n.requestedReviewer.login)
            .filter(Boolean),
        // when users were asked for their review (the latest 20 requests)
        review_requested: (node.reRequests?.nodes || [])
            .filter((n) => n && n.createdAt && n.requestedReviewer?.login)
            .map((n) => ({
                login: n.requestedReviewer.login,
                createdAt: n.createdAt,
            })),
    }
}

/**
 * Our view of a PR: decision, attempts, needs_review, eligibility, and the
 * key that identifies what a review would look at (a new key = new work).
 * @param {object} pr  normalizeNode output
 * @param {{ me: string, defaultBranch?: string|null }} opts
 */
export function classifyPr(pr, { me, defaultBranch = null, prev = null }) {
    const mine = pr.reviews
        .filter((r) => lower(r.login) === lower(me) && r.submittedAt)
        .sort((a, b) => ms(a.submittedAt) - ms(b.submittedAt))
    const ours = mine.filter((r) => ATTEMPTS.includes(r.state))
    const live = ours.filter((r) => DECISIONS.includes(r.state))
    const last = live.at(-1) || null
    const decision = last ? lower(last.state) : null
    // only the author answers our change request (a comment, a thread
    // reply, a review): other reviewers' activity is no reason to re-review
    // (a bot author's own replies count too)
    const others = pr.comments.filter(
        (c) =>
            c.login &&
            pr.author &&
            lower(c.login) === lower(pr.author) &&
            lower(c.login) !== lower(me)
    )
    // An author's answer seen before may have left the fetched window (50
    // newer comments / reviews by others): while our deciding review is the
    // same, the answer time stored in the trigger key still counts.
    const seen =
        prev &&
        last &&
        prev.decided_at === last.submittedAt &&
        (/^re_review:[^:]*:(.+)$/.exec(prev.trigger_key || "") || [])[1]
    const latest = (list) =>
        list.filter(Boolean).reduce((a, b) => (after(b, a) ? b : a), null)
    // our latest word (the decision, a comment-only review or thread reply,
    // a conversation comment): once we replied, the ball is with the author
    const ourLast = last
        ? latest([
              last.submittedAt,
              pr.last_own_at,
              ...pr.comments
                  .filter((c) => c.login && lower(c.login) === lower(me))
                  .map((c) => c.createdAt),
          ])
        : null
    // our review asked for again after our latest word, still pending (our
    // next review clears it; a removed request does not count): the author
    // wants an answer, a review on GitHub
    const requested = (pr.review_requests || []).some(
        (l) => lower(l) === lower(me)
    )
    const ourRequests = (pr.review_requested || [])
        .filter((r) => lower(r.login) === lower(me))
        .map((r) => r.createdAt)
    const requestedAt = requested ? latest(ourRequests) : null
    const rerequested =
        last && requestedAt && after(requestedAt, ourLast) ? requestedAt : null
    // a stored time that was a request of our review (not an author's
    // answer) counts only while that request is pending
    const seenAnswer =
        seen && !(ourRequests.includes(seen) && seen !== rerequested)
            ? seen
            : null
    const lastComment = latest([
        ...others.map((c) => c.createdAt),
        seenAnswer,
        // asking for our review again is an answer too (whoever asks)
        decision === "changes_requested" ? rerequested : null,
    ])
    const open = pr.state === "OPEN"
    let needs = null
    if (open && !decision) needs = "new"
    else if (open && decision === "changes_requested") {
        const newCommit = Boolean(
            pr.head_sha && last.commit && pr.head_sha !== last.commit
        )
        // the author answered after our latest word (a comment, a reply, a
        // new request of our review)
        const newComment = Boolean(lastComment && after(lastComment, ourLast))
        if (newCommit || newComment) needs = "re_review"
    } else if (open && decision === "approved") {
        // approved, then the head moved and GitHub still lists us as a
        // requested reviewer (the author asks for our review again): the
        // new commits need a look. Our next review at that head clears it.
        const newCommit = Boolean(
            pr.head_sha && last.commit && pr.head_sha !== last.commit
        )
        if (requested && newCommit) needs = "re_review"
    }
    const ineligible = ineligibleReason({
        ...pr,
        default_branch: defaultBranch,
    })
    return {
        decision,
        decided_at: last ? last.submittedAt : null,
        decided_sha: last ? last.commit : null,
        // the first review of ours, a comment-only one too
        first_review_at:
            [pr.first_own_at, mine[0] && mine[0].submittedAt]
                .filter(Boolean)
                .sort()[0] || null,
        attempts: ours.length,
        decisions: ours,
        last_activity_at: [pr.head_committed_at, lastComment]
            .filter(Boolean)
            .reduce((a, b) => (after(b, a) ? b : a), null),
        needs_review: needs,
        rerequested_at: open ? rerequested : null,
        eligible: !ineligible,
        ineligible_reason: ineligible,
        // a re-review after our approval stands for the head only: an
        // answer that is no change request's answer never asks for another
        trigger_key: needs
            ? `${needs}:${pr.head_sha || ""}:${needs === "re_review" && decision === "changes_requested" ? lastComment || "" : ""}`
            : null,
    }
}
