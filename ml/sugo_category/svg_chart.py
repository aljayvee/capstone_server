"""
A small static SVG line chart for category/EXPERIMENTS.md.

The Python twin of scripts/exception-reasons/svgChart.ts, so the two reports
look alike. Static because the charts are embedded in Markdown, where no script
runs. Each line carries a native <title> tooltip, the numbers behind every
chart are also printed as tables in the report, and lines are labelled at their
ends (up to four series) so identity is never colour alone. Colours are the
validated reference palette, in fixed order, with a dark-mode block.
"""

from __future__ import annotations

import math
from html import escape
from typing import Callable, Sequence

LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"]
DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"]


def nice_ticks(lo: float, hi: float, count: int = 5) -> list[float]:
    span = (hi - lo) or 1.0
    raw = span / count
    mag = 10 ** math.floor(math.log10(raw))
    # No 2.5 step: its ticks (0.25, 0.75) would print as 0.3 and 0.8 at one decimal.
    step = next((m * mag for m in (1, 2, 5, 10) if span / (m * mag) <= count), raw)
    ticks, t = [], math.ceil(lo / step) * step
    while t <= hi + step * 1e-9:
        ticks.append(round(t, 6))
        t += step
    return ticks


def _num(v: float) -> str:
    return f"{v:.1f}".rstrip("0").rstrip(".") if abs(v - round(v)) > 1e-9 else str(int(round(v)))


