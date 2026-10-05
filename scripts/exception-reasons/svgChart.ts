/**
 * A small static SVG line chart for the experiment report.
 *
 * Static because the charts are embedded in Markdown, where no script runs.
 * Each line carries a native <title> tooltip, the numbers behind every chart
 * are also printed as tables in EXPERIMENTS.md, and lines are labelled at their
 * ends (up to four series) so identity is never colour alone. Colours are the
 * validated reference palette, in fixed order, with a dark-mode block.
 */

export interface LineSeries {
  name: string;
  points: Array<[number, number]>;
}

const LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
const DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function niceTicks(lo: number, hi: number, count = 5): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  // No 2.5 step: its ticks (0.25, 0.75) would print as 0.3 and 0.8 at one decimal.
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? raw;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return ticks;
}

export function lineChart(opts: {
  title: string;
  subtitle?: string;
  xLabel: string;
  yLabel: string;
  series: LineSeries[];
  yMin?: number;
  yMax?: number;
  xMax?: number;
  yFormat?: (v: number) => string;
}): string {
  if (opts.series.length > LIGHT.length) throw new Error(`At most ${LIGHT.length} series per chart.`);
  const W = 720;
  const H = 380;
  const left = 64;
  const right = opts.series.length <= 4 ? 150 : 24;
  const top = opts.subtitle ? 64 : 48;
  const legendRows = opts.series.length > 4 ? 1 : 0;
  const bottom = 52 + legendRows * 26;
  const pw = W - left - right;
  const ph = H - top - bottom;

  const all = opts.series.flatMap((s) => s.points).filter(([, y]) => Number.isFinite(y));
  const xMax = opts.xMax ?? Math.max(...all.map(([x]) => x));
  const xMin = Math.min(...all.map(([x]) => x));
  const yMin = opts.yMin ?? Math.min(...all.map(([, y]) => y));
  const yMax = opts.yMax ?? Math.max(...all.map(([, y]) => y));
  const fmt = opts.yFormat ?? ((v: number) => String(v));
  const sx = (x: number) => left + ((x - xMin) / (xMax - xMin || 1)) * pw;
  const sy = (y: number) => top + ph - ((Math.min(Math.max(y, yMin), yMax) - yMin) / (yMax - yMin || 1)) * ph;

  const yTicks = niceTicks(yMin, yMax);
  const xTicks = niceTicks(xMin, xMax, 6);

  const grid = yTicks
    .map(
      (t) =>
        `<line class="grid" x1="${left}" x2="${left + pw}" y1="${sy(t)}" y2="${sy(t)}"/>` +
        `<text class="muted" x="${left - 8}" y="${sy(t) + 4}" text-anchor="end">${esc(fmt(t))}</text>`
    )
    .join("");
  const xAxis = xTicks
    .map((t) => `<text class="muted" x="${sx(t)}" y="${top + ph + 18}" text-anchor="middle">${t}</text>`)
    .join("");

  // End labels, nudged apart only when two would overlap, with a leader line
  // back to the line's end so a nudged label is never detached from it.
  const ends = opts.series
    .map((s, i) => {
      const pts = s.points.filter(([x, y]) => Number.isFinite(y) && x <= xMax);
      const last = pts[pts.length - 1];
      return { i, name: s.name, x: sx(last[0]), y: sy(last[1]), labelY: sy(last[1]) };
    })
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) {
    if (ends[k].labelY - ends[k - 1].labelY < 14) ends[k].labelY = ends[k - 1].labelY + 14;
  }

  const lines = opts.series
    .map((s, i) => {
      const pts = s.points.filter(([x, y]) => Number.isFinite(y) && x <= xMax);
      const d = pts.map(([x, y], k) => `${k ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join("");
      const last = pts[pts.length - 1];
      return (
        `<g><title>${esc(s.name)}: ends at ${esc(fmt(last[1]))} (x = ${last[0]})</title>` +
        `<path class="s${i}" d="${d}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
        `<circle class="s${i}f ring" cx="${sx(last[0])}" cy="${sy(last[1])}" r="4" stroke-width="2"/></g>`
      );
    })
    .join("");

  const labels =
    opts.series.length <= 4
      ? ends
          .map(
            (e) =>
              `<line class="axis" x1="${e.x + 6}" y1="${e.y}" x2="${left + pw + 8}" y2="${e.labelY}"/>` +
              `<text class="ink" x="${left + pw + 12}" y="${e.labelY + 4}">${esc(e.name)}</text>`
          )
          .join("")
      : "";

  const legend =
    opts.series.length > 4
      ? opts.series
          .map((s, i) => {
            const x = left + (i * pw) / opts.series.length;
            const y = H - 16;
            return `<line class="s${i}" x1="${x}" x2="${x + 18}" y1="${y - 4}" y2="${y - 4}" stroke-width="2"/><text class="ink" x="${x + 24}" y="${y}">${esc(s.name)}</text>`;
          })
          .join("")
      : "";

  const vars = (colors: string[]) => colors.map((c, i) => `.s${i}{stroke:${c}}.s${i}f{fill:${c}}`).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="12" role="img" aria-label="${esc(opts.title)}">
<style>
.bg{fill:#fcfcfb}.ink{fill:#0b0b0b}.sub{fill:#52514e}.muted{fill:#898781}.grid{stroke:#e1e0d9;stroke-width:1}.axis{stroke:#c3c2b7;stroke-width:1}.ring{stroke:#fcfcfb}${vars(LIGHT)}
@media (prefers-color-scheme: dark){.bg{fill:#1a1a19}.ink{fill:#ffffff}.sub{fill:#c3c2b7}.grid{stroke:#2c2c2a}.axis{stroke:#383835}.ring{stroke:#1a1a19}${vars(DARK)}}
</style>
<rect class="bg" width="${W}" height="${H}" rx="8"/>
<text class="ink" x="${left}" y="24" font-size="15" font-weight="600">${esc(opts.title)}</text>
${opts.subtitle ? `<text class="sub" x="${left}" y="44">${esc(opts.subtitle)}</text>` : ""}
${grid}
<line class="axis" x1="${left}" x2="${left + pw}" y1="${top + ph}" y2="${top + ph}"/>
${xAxis}
<text class="sub" x="${left + pw / 2}" y="${top + ph + 38}" text-anchor="middle">${esc(opts.xLabel)}</text>
<text class="sub" transform="translate(16 ${top + ph / 2}) rotate(-90)" text-anchor="middle">${esc(opts.yLabel)}</text>
${lines}
${labels}
${legend}
</svg>
`;
}
