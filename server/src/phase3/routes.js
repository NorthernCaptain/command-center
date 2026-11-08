/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Phase 3 routes on the /api router. All are owner-only: the router's role
// check already denies viewers everything outside the whitelisted GETs.
//
//   GET    /soc2/export?from&to&format=json|md[&areas=a,b]
//   GET    /push/key                    -> { publicKey }
//   POST   /push/subscribe  { endpoint, keys }   -> 201 { ok, endpoint }
//   DELETE /push/subscribe  { endpoint }         -> { ok, removed }
//   GET    /digest                      -> { digest | null }
//   POST   /digest/run                  -> { digest }  (stale sweep + build)

import { z } from "zod"
import { toMarkdown } from "./soc2.js"

const ExportQuery = z.object({
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    format: z.enum(["json", "md"]).default("json"),
    areas: z.string().max(200).optional(),
})
const UnsubscribeBody = z.object({ endpoint: z.string().min(1).max(2048) })
const RunBody = z.object({ notify: z.boolean().default(false) })

const fileStamp = (iso) => String(iso).slice(0, 10)

/**
 * @param {object} api      express Router mounted at /api
 * @param {object} helpers  { parse, ... } from createApp
 * @param {{ soc2?: object, push?: object, digest?: object }} deps
 */
export function mountPhase3(api, helpers, { soc2, push, digest } = {}) {
    const { parse } = helpers

    if (soc2) {
        api.get("/soc2/export", async (req, res) => {
            const q = parse(ExportQuery, req.query || {}, "query")
            const areas = q.areas
                ? q.areas
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean)
                : undefined
            const evidence = await soc2.exportEvidence({
                from: q.from,
                to: q.to,
                areas,
            })
            const name = `soc2-evidence-${fileStamp(evidence.from)}-${fileStamp(evidence.to)}`
            if (q.format === "md") {
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${name}.md"`
                )
                res.type("text/markdown; charset=utf-8").send(
                    toMarkdown(evidence)
                )
                return
            }
            res.json(evidence)
        })
    }

    if (push) {
        api.get("/push/key", (req, res) => {
            res.json({ publicKey: push.publicKey() })
        })
        api.post("/push/subscribe", (req, res) => {
            // A paired device ties the subscription to it (revoking the
            // phone stops its pushes); without one it is the owner's,
            // removed by unsubscribing.
            const device = req.auth && req.auth.device
            const deviceId = device && device.id ? String(device.id) : null
            const out = push.subscribe(req.body || {}, { deviceId })
            res.status(201).json({ ok: true, endpoint: out.endpoint })
        })
        api.delete("/push/subscribe", (req, res) => {
            const body = parse(UnsubscribeBody, req.body || {})
            res.json({ ok: true, removed: push.unsubscribe(body.endpoint) })
        })
    }

    if (digest) {
        api.get("/digest", (req, res) => {
            res.json({ digest: digest.latest() })
        })
        api.post("/digest/run", async (req, res) => {
            const body = parse(RunBody, req.body || {})
            res.json({ digest: await digest.run({ notify: body.notify }) })
        })
    }
}
