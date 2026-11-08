/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

/** Shimmering placeholder rows while data loads. */
export function SkeletonRows({ count = 4, label = "Loading" }) {
    return (
        <div className="skeleton-rows" aria-busy="true" aria-label={label}>
            {Array.from({ length: count }, (_, i) => (
                <div
                    key={i}
                    className="skeleton-row"
                    style={{ animationDelay: `${i * 90}ms` }}
                >
                    <span className="sk sk-key" />
                    <span
                        className="sk sk-title"
                        style={{ width: `${55 + ((i * 17) % 35)}%` }}
                    />
                </div>
            ))}
        </div>
    )
}

/** Paragraph-shaped skeleton for the artifact. */
export function SkeletonDoc() {
    return (
        <div
            className="skeleton-doc"
            aria-busy="true"
            aria-label="Loading task"
        >
            <span className="sk sk-h1" />
            <span className="sk sk-line" />
            <span className="sk sk-line" style={{ width: "82%" }} />
            <span className="sk sk-h2" />
            <span className="sk sk-line" />
            <span className="sk sk-line" style={{ width: "64%" }} />
        </div>
    )
}

export function EmptyState({ title, children, glyph = "○" }) {
    return (
        <div className="empty">
            <span className="empty-glyph" aria-hidden="true">
                {glyph}
            </span>
            <p className="empty-title">{title}</p>
            {children ? <div className="empty-body">{children}</div> : null}
        </div>
    )
}
