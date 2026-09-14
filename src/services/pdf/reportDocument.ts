import PDFDocument from "pdfkit";

/**
 * The one printed format every Owner report comes out in.
 *
 * Replaces `window.print()` on the live dashboard, which had no print
 * stylesheet at all — so a "printed report" carried the sidebar, the header
 * clock, the notification bell and the modal backdrop, and its column widths
 * depended on how wide the operator's browser happened to be. Two people
 * printing the same report got two different documents.
 *
 * Everything here is layout. The numbers arrive already computed by
 * reportService, which is also what the JSON endpoint returns — see
 * reportPdfService for why that sharing is not optional.
 */

const PAGE = { size: "LETTER" as const, margin: { top: 56, bottom: 54, left: 46, right: 46 } };
const CONTENT_WIDTH = 612 - PAGE.margin.left - PAGE.margin.right; // 520pt
const FOOTER_HEIGHT = 26;
const HEADER_BAND_HEIGHT = 18;

const INK = {
  text: "#0F172A",
  muted: "#64748B",
  rule: "#CBD5E1",
  band: "#F1F5F9",
  zebra: "#F8FAFC",
  brand: "#1E3A5F",
};

export interface ReportColumn<Row> {
  header: string;
  /** Points. The sum across all columns must equal CONTENT_WIDTH (520). */
  width: number;
  align?: "left" | "right";
  value: (row: Row) => string;
}

export interface ReportTable<Row> {
  /** Shown above the table when a document carries more than one. */
  title?: string;
  columns: ReportColumn<Row>[];
  rows: Row[];
  /** One cell per column; null leaves the cell blank. */
  totals?: Array<string | null>;
}

/**
 * A table whose row type has been erased so one document can hold several with
 * different shapes.
 *
 * The layout code below never inspects a row — it only calls `value(row)` on
 * columns that came from the same `ReportTable<Row>` — so erasing the type here
 * loses nothing that was being checked. `erase()` is the single place the cast
 * happens, and it keeps the correlation by construction.
 */
export interface ErasedTable {
  title?: string;
  columns: ReportColumn<unknown>[];
  rows: unknown[];
  totals?: Array<string | null>;
}

/** The one sanctioned way to put a typed table into a document spec. */
export function erase<Row>(table: ReportTable<Row>): ErasedTable {
  return {
    title: table.title,
    columns: table.columns as ReportColumn<unknown>[],
    rows: table.rows as unknown[],
    totals: table.totals,
  };
}

export interface ReportDocumentSpec {
  reportName: string;
  periodLabel: string;
  rangeLabel: string;
  generatedAt: Date;
  generatedBy: string;
  /** The figures the on-screen tiles show, rendered as a meta strip. */
  summary: Array<{ label: string; value: string }>;
  /**
   * One or more tables. Rider Performance needs two — twelve metrics will not
   * fit Letter portrait at a legible size — but they share one document, one
   * letterhead and one footer sequence.
   */
  tables: ErasedTable[];
  /**
   * Denominators and caveats. These are not decoration: "on-time 75%" and
   * "on-time 75% over 4 of 22 errands that carried an ETA" support different
   * decisions, and only one of them is honest.
   */
  notes?: string[];
}

