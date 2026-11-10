/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// zod -> JSON Schema for providers. Output is "strict" friendly (OpenAI
// structured outputs / Claude json_schema): every object has
// additionalProperties:false and all keys required (zod already does that for
// plain objects; optional fields must be modeled as nullable). We drop
// constructs strict validators reject or that add noise: $schema, format,
// pattern, default (zod still applies it when parsing) and the
// ±MAX_SAFE_INTEGER bounds zod adds to .int().

import { z } from "zod"

const DROP_KEYS = new Set(["$schema", "format", "pattern", "default"])

function clean(node) {
    if (Array.isArray(node)) return node.map(clean)
    if (!node || typeof node !== "object") return node
    const out = {}
    for (const [k, v] of Object.entries(node)) {
        if (DROP_KEYS.has(k)) continue
        if (
            (k === "minimum" || k === "maximum") &&
            Math.abs(v) === Number.MAX_SAFE_INTEGER
        )
            continue
        out[k] = clean(v)
    }
    if (out.type === "object" && out.properties) {
        out.additionalProperties = false
        out.required = Object.keys(out.properties)
    }
    return out
}

/** @param {import("zod").ZodType} schema */
export function toProviderSchema(schema) {
    return clean(z.toJSONSchema(schema))
}
