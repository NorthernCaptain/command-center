/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { render, screen } from "@testing-library/react"
import Bars, { barLayout } from "./Bars.jsx"
import Donut, { donutArcs } from "./Donut.jsx"

describe("donutArcs", () => {
    it("splits the ring by share and skips empty segments", () => {
        const arcs = donutArcs([{ value: 3 }, { value: 0 }, { value: 1 }])
        expect(arcs.map((a) => a.index)).toEqual([0, 2])
        expect(arcs[0].share).toBeCloseTo(0.75)
        expect(arcs[0].offset).toBeCloseTo(0)
        expect(arcs[1].offset).toBeLessThan(0)
    })
    it("no data: no arcs", () => {
        expect(donutArcs([{ value: 0 }, { value: NaN }])).toEqual([])
        expect(donutArcs([])).toEqual([])
    })
})

describe("Donut", () => {
    const segments = [
        { label: "1st", value: 6, color: "var(--live)" },
        { label: "2nd", value: 2, color: "var(--blue)" },
        { label: "3rd", value: 0, color: "var(--violet)" },
    ]
    it("renders arcs, total and legend with shares", () => {
        const { container } = render(
            <Donut segments={segments} label="Approvals by attempt" />
        )
        expect(
            screen.getByLabelText("Approvals by attempt")
        ).toBeInTheDocument()
        expect(container.querySelectorAll(".donut-arc")).toHaveLength(2)
        expect(container.querySelector(".donut-total").textContent).toBe("8")
        expect(screen.getByText("1st")).toBeInTheDocument()
        expect(screen.getByText("75%")).toBeInTheDocument()
        expect(container.querySelector("title").textContent).toBe(
            "Approvals by attempt: 1st 6, 2nd 2, 3rd 0"
        )
    })
    it("empty data shows the track only and a custom center", () => {
        const { container } = render(
            <Donut
                segments={[{ label: "1st", value: 0, color: "red" }]}
                label="x"
                center="—"
            />
        )
        expect(container.querySelectorAll(".donut-arc")).toHaveLength(0)
        expect(container.querySelector(".donut-total").textContent).toBe("—")
        expect(container.querySelector(".chart-legend-share")).toBeNull()
    })
})

describe("barLayout / Bars", () => {
    const series = [
        { key: "a", label: "Approved", color: "green" },
        { key: "b", label: "Changes", color: "red" },
    ]
    it("scales bars to the largest value", () => {
        const { bars, max } = barLayout(
            [
                { w: "x", a: 4, b: 2 },
                { w: "y", a: 0, b: "?" },
            ],
            series
        )
        expect(max).toBe(4)
        expect(bars).toHaveLength(4)
        const [a0, b0, a1, b1] = bars
        expect(b0.height).toBeCloseTo(a0.height / 2)
        expect(a1.height).toBe(0)
        expect(b1.value).toBe(0)
        expect(b0.x).toBeGreaterThan(a0.x)
        expect(a1.x).toBeGreaterThan(b0.x)
    })
    it("all-zero and empty data stay drawable", () => {
        expect(barLayout([{ a: 0, b: 0 }], series).max).toBe(1)
        expect(barLayout([], series).bars).toEqual([])
        expect(barLayout([{ a: 1 }], []).bars).toEqual([])
    })
    it("renders a bar per value, group labels and the legend", () => {
        const { container } = render(
            <Bars
                data={[
                    { week: "2026-11-02", a: 1, b: 3 },
                    { week: "2026-11-09", a: 2, b: 0 },
                ]}
                series={series}
                labelKey="week"
                formatLabel={(w) => w.slice(5)}
                label="Weekly reviews"
            />
        )
        expect(screen.getByLabelText("Weekly reviews")).toBeInTheDocument()
        expect(container.querySelectorAll("rect.bar")).toHaveLength(4)
        expect(screen.getByText("11-02")).toBeInTheDocument()
        expect(screen.getByText("Changes")).toBeInTheDocument()
        expect(container.querySelector("rect.bar title").textContent).toBe(
            "11-02 · Approved: 1"
        )
    })
    it("default label format", () => {
        render(
            <Bars
                data={[{ n: 7, a: 1 }]}
                series={[series[0]]}
                labelKey="n"
                label="x"
            />
        )
        expect(screen.getByText("7")).toBeInTheDocument()
    })
})