def line_chart(
    title: str,
    x_label: str,
    y_label: str,
    series: Sequence[tuple[str, Sequence[tuple[float, float]]]],
    subtitle: str | None = None,
    y_min: float | None = None,
    y_max: float | None = None,
    x_max: float | None = None,
    y_format: Callable[[float], str] | None = None,
    x_log: bool = False,
) -> str:
    if len(series) > len(LIGHT):
        raise ValueError(f"At most {len(LIGHT)} series per chart.")
    W, H = 720, 380
    left = 64
    right = 150 if len(series) <= 4 else 24
    top = 64 if subtitle else 48
    bottom = 52 + (26 if len(series) > 4 else 0)
    pw, ph = W - left - right, H - top - bottom

    fx = (lambda x: math.log10(x)) if x_log else (lambda x: x)
    pts_all = [(x, y) for _, pts in series for x, y in pts if math.isfinite(y)]
    xs = [fx(x) for x, _ in pts_all]
    x_hi = fx(x_max) if x_max is not None else max(xs)
    x_lo = min(xs)
    lo = y_min if y_min is not None else min(y for _, y in pts_all)
    hi = y_max if y_max is not None else max(y for _, y in pts_all)
    fmt = y_format or _num

    def sx(x: float) -> float:
        return left + (fx(x) - x_lo) / ((x_hi - x_lo) or 1) * pw

    def sy(y: float) -> float:
        y = min(max(y, lo), hi)
        return top + ph - (y - lo) / ((hi - lo) or 1) * ph

    grid = "".join(
        f'<line class="grid" x1="{left}" x2="{left + pw}" y1="{sy(t):.1f}" y2="{sy(t):.1f}"/>'
        f'<text class="muted" x="{left - 8}" y="{sy(t) + 4:.1f}" text-anchor="end">{escape(fmt(t))}</text>'
        for t in nice_ticks(lo, hi)
    )
    if x_log:
        # 1 and 3 of every decade, so a range under two decades still gets ticks.
        x_ticks = [
            m * 10.0**e
            for e in range(math.floor(x_lo), math.ceil(x_hi) + 1)
            for m in (1, 3)
            if x_lo - 1e-9 <= math.log10(m * 10.0**e) <= x_hi + 1e-9
        ]
        x_text = lambda t: f"{t:,.0f}"  # noqa: E731
    else:
        x_ticks = nice_ticks(x_lo, x_hi, 6)
        x_text = _num
    x_axis = "".join(
        f'<text class="muted" x="{sx(t):.1f}" y="{top + ph + 18}" text-anchor="middle">{x_text(t)}</text>'
        for t in x_ticks
    )

    def visible(pts):
        return [(x, y) for x, y in pts if math.isfinite(y) and fx(x) <= x_hi + 1e-12]

    ends = []
    for i, (name, pts) in enumerate(series):
        last = visible(pts)[-1]
        ends.append({"i": i, "name": name, "x": sx(last[0]), "y": sy(last[1]), "label_y": sy(last[1])})
    ends.sort(key=lambda e: e["y"])
    for k in range(1, len(ends)):
        if ends[k]["label_y"] - ends[k - 1]["label_y"] < 14:
            ends[k]["label_y"] = ends[k - 1]["label_y"] + 14

    lines = []
    for i, (name, pts) in enumerate(series):
        vis = visible(pts)
        d = "".join(f"{'L' if k else 'M'}{sx(x):.1f},{sy(y):.1f}" for k, (x, y) in enumerate(vis))
        lx, ly = vis[-1]
        lines.append(
            f"<g><title>{escape(name)}: ends at {escape(fmt(ly))} (x = {lx:g})</title>"
            f'<path class="s{i}" d="{d}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'
            f'<circle class="s{i}f ring" cx="{sx(lx):.1f}" cy="{sy(ly):.1f}" r="4" stroke-width="2"/></g>'
        )

    labels = ""
    if len(series) <= 4:
        labels = "".join(
            f'<line class="axis" x1="{e["x"] + 6:.1f}" y1="{e["y"]:.1f}" x2="{left + pw + 8}" y2="{e["label_y"]:.1f}"/>'
            f'<text class="ink" x="{left + pw + 12}" y="{e["label_y"] + 4:.1f}">{escape(e["name"])}</text>'
            for e in ends
        )
    legend = ""
    if len(series) > 4:
        parts = []
        for i, (name, _) in enumerate(series):
            x = left + i * pw / len(series)
            y = H - 16
            parts.append(
                f'<line class="s{i}" x1="{x:.1f}" x2="{x + 18:.1f}" y1="{y - 4}" y2="{y - 4}" stroke-width="2"/>'
                f'<text class="ink" x="{x + 24:.1f}" y="{y}">{escape(name)}</text>'
            )
        legend = "".join(parts)

    def palette(colors):
        return "".join(f".s{i}{{stroke:{c}}}.s{i}f{{fill:{c}}}" for i, c in enumerate(colors))

    sub = f'<text class="sub" x="{left}" y="44">{escape(subtitle)}</text>' if subtitle else ""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="12" role="img" aria-label="{escape(title)}">
<style>
.bg{{fill:#fcfcfb}}.ink{{fill:#0b0b0b}}.sub{{fill:#52514e}}.muted{{fill:#898781}}.grid{{stroke:#e1e0d9;stroke-width:1}}.axis{{stroke:#c3c2b7;stroke-width:1}}.ring{{stroke:#fcfcfb}}{palette(LIGHT)}
@media (prefers-color-scheme: dark){{.bg{{fill:#1a1a19}}.ink{{fill:#ffffff}}.sub{{fill:#c3c2b7}}.grid{{stroke:#2c2c2a}}.axis{{stroke:#383835}}.ring{{stroke:#1a1a19}}{palette(DARK)}}}
</style>
<rect class="bg" width="{W}" height="{H}" rx="8"/>
<text class="ink" x="{left}" y="24" font-size="15" font-weight="600">{escape(title)}</text>
{sub}
{grid}
<line class="axis" x1="{left}" x2="{left + pw}" y1="{top + ph}" y2="{top + ph}"/>
{x_axis}
<text class="sub" x="{left + pw / 2:.1f}" y="{top + ph + 38}" text-anchor="middle">{escape(x_label)}</text>
<text class="sub" transform="translate(16 {top + ph / 2:.1f}) rotate(-90)" text-anchor="middle">{escape(y_label)}</text>
{"".join(lines)}
{labels}
{legend}
</svg>
"""
