/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import Link from "./Link.jsx"
import { useApp } from "./AppContext.jsx"
import { useStreamStatus } from "../lib/hooks.js"

/** Element id of the top bar slot pages can portal controls into. */
export const TOPBAR_SLOT_ID = "topbar-slot"

const STREAM_LABEL = {
    open: "live",
    connecting: "connecting",
    reconnecting: "reconnecting",
    closed: "offline",
}

export function BrandMark() {
    return (
        <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <rect
                x="1"
                y="1"
                width="30"
                height="30"
                rx="8"
                fill="none"
                stroke="currentColor"
                strokeOpacity=".35"
            />
            <circle
                cx="16"
                cy="16"
                r="7.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
            />
            <circle cx="16" cy="16" r="2.6" fill="var(--accent)" />
            <path
                d="M16 3.5v5M16 23.5v5M3.5 16h5M23.5 16h5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
            />
        </svg>
    )
}

export default function TopBar() {
    const { me, isOwner } = useApp()
    const stream = useStreamStatus()
    const showSettings = isOwner || (me && me.mode === "tailnet")
    return (
        <header className="topbar">
            <Link to="/" className="brand" aria-label="Command Center home">
                <BrandMark />
                <span className="brand-name">
                    Command<span className="brand-thin"> Center</span>
                </span>
            </Link>
            <div className="topbar-right">
                {!isOwner ? (
                    <span className="badge badge-viewer">read-only</span>
                ) : null}
                {/* pages render header controls here (home: search) */}
                <div className="topbar-slot" id={TOPBAR_SLOT_ID} />
                <span
                    className={`live live-${stream}`}
                    title={`Updates: ${STREAM_LABEL[stream] || stream}`}
                >
                    <span className="live-dot" aria-hidden="true" />
                    <span className="live-text">
                        {STREAM_LABEL[stream] || stream}
                    </span>
                </span>
                {showSettings ? (
                    <Link
                        to="/settings"
                        className="icon-btn"
                        aria-label="Settings"
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path
                                d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.1.1-1.4-.1-1.4 2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.4-1.4L14.2 2h-4l-.4 2.6c-.9.3-1.7.8-2.4 1.4l-2.4-1-2 3.4 2 1.6-.1 1.4.1 1.4-2 1.6 2 3.4 2.4-1c.7.6 1.5 1.1 2.4 1.4l.4 2.6h4l.4-2.6c.9-.3 1.7-.8 2.4-1.4l2.4 1 2-3.4-2-1.6Z"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinejoin="round"
                            />
                        </svg>
                    </Link>
                ) : null}
            </div>
        </header>
    )
}
