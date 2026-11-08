/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { createContext, useContext } from "react"

/** Optional server modules, from GET /api/me `features`. */
export const FEATURES = ["workers", "github", "push", "soc2", "digest"]

/**
 * { workers, github, push, soc2, digest } booleans from /api/me. A missing
 * features object (older server) means every feature is off.
 */
export function featuresOf(me) {
    const f = (me && me.features) || {}
    const out = {}
    for (const k of FEATURES) out[k] = f[k] === true
    return out
}

const NO_FEATURES = featuresOf(null)

const DEFAULT = {
    me: { role: "viewer", login: null, mode: "local" },
    isOwner: false,
    features: NO_FEATURES,
    refreshMe: () => {},
}

export const AppContext = createContext(DEFAULT)

/** { me, isOwner, features, refreshMe } */
export function useApp() {
    const ctx = useContext(AppContext)
    // Providers built without features (older callers) get every one off.
    return ctx.features ? ctx : { ...ctx, features: NO_FEATURES }
}
