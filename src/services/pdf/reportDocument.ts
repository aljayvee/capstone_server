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
 * Letter, landscape, with the same half-inch margin on all four sides and one
 * type scale (TYPE below), so every report prints with the same frame and the
 * same sizes whichever of the six it is.
 *
 * Everything here is layout. The numbers arrive already computed by
 * reportService, which is also what the JSON endpoint returns — see
 * reportPdfService for why that sharing is not optional.
 */

const PAGE_WIDTH = 792;
const PAGE_HEIGHT = 612;
const MARGIN = 36; // 0.5in, every side
const PAGE = {
  size: "LETTER" as const,
  layout: "landscape" as const,
  margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
};
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN; // 720pt
/** Space the footer takes inside the bottom margin box. */
const FOOTER_HEIGHT = 20;
const HEADER_BAND_HEIGHT = 20;
/** "Printed by:" through the printed-at line. */
const SIGNATURE_HEIGHT = 86;
const SIGNATURE_RULE_WIDTH = 220;

/** The only sizes a report uses. */
const TYPE = {
  brand: 14,
  tagline: 9,
  title: 16,
  section: 11,
  meta: 9,
  label: 7.5,
  summary: 12,
  body: 9,
  note: 8.5,
  footer: 8,
};

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
  /**
   * A proportion, not points: a table's widths are scaled together to fill
   * CONTENT_WIDTH, so a column set can never run off the page edge.
   */
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

/** Whoever printed the report, as the signatory block names them. */
export interface ReportSignatory {
  fullName: string;
  /** "Owner", "System Administrator". */
  roleLabel: string;
}

