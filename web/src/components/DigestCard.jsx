/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "./Link.jsx"
import { api as defaultApi } from "../lib/api.js"
import {
    dismissDigest,
    dismissedDate,
    isToday,
    normalizeDigest,
} from "../lib/digest.js"
import { useEvents } from "../lib/hooks.js"
import { taskKey } from "../lib/constants.js"
import { relativeTime } from "../lib/time.js"

/**
 * "Morning digest" card on Home: shown when GET /api/digest has today's
 * digest and it was not dismissed today on this device. Refreshes on
 * digest.updated and after a reconnect.
 */
export default function DigestCard({ api = defaultApi }) {
    const [digest, setDigest] = useState(null)
    const [dismissed, setDismissed] = useState(() => dismissedDate())
    const alive = useRef(true)

    const load = useCallback(() => {
        api.getDigest()
            .then((res) => {
                if (alive.current) setDigest(normalizeDigest(res))
            })
            .catch(() => {}) // the card is optional: no digest, no card
    }, [api])

    useEffect(() => {
        alive.current = true
        load()
        return () => {
            alive.current = false
        }
    }, [load])

    useEvents(["digest.updated", "stream.reconnected"], () => load())

    if (!digest || !isToday(digest) || dismissed === digest.date) return null

    function dismiss() {
        dismissDigest(digest.date)
        setDismissed(digest.date)
    }

    return (
        <section className="card digest" aria-label="Morning digest">
            <header className="digest-head">
                <h2 className="digest-title">
                    <span className="lane-lamp" aria-hidden="true" />
                    Morning digest
                </h2>
                {digest.generated_at ? (
                    <time className="row-time" dateTime={digest.generated_at}>
                        {relativeTime(digest.generated_at)}
                    </time>
                ) : null}
                <button
                    type="button"
                    className="icon-btn digest-close"
                    aria-label="Dismiss morning digest"
                    onClick={dismiss}
                >
                    ×
                </button>
            </header>
            {digest.summary ? (
                <p className="digest-summary">{digest.summary}</p>
            ) : null}
            {digest.sections.map((s) => (
                <div key={s.id} className="digest-section">
                    <h3 className="panel-sub">
                        {s.title}
                        <span className="lane-count">{s.items.length}</span>
                    </h3>
                    <ul className="digest-items">
                        {s.items.map((it, i) => (
                            <li key={`${it.id ?? it.title}-${i}`}>
                                {it.id ? (
                                    <Link to={`/t/${it.id}`}>
                                        <span className="row-key">
                                            {taskKey(it.id)}
                                        </span>{" "}
                                        {it.title}
                                    </Link>
                                ) : it.url ? (
                                    <a
                                        href={it.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        {it.title}
                                    </a>
                                ) : (
                                    <span>{it.title}</span>
                                )}
                                {it.note ? (
                                    <span className="digest-note">
                                        {it.note}
                                    </span>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </section>
    )
}