/** Renders a spec to a finished PDF. Resolves only once the buffer is complete. */
export function renderReportDocument(spec: ReportDocumentSpec): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: PAGE.size,
      margins: PAGE.margin,
      // Required: "Page 2 of 5" needs a total that is only known once the last
      // row has been laid out, so pages must stay buffered until then.
      bufferPages: true,
      info: {
        Title: `${spec.reportName} — ${spec.rangeLabel}`,
        Author: "Sugo Express",
        Subject: `${spec.periodLabel} report`,
        CreationDate: spec.generatedAt,
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      drawLetterhead(doc, spec);

      spec.tables.forEach((table, index) => {
        if (index > 0) doc.moveDown(1.2);
        drawTable(doc, table);
      });

      if (spec.notes?.length) drawNotes(doc, spec.notes);

      drawFooters(doc, spec);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ── letterhead ─────────────────────────────────────────────────────────────
// Page 1 only. Repeating the full block on every page would eat a third of each
// one; what a continuation page actually needs is the column headers, and
// `pageAdded` below draws those.

function drawLetterhead(doc: PDFKit.PDFDocument, spec: ReportDocumentSpec) {
  doc.fillColor(INK.brand).fontSize(15).font("Helvetica-Bold").text("SUGO EXPRESS");
  doc
    .fillColor(INK.muted)
    .fontSize(8)
    .font("Helvetica")
    .text("On-the-Go Logistics Services — Tacurong City");

  doc.moveDown(0.45);
  rule(doc, doc.y, 1, INK.brand);
  doc.moveDown(0.7);

  doc.fillColor(INK.text).fontSize(16).font("Helvetica-Bold").text(spec.reportName);
  doc.moveDown(0.5);

  // Two columns of provenance. Who ran it and when is what makes a printed
  // figure answerable months later.
  const top = doc.y;
  const colWidth = CONTENT_WIDTH / 2;
  metaPair(doc, "Period", spec.periodLabel, PAGE.margin.left, top, colWidth);
  metaPair(doc, "Covering", spec.rangeLabel, PAGE.margin.left, top + 15, colWidth);
  metaPair(doc, "Generated", formatStamp(spec.generatedAt), PAGE.margin.left + colWidth, top, colWidth);
  metaPair(doc, "Generated by", spec.generatedBy, PAGE.margin.left + colWidth, top + 15, colWidth);

  doc.y = top + 34;
  resetX(doc);

  if (spec.summary.length > 0) {
    doc.moveDown(0.3);
    rule(doc, doc.y, 0.5, INK.rule);
    doc.moveDown(0.5);

    const cellWidth = CONTENT_WIDTH / spec.summary.length;
    const summaryTop = doc.y;
    spec.summary.forEach((item, i) => {
      const x = PAGE.margin.left + i * cellWidth;
      doc
        .fillColor(INK.muted)
        .fontSize(7)
        .font("Helvetica-Bold")
        .text(item.label.toUpperCase(), x, summaryTop, { width: cellWidth - 6 });
      doc
        .fillColor(INK.text)
        .fontSize(11)
        .font("Helvetica-Bold")
        .text(item.value, x, summaryTop + 10, { width: cellWidth - 6 });
    });
    doc.y = summaryTop + 26;
  }
  resetX(doc);

  doc.moveDown(0.4);
}

function metaPair(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  x: number,
  y: number,
  width: number
) {
  doc.fillColor(INK.muted).fontSize(7.5).font("Helvetica-Bold").text(`${label.toUpperCase()}  `, x, y, {
    continued: true,
    width,
  });
  doc.fillColor(INK.text).fontSize(8).font("Helvetica").text(value, { width });
}

// ── tables ─────────────────────────────────────────────────────────────────

function drawTable(doc: PDFKit.PDFDocument, table: ErasedTable) {
  const xs = columnOffsets(table.columns);
  resetX(doc);

  if (table.title) {
    doc.fillColor(INK.text).fontSize(10).font("Helvetica-Bold").text(table.title);
    doc.moveDown(0.35);
  }

  // Repeat the column band on every page this table spills onto. Registered per
  // table and removed after, so a second table's headers do not appear over the
  // first one's continuation pages.
  const onPageAdded = () => {
    doc.y = PAGE.margin.top;
    drawHeaderBand(doc, table.columns, xs);
  };

  drawHeaderBand(doc, table.columns, xs);
  doc.on("pageAdded", onPageAdded);

  try {
    if (table.rows.length === 0) {
      doc
        .fillColor(INK.muted)
        .fontSize(9)
        .font("Helvetica-Oblique")
        .text("No data for this period.", PAGE.margin.left, doc.y + 8, {
          width: CONTENT_WIDTH,
          align: "center",
        });
      doc.y += 8;
      return;
    }

    table.rows.forEach((row, index) => {
      const cells = table.columns.map((c) => c.value(row));
      const height = rowHeight(doc, table.columns, cells);

      if (doc.y + height > pageBottom(doc)) doc.addPage();

      if (index % 2 === 1) {
        doc.rect(PAGE.margin.left, doc.y - 2, CONTENT_WIDTH, height + 2).fill(INK.zebra);
      }

      drawRow(doc, table.columns, xs, cells, height, "Helvetica", INK.text);
    });

    if (table.totals) {
      const height = rowHeight(doc, table.columns, table.totals.map((t) => t ?? ""));
      // A totals row stranded on a page with no rows above it is worse than a
      // slightly short page, so it moves whole rather than being orphaned.
      if (doc.y + height + 6 > pageBottom(doc)) doc.addPage();

      doc.moveDown(0.15);
      rule(doc, doc.y, 0.7, INK.text);
      doc.moveDown(0.25);
      drawRow(
        doc,
        table.columns,
        xs,
        table.totals.map((t) => t ?? ""),
        height,
        "Helvetica-Bold",
        INK.text
      );
    }
  } finally {
    doc.off("pageAdded", onPageAdded);
  }
}

function drawHeaderBand(
  doc: PDFKit.PDFDocument,
  columns: ReportColumn<unknown>[],
  xs: number[]
) {
  const top = doc.y;
  doc.rect(PAGE.margin.left, top - 2, CONTENT_WIDTH, HEADER_BAND_HEIGHT).fill(INK.band);

  doc.fillColor(INK.muted).fontSize(7.5).font("Helvetica-Bold");
  columns.forEach((column, i) => {
    doc.text(column.header.toUpperCase(), xs[i], top + 3.5, {
      width: column.width - 6,
      align: column.align ?? "left",
      lineBreak: false,
    });
  });

  doc.y = top + HEADER_BAND_HEIGHT + 2;
  resetX(doc);
}

function drawRow(
  doc: PDFKit.PDFDocument,
  columns: ReportColumn<unknown>[],
  xs: number[],
  cells: string[],
  height: number,
  font: string,
  color: string
) {
  const top = doc.y;
  doc.fillColor(color).fontSize(8).font(font);
  columns.forEach((column, i) => {
    doc.text(cells[i], xs[i], top, {
      width: column.width - 6,
      align: column.align ?? "left",
    });
  });
  doc.y = top + height;
  resetX(doc);
}

function rowHeight(doc: PDFKit.PDFDocument, columns: ReportColumn<unknown>[], cells: string[]): number {
  doc.fontSize(8).font("Helvetica");
  const tallest = Math.max(
    ...columns.map((c, i) => doc.heightOfString(cells[i], { width: c.width - 6 }))
  );
  return Math.max(tallest, 11) + 4;
}

function columnOffsets(columns: ReportColumn<unknown>[]): number[] {
  const xs: number[] = [];
  let x = PAGE.margin.left;
  for (const column of columns) {
    xs.push(x);
    x += column.width;
  }
  return xs;
}

// ── notes and footer ───────────────────────────────────────────────────────

function drawNotes(doc: PDFKit.PDFDocument, notes: string[]) {
  const needed = 14 + notes.length * 20;
  if (doc.y + needed > pageBottom(doc)) doc.addPage();
  resetX(doc);

  doc.moveDown(0.9);
  doc.fillColor(INK.muted).fontSize(7.5).font("Helvetica-Bold").text("NOTES");
  doc.moveDown(0.25);

  doc.fontSize(7.5).font("Helvetica-Oblique").fillColor(INK.muted);
  for (const note of notes) {
    doc.text(`•  ${note}`, { width: CONTENT_WIDTH, indent: 2 });
    doc.moveDown(0.2);
  }
}

function drawFooters(doc: PDFKit.PDFDocument, spec: ReportDocumentSpec) {
  // Captured once, before the loop writes anything: the total is what "of n"
  // states, and it must not move while it is being printed.
  const range = doc.bufferedPageRange();
  const y = 792 - PAGE.margin.bottom + 8;

  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);

    // The footer sits BELOW the bottom text margin by design. PDFKit reacts to
    // that by auto-inserting a page, which then shifts the page the loop is
    // pointing at — one page silently ended up with no footer at all, and
    // "Page 5 of 8" was simply absent from an otherwise correct document.
    //
    // Suspending the margin for the duration is the documented way to write
    // into that band. It has to be done per page, because `doc.page` is
    // whichever page switchToPage just selected.
    const restore = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    rule(doc, y - 6, 0.5, INK.rule);

    doc.fillColor(INK.muted).fontSize(7).font("Helvetica");
    doc.text(`Sugo Express — ${spec.reportName} — ${spec.rangeLabel}`, PAGE.margin.left, y, {
      width: CONTENT_WIDTH * 0.7,
      lineBreak: false,
    });
    doc.text(`Page ${i + 1} of ${range.count}`, PAGE.margin.left + CONTENT_WIDTH * 0.7, y, {
      width: CONTENT_WIDTH * 0.3,
      align: "right",
      lineBreak: false,
    });

    doc.page.margins.bottom = restore;
  }
}

/**
 * Returns the cursor to the left margin.
 *
 * Every cell is drawn with an explicit x, and PDFKit leaves the cursor wherever
 * the last one landed. Any `doc.text()` afterwards that does not pass an x
 * inherits that — which put the table titles and the NOTES block at x≈480,
 * wrapped to a few characters against the right edge. Call this at the end of
 * any block that positions text by hand.
 */
function resetX(doc: PDFKit.PDFDocument) {
  doc.x = PAGE.margin.left;
}

function rule(doc: PDFKit.PDFDocument, y: number, weight: number, color: string) {
  doc
    .moveTo(PAGE.margin.left, y)
    .lineTo(PAGE.margin.left + CONTENT_WIDTH, y)
    .lineWidth(weight)
    .strokeColor(color)
    .stroke();
}

function pageBottom(doc: PDFKit.PDFDocument): number {
  return 792 - PAGE.margin.bottom - FOOTER_HEIGHT;
}

function formatStamp(date: Date): string {
  return date.toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export { CONTENT_WIDTH };
