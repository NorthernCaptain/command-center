/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App.jsx"
import ErrorBoundary from "./components/ErrorBoundary.jsx"
import { ToastProvider } from "./components/Toasts.jsx"
import { registerServiceWorker } from "./lib/push.js"
import "./styles/theme.css"
import "./styles/app.css"

createRoot(document.getElementById("root")).render(
    <StrictMode>
        <ToastProvider>
            <ErrorBoundary>
                <App />
            </ErrorBoundary>
        </ToastProvider>
    </StrictMode>
)

// Web Push service worker: production builds only, so the Vite dev server
// never has a worker in front of it. Tests never load main.jsx.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        registerServiceWorker().catch(() => {})
    })
}
