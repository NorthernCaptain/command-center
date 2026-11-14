/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

// Small SVG grouped bar chart: one group per row of `data`, one bar per
// series. Heights scale to the largest value; colors are CSS custom
// properties so the chart follows the theme.

const W = 320
const H = 120
const PAD_BOTTOM = 18
const GAP = 0.3 // share of a group's width left empty

/**
 * Bar rectangles for the data: x / width per group and series, height
 * scaled to the largest value (at least 1, so all-zero data draws flat).
 * @param {object[]} data
 * @param {{ key: string }[]} series
 */
export function barLayout(data, series) {
    const max = Math.max(
        1,
        ...data.flatMap((d) =>
            series.map((s) => (Number.isFinite(d[s.key]) ? d[s.key] : 0))
        )
    )
    const groupW = data.length ? W / data.length : W
    const barW = series.length ? (groupW * (1 - GAP)) / series.length : 0
    const plotH = H - PAD_BOTTOM
    return {
        max,
        groupW,
        bars: data.flatMap((d, gi) =>
            series.map((s, si) => {
                const v = Number.isFinite(d[s.key]) ? d[s.key] : 0
                const h = (v / max) * plotH
                return {
                    group: gi,
                    key: s.key,
                    value: v,
                    x: gi * groupW + (groupW * GAP) / 2 + si * barW,
                    y: plotH - h,
                    width: barW,
                    height: h,
                }
            })
        ),
    }
}

/**
 * @param {object} props
 * @param {object[]} props.data      rows, e.g. { week, approved, … }
 * @param {{ key: string, label: string, color: string }[]} props.series
 * @param {string} props.labelKey    row field shown under each group
 * @param {(v: any) => string} [props.formatLabel]
 * @param {string} props.label       accessible name of the chart
 */
export default function Bars({
    data,
    series,
    labelKey,
    formatLabel = String,
    label,
}) {
    const { bars, groupW } = barLayout(data, series)
    const color = Object.fromEntries(series.map((s) => [s.key, s.color]))
    const name = Object.fromEntries(series.map((s) => [s.key, s.label]))
    return (
        <figure className="chart bars" aria-label={label}>
            <svg
                viewBox={`0 0 ${W} ${H}`}
                className="bars-svg"
                role="img"
                preserveAspectRatio="none"
            >
                <title>{label}</title>
                <line
                    x1="0"
                    x2={W}
                    y1={H - PAD_BOTTOM}
                    y2={H - PAD_BOTTOM}
                    stroke="var(--line-strong)"
                />
                {bars.map((b) => (
                    <rect
                        key={`${b.group}-${b.key}`}
                        className="bar"
                        x={b.x}
                        y={b.y}
                        width={b.width}
                        height={b.height}
                        rx="2"
                        fill={color[b.key]}
                    >
                        <title>{`${formatLabel(data[b.group][labelKey])} · ${name[b.key]}: ${b.value}`}</title>
                    </rect>
                ))}
                {data.map((d, i) => (
                    <text
                        key={i}
                        className="bars-label"
                        x={i * groupW + groupW / 2}
                        y={H - 4}
                        textAnchor="middle"
                    >
                        {formatLabel(d[labelKey])}
                    </text>
                ))}
            </svg>
            <ul className="chart-legend chart-legend-row">
                {series.map((s) => (
                    <li key={s.key}>
                        <span
                            className="chart-swatch"
                            style={{ background: s.color }}
                            aria-hidden="true"
                        />
                        <span className="chart-legend-label">{s.label}</span>
                    </li>
                ))}
            </ul>
        </figure>
    )
}
