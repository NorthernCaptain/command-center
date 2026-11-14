/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Small SVG donut chart: one ring split into segments, total in the middle,
// legend beside it. Colors are CSS custom properties (var(--live) …) so the
// chart follows the theme.

const R = 40
const STROKE = 14
const C = 2 * Math.PI * R

/**
 * Segment arcs as stroke-dasharray / offset pairs, in order, starting at
 * 12 o'clock. Zero and invalid values get no arc.
 * @param {{ value: number }[]} segments
 * @returns {{ index: number, dash: string, offset: number, share: number }[]}
 */
export function donutArcs(segments) {
    const values = segments.map((s) =>
        Number.isFinite(s.value) && s.value > 0 ? s.value : 0
    )
    const total = values.reduce((a, b) => a + b, 0)
    if (!total) return []
    const arcs = []
    let start = 0
    values.forEach((v, index) => {
        if (!v) return
        const len = (v / total) * C
        arcs.push({
            index,
            dash: `${len} ${C - len}`,
            offset: -start,
            share: v / total,
        })
        start += len
    })
    return arcs
}

/**
 * @param {object} props
 * @param {{ label: string, value: number, color: string }[]} props.segments
 * @param {string} props.label   accessible name of the chart
 * @param {string} [props.center]  text in the hole (default: the total)
 */
export default function Donut({ segments, label, center }) {
    const arcs = donutArcs(segments)
    const total = segments.reduce(
        (a, s) => a + (Number.isFinite(s.value) && s.value > 0 ? s.value : 0),
        0
    )
    return (
        <figure className="chart donut" aria-label={label}>
            <svg viewBox="0 0 100 100" className="donut-svg" role="img">
                <title>
                    {`${label}: ${segments
                        .map((s) => `${s.label} ${s.value || 0}`)
                        .join(", ")}`}
                </title>
                <circle
                    cx="50"
                    cy="50"
                    r={R}
                    fill="none"
                    stroke="var(--panel-3)"
                    strokeWidth={STROKE}
                />
                {arcs.map((a) => (
                    <circle
                        key={a.index}
                        className="donut-arc"
                        cx="50"
                        cy="50"
                        r={R}
                        fill="none"
                        stroke={segments[a.index].color}
                        strokeWidth={STROKE}
                        strokeDasharray={a.dash}
                        strokeDashoffset={a.offset}
                        transform="rotate(-90 50 50)"
                    />
                ))}
                <text x="50" y="50" className="donut-total" textAnchor="middle">
                    {center ?? total}
                </text>
            </svg>
            <ul className="chart-legend">
                {segments.map((s) => (
                    <li key={s.label}>
                        <span
                            className="chart-swatch"
                            style={{ background: s.color }}
                            aria-hidden="true"
                        />
                        <span className="chart-legend-label">{s.label}</span>
                        <span className="chart-legend-value">
                            {s.value || 0}
                            {total ? (
                                <span className="chart-legend-share">
                                    {" "}
                                    {Math.round(((s.value || 0) / total) * 100)}
                                    %
                                </span>
                            ) : null}
                        </span>
                    </li>
                ))}
            </ul>
        </figure>
    )
}
