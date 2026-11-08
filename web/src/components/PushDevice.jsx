/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { useEffect, useState } from "react"
import { useToast } from "./Toasts.jsx"
import { api as defaultApi } from "../lib/api.js"
import {
    currentSubscription,
    disablePush,
    enablePush,
    pushSupport,
} from "../lib/push.js"

const UNSUPPORTED = {
    unsupported:
        "This browser can't receive push notifications. On iPhone, add Command Center to the Home Screen and open it from there.",
    insecure:
        "Push notifications need https. Open the app over its tailnet https address (or localhost).",
}

/**
 * "Enable notifications on this device": registers the service worker and
 * a PushManager subscription. `env` ({ navigator, window }) for tests.
 */
export default function PushDevice({ api = defaultApi, env }) {
    const toast = useToast()
    const support = pushSupport(env)
    const [sub, setSub] = useState(undefined) // undefined: still checking
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        if (support !== "supported") return
        let alive = true
        currentSubscription(env)
            .then((s) => alive && setSub(s))
            .catch(() => alive && setSub(null))
        return () => {
            alive = false
        }
    }, [support]) // env is fixed for the component's lifetime

    if (support !== "supported") {
        return <p className="muted">{UNSUPPORTED[support]}</p>
    }

    async function enable() {
        setBusy(true)
        try {
            setSub(await enablePush({ api, env }))
            toast.success("Notifications enabled on this device")
        } catch (err) {
            toast.error(err)
        } finally {
            setBusy(false)
        }
    }

    async function disable() {
        setBusy(true)
        try {
            await disablePush({ api, env })
            setSub(null)
            toast.success("Notifications turned off on this device")
        } catch (err) {
            toast.error(err)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="push-device">
            <p className="muted">
                {sub === undefined
                    ? "Checking this device…"
                    : sub
                      ? "This device receives push notifications (when Push notifications is on above)."
                      : "This device does not receive push notifications yet."}
            </p>
            {sub ? (
                <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={disable}
                >
                    Turn off on this device
                </button>
            ) : (
                <button
                    type="button"
                    className="btn btn-accent"
                    disabled={busy || sub === undefined}
                    onClick={enable}
                >
                    Enable notifications on this device
                </button>
            )}
        </div>
    )
}