export interface ReportDocumentSpec {
  reportName: string;
  /** "Daily (Sunday to Saturday)". */
  periodName: string;
  /** "This week, by day: Sunday, Oct 18, 2026 to Saturday, Oct 24, 2026". */
  coverageLabel: string;
  /** The short window label, for the document's metadata title. */
  rangeLabel: string;
  /** Who or what the report is narrowed to, e.g. { label: "Rider", value: "Juan Dela Cruz" }. */
  subject?: { label: string; value: string };
  printedAt: Date;
  printedBy: ReportSignatory;
  /** The figures the on-screen tiles show, rendered as a meta strip. */
  summary: Array<{ label: string; value: string }>;
  /**
   * One or more tables. The first is the period breakdown (one row per day,
   * week, month or year); Rider Performance adds two more, since twelve
   * metrics will not fit one table at a legible size.
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
      layout: PAGE.layout,
      margins: PAGE.margin,
      // Required: "Page 2 of 5" needs a total that is only known once the last
      // row has been laid out, so pages must stay buffered until then.
      bufferPages: true,
      info: {
        Title: `${spec.reportName}${spec.subject ? `, ${spec.subject.value}` : ""}, ${spec.rangeLabel}`,
        Author: "Sugo Express",
        Subject: spec.periodName,
        CreationDate: spec.printedAt,
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

      drawSignatory(doc, spec);
      drawFooters(doc, spec);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * The peso sign is not in PDFKit's built-in WinAnsi fonts: it does not throw,
 * it draws the wrong glyph. Money cells already use formatPesoAscii, but notes
 * and Help Desk details are composed for the screen and carry "₱".
 *
 * Those details also join their clauses with " — ", which the printed reports
 * do not use; a comma reads the same.
 */
function pdfSafe(text: string): string {
  return text.replace(/₱\s?/g, "PHP ").replace(/\s+—\s+/g, ", ");
}

// ── letterhead ─────────────────────────────────────────────────────────────
// Page 1 only. Repeating the full block on every page would eat a third of each
// one; what a continuation page actually needs is the column headers, and
// `pageAdded` below draws those.

function drawLetterhead(doc: PDFKit.PDFDocument, spec: ReportDocumentSpec) {
  doc.fillColor(INK.brand).fontSize(TYPE.brand).font("Helvetica-Bold").text("SUGO EXPRESS");
  doc
    .fillColor(INK.muted)
    .fontSize(TYPE.tagline)
    .font("Helvetica")
    .text("On-the-Go Logistics Services, Tacurong City");

  doc.moveDown(0.4);
  rule(doc, doc.y, 1, INK.brand);
  doc.moveDown(0.6);

  doc.fillColor(INK.text).fontSize(TYPE.title).font("Helvetica-Bold").text(spec.reportName);
  doc.moveDown(0.4);

  // Two columns: what the report covers on the left, when it was printed on
  // the right. Who printed it is the signatory block at the end.
  const top = doc.y;
  const left = CONTENT_WIDTH * 0.68;
  metaPair(doc, "Period", spec.periodName, PAGE.margin.left, top, left);
  metaPair(doc, "Dates covered", spec.coverageLabel, PAGE.margin.left, top + 15, left);
  if (spec.subject) {
    metaPair(doc, spec.subject.label, spec.subject.value, PAGE.margin.left, top + 30, left);
  }
  metaPair(
    doc,
    "Printed on",
    formatStamp(spec.printedAt),
    PAGE.margin.left + left,
    top,
    CONTENT_WIDTH - left
  );

  doc.y = top + (spec.subject ? 49 : 34);
  resetX(doc);

  if (spec.summary.length > 0) {
    doc.moveDown(0.2);
    rule(doc, doc.y, 0.5, INK.rule);
    doc.moveDown(0.5);

    const cellWidth = CONTENT_WIDTH / spec.summary.length;
    const summaryTop = doc.y;
    spec.summary.forEach((item, i) => {
      const x = PAGE.margin.left + i * cellWidth;
      doc
        .fillColor(INK.muted)
        .fontSize(TYPE.label)
        .font("Helvetica-Bold")
        .text(item.label.toUpperCase(), x, summaryTop, { width: cellWidth - 8 });
      doc
        .fillColor(INK.text)
        .fontSize(TYPE.summary)
        .font("Helvetica-Bold")
        .text(pdfSafe(item.value), x, summaryTop + 11, { width: cellWidth - 8 });
    });
    doc.y = summaryTop + 30;
  }
  resetX(doc);

  doc.moveDown(0.6);
}

function metaPair(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  x: number,
  y: number,
  width: number
) {
  doc.fillColor(INK.muted).fontSize(TYPE.label).font("Helvetica-Bold").text(`${label.toUpperCase()}   `, x, y, {
    continued: true,
    width,
  });
  doc.fillColor(INK.text).fontSize(TYPE.meta).font("Helvetica").text(value, { width });
}

// ── tables ─────────────────────────────────────────────────────────────────

/** Widths are proportions; this turns them into points that fill the page. */
function scaleColumns(columns: ReportColumn<unknown>[]): ReportColumn<unknown>[] {
  const sum = columns.reduce((total, c) => total + c.width, 0) || 1;
  return columns.map((c) => ({ ...c, width: (c.width / sum) * CONTENT_WIDTH }));
}

function drawTable(doc: PDFKit.PDFDocument, table: ErasedTable) {
  const columns = scaleColumns(table.columns);
  const xs = columnOffsets(columns);
  resetX(doc);

  // A title stranded at the foot of a page with its table on the next is
  // worse than a slightly short page. So is a column band with no row under
  // it: a first row that wraps to several lines once left both behind, so the
  // title, the band and the first row are measured and kept together.
  const firstRow = table.rows[0];
  const keepTogether =
    (table.title ? titleHeight(doc, table.title) : 0) +
    headerBandHeight(doc, columns) +
    (firstRow ? rowHeight(doc, columns, columns.map((c) => pdfSafe(c.value(firstRow)))) : 24);
  if (doc.y + Math.max(60, keepTogether) > pageBottom()) doc.addPage();

  if (table.title) {
    doc.fillColor(INK.text).fontSize(TYPE.section).font("Helvetica-Bold").text(table.title);
    doc.moveDown(0.35);
  }

  // Repeat the column band on every page this table spills onto. Registered per
  // table and removed after, so a second table's headers do not appear over the
  // first one's continuation pages.
  const onPageAdded = () => {
    doc.y = PAGE.margin.top;
    drawHeaderBand(doc, columns, xs);
  };

  drawHeaderBand(doc, columns, xs);
  doc.on("pageAdded", onPageAdded);

  try {
    if (table.rows.length === 0) {
      doc
        .fillColor(INK.muted)
        .fontSize(TYPE.body)
        .font("Helvetica-Oblique")
        .text("Nothing recorded for these dates.", PAGE.margin.left, doc.y + 8, {
          width: CONTENT_WIDTH,
          align: "center",
        });
      doc.y += 8;
      return;
    }

    table.rows.forEach((row, index) => {
      const cells = columns.map((c) => pdfSafe(c.value(row)));
      const height = rowHeight(doc, columns, cells);

      if (doc.y + height > pageBottom()) doc.addPage();

      if (index % 2 === 1) {
        doc.rect(PAGE.margin.left, doc.y - 2, CONTENT_WIDTH, height + 2).fill(INK.zebra);
      }

      drawRow(doc, columns, xs, cells, height, "Helvetica", INK.text);
    });

    if (table.totals) {
      const totals = table.totals.map((t) => pdfSafe(t ?? ""));
      const height = rowHeight(doc, columns, totals);
      // A totals row stranded on a page with no rows above it is worse than a
      // slightly short page, so it moves whole rather than being orphaned.
      if (doc.y + height + 6 > pageBottom()) doc.addPage();

      doc.moveDown(0.15);
      rule(doc, doc.y, 0.7, INK.text);
      doc.moveDown(0.25);
      drawRow(doc, columns, xs, totals, height, "Helvetica-Bold", INK.text);
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
  const height = headerBandHeight(doc, columns);

  doc.rect(PAGE.margin.left, top - 2, CONTENT_WIDTH, height).fill(INK.band);
  doc.fillColor(INK.muted);
  columns.forEach((column, i) => {
    doc.text(column.header.toUpperCase(), xs[i] + 4, top + 4.5, {
      width: column.width - 8,
      align: column.align ?? "left",
    });
  });

  doc.y = top + height + 3;
  resetX(doc);
}

/** Leaves the label font set, which drawHeaderBand draws in. */
function headerBandHeight(doc: PDFKit.PDFDocument, columns: ReportColumn<unknown>[]): number {
  doc.fillColor(INK.muted).fontSize(TYPE.label).font("Helvetica-Bold");

  // Grows to the tallest header. A long one ("Orders per hour online") wraps in
  // a narrow column, and a fixed band let its second line spill onto the first row.
  const tallest = Math.max(
    ...columns.map((c) => doc.heightOfString(c.header.toUpperCase(), { width: c.width - 8 }))
  );
  return Math.max(HEADER_BAND_HEIGHT, tallest + 10);
}

function titleHeight(doc: PDFKit.PDFDocument, title: string): number {
  doc.fontSize(TYPE.section).font("Helvetica-Bold");
  return doc.heightOfString(title, { width: CONTENT_WIDTH }) + doc.currentLineHeight() * 0.35;
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
  doc.fillColor(color).fontSize(TYPE.body).font(font);
  columns.forEach((column, i) => {
    doc.text(cells[i], xs[i] + 4, top, {
      width: column.width - 8,
      align: column.align ?? "left",
    });
  });
  doc.y = top + height;
  resetX(doc);
}

function rowHeight(doc: PDFKit.PDFDocument, columns: ReportColumn<unknown>[], cells: string[]): number {
  doc.fontSize(TYPE.body).font("Helvetica");
  const tallest = Math.max(
    ...columns.map((c, i) => doc.heightOfString(cells[i], { width: c.width - 8 }))
  );
  return Math.max(tallest, 12) + 5;
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

// ── notes, signatory and footer ────────────────────────────────────────────

function drawNotes(doc: PDFKit.PDFDocument, notes: string[]) {
  const needed = 16 + notes.length * 22;
  if (doc.y + needed > pageBottom()) doc.addPage();
  resetX(doc);

  doc.moveDown(0.9);
  doc.fillColor(INK.muted).fontSize(TYPE.label).font("Helvetica-Bold").text("ABOUT THESE NUMBERS");
  doc.moveDown(0.3);

  doc.fontSize(TYPE.note).font("Helvetica").fillColor(INK.muted);
  for (const note of notes) {
    doc.text(`•  ${pdfSafe(note)}`, { width: CONTENT_WIDTH, indent: 2 });
    doc.moveDown(0.2);
  }
}

/**
 * "Printed by:", room to sign, the rule, the printer's name and role, and
 * when — at the bottom-left of the last page.
 *
 * Anchored to the foot of the page rather than flowing after the notes, so it
 * sits where a signatory block is looked for. If the content above leaves no
 * room for it, it takes a page of its own rather than overlapping the last row.
 */
function drawSignatory(doc: PDFKit.PDFDocument, spec: ReportDocumentSpec) {
  const top = pageBottom() - SIGNATURE_HEIGHT;
  if (doc.y + 12 > top) doc.addPage();

  const x = PAGE.margin.left;
  const width = SIGNATURE_RULE_WIDTH;

  doc.fillColor(INK.muted).fontSize(TYPE.meta).font("Helvetica-Bold").text("Printed by:", x, top, { width });

  const ruleY = top + 44;
  doc
    .moveTo(x, ruleY)
    .lineTo(x + width, ruleY)
    .lineWidth(0.8)
    .strokeColor(INK.text)
    .stroke();

  doc
    .fillColor(INK.text)
    .fontSize(TYPE.section)
    .font("Helvetica-Bold")
    .text(spec.printedBy.fullName.toUpperCase(), x, ruleY + 5, { width, lineBreak: false });
  doc
    .fillColor(INK.text)
    .fontSize(TYPE.meta)
    .font("Helvetica")
    .text(spec.printedBy.roleLabel, x, ruleY + 20, { width, lineBreak: false });
  doc
    .fillColor(INK.muted)
    .fontSize(TYPE.footer)
    .font("Helvetica")
    .text(`Printed ${formatStamp(spec.printedAt)}`, x, ruleY + 33, { width, lineBreak: false });

  resetX(doc);
}

function drawFooters(doc: PDFKit.PDFDocument, spec: ReportDocumentSpec) {
  // Captured once, before the loop writes anything: the total is what "of n"
  // states, and it must not move while it is being printed.
  const range = doc.bufferedPageRange();
  const y = PAGE_HEIGHT - PAGE.margin.bottom - FOOTER_HEIGHT + 8;

  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);

    // The footer sits inside the margin box, but close enough to its bottom
    // edge that PDFKit's line-height check can still decide the text overflows
    // and auto-insert a page, which then shifts the page the loop is pointing
    // at. That once left "Page 5 of 8" absent from an otherwise correct
    // document. Suspending the margin while writing is the documented way to
    // rule it out, and it has to be per page, because `doc.page` is whichever
    // page switchToPage just selected.
    const restore = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    rule(doc, y - 6, 0.5, INK.rule);

    doc.fillColor(INK.muted).fontSize(TYPE.footer).font("Helvetica");
    const who = spec.subject ? `  |  ${spec.subject.value}` : "";
    doc.text(`Sugo Express  |  ${spec.reportName}${who}  |  ${spec.coverageLabel}`, PAGE.margin.left, y, {
      width: CONTENT_WIDTH * 0.8,
      lineBreak: false,
    });
    doc.text(`Page ${i + 1} of ${range.count}`, PAGE.margin.left + CONTENT_WIDTH * 0.8, y, {
      width: CONTENT_WIDTH * 0.2,
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

/** The lowest y content may reach: above the footer, inside the bottom margin. */
function pageBottom(): number {
  return PAGE_HEIGHT - PAGE.margin.bottom - FOOTER_HEIGHT - 4;
}

/**
 * "Oct 22, 2026, 3:15 PM", in Philippine time whatever the host clock says.
 * The VPS shell runs on Europe/Berlin; only the API process is set to Manila.
 */
export function formatStamp(date: Date): string {
  return date.toLocaleString("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export { CONTENT_WIDTH, PAGE_WIDTH, PAGE_HEIGHT, MARGIN };
