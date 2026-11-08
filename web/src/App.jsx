/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { AppContext, featuresOf } from "./components/AppContext.jsx"
import ErrorBoundary from "./components/ErrorBoundary.jsx"
import Link from "./components/Link.jsx"
import { EmptyState } from "./components/Skeleton.jsx"
import TopBar, { BrandMark } from "./components/TopBar.jsx"
import Home from "./pages/Home.jsx"
import Settings from "./pages/Settings.jsx"
import TaskPage from "./pages/Task.jsx"
import { api, errorMessage, isTailnetConfigError } from "./lib/api.js"
import { getEventStream } from "./lib/events.js"
import { matchRoute, usePath } from "./lib/router.js"

function Splash() {
    return (
        <div className="splash" aria-busy="true" aria-label="Loading">
            <BrandMark />
        </div>
    )
}

const isAuthError = (err) =>
    Boolean(err) && (err.status === 401 || err.status === 403)

const sameMe = (a, b) =>
    Boolean(a && b) &&
    a.role === b.role &&
    a.login === b.login &&
    a.mode === b.mode &&
    JSON.stringify(featuresOf(a)) === JSON.stringify(featuresOf(b))

function Locked({ error, onRetry }) {
    const unauth = isAuthError(error)
    // 421: Host doesn't match the configured public URL; 503: tailnet access
    // not configured on the server.
    const tailnet = isTailnetConfigError(error)
    return (
        <div className="locked">
            <BrandMark />
            <h1>
                {unauth
                    ? "Not signed in"
                    : tailnet
                      ? "Command center is not configured for tailnet access"
                      : "Command Center is unreachable"}
            </h1>
            <p className="muted">
                {tailnet ? (
                    <>
                        Open it through the URL configured as its public tailnet
                        address, or set that address on the Mac and restart the
                        command center.
                    </>
                ) : unauth ? (
                    <>
                        On the Mac, run <code>cc open</code> to sign this
                        browser in. On the tailnet, open the page through{" "}
                        <code>tailscale serve</code>.
                    </>
                ) : (
                    errorMessage(error)
                )}
            </p>
            <button type="button" className="btn" onClick={onRetry}>
                Try again
            </button>
        </div>
    )
}

export default function App() {
    const path = usePath()
    const [me, setMe] = useState(null)
    const [meError, setMeError] = useState(null)

    const refreshMe = useCallback(async () => {
        try {
            const res = await api.me()
            setMe(res)
            setMeError(null)
        } catch (err) {
            setMeError(err)
        }
    }, [])

    useEffect(() => {
        refreshMe()
    }, [refreshMe])

    useEffect(() => {
        if (!me) return
        const stream = getEventStream()
        // The server ends streams on logout / device revoke. On every stream
        // error re-check the session: 401/403 -> the signed-out screen (and
        // the stream stops); a changed role is picked up; outages just retry.
        const offError = stream.onError(async () => {
            try {
                const res = await api.me()
                setMe((prev) => (sameMe(prev, res) ? prev : res))
            } catch (err) {
                if (isAuthError(err)) {
                    setMe(null)
                    setMeError(err)
                }
            }
        })
        stream.start()
        return () => {
            offError()
            stream.close()
        }
    }, [me])

    const ctx = useMemo(
        () => ({
            me,
            isOwner: Boolean(me && me.role === "owner"),
            features: featuresOf(me),
            refreshMe,
        }),
        [me, refreshMe]
    )

    if (!me && meError) return <Locked error={meError} onRetry={refreshMe} />
    if (!me) return <Splash />

    const route = matchRoute(path)
    let page
    if (route.name === "home") page = <Home />
    else if (route.name === "task")
        page = <TaskPage key={route.params.id} id={route.params.id} />
    else if (route.name === "settings") page = <Settings />
    else
        page = (
            <EmptyState title="Nothing here" glyph="?">
                <Link to="/" className="btn">
                    Back to board
                </Link>
            </EmptyState>
        )

    return (
        <AppContext.Provider value={ctx}>
            <div className={`app role-${me.role}`}>
                <TopBar />
                <main className="main">
                    <ErrorBoundary resetKey={path}>{page}</ErrorBoundary>
                </main>
            </div>
        </AppContext.Provider>
    )
}
