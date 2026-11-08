/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */
import { fileURLToPath } from "node:url"
import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

const root = path.dirname(fileURLToPath(import.meta.url))
const target = "http://127.0.0.1:7788"

// The local listener only accepts Host 127.0.0.1/localhost/[::1]:<port>
// (else 421) and checks Origin against that host on cookie-auth writes, so
// the dev proxy presents itself as the target: Host via changeOrigin and the
// Origin header rewritten. SSE (/api/events) streams through unbuffered.
const proxyOpts = {
    target,
    changeOrigin: true,
    configure: (proxy) => {
        proxy.on("proxyReq", (proxyReq) => {
            if (proxyReq.getHeader("origin"))
                proxyReq.setHeader("origin", target)
        })
    },
}

export default defineConfig({
    root,
    plugins: [react()],
    build: {
        outDir: path.join(root, "dist"),
        emptyOutDir: true,
        sourcemap: true,
    },
    server: {
        proxy: {
            "/api": proxyOpts,
            "/auth": proxyOpts,
            "/healthz": proxyOpts,
        },
    },
})
