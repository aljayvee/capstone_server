import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CONTENT_WIDTH,
  erase,
  renderReportDocument,
  type ReportDocumentSpec,
} from "../src/services/pdf/reportDocument.js";
import { formatPeso, formatPesoAscii } from "../src/lib/formatPeso.js";

interface Row {
  category: string;
  revenue: number;
}

function spec(partial: Partial<ReportDocumentSpec> = {}): ReportDocumentSpec {
  return {
    reportName: "Sales Report",
    periodLabel: "MONTHLY",
    rangeLabel: "September 2026",
    generatedAt: new Date("2026-09-01T10:00:00Z"),
    generatedBy: "Aljay Vee Versola",
    summary: [{ label: "Total revenue", value: formatPesoAscii(125000) }],
    tables: [
      erase<Row>({
        columns: [
          { header: "Merchant category", width: 320, value: (r) => r.category },
          { header: "Revenue", width: 200, align: "right", value: (r) => formatPesoAscii(r.revenue) },
        ],
        rows: [
          { category: "Supermarket & Grocery", revenue: 90000 },
          { category: "Pharmacy & Health", revenue: 35000 },
        ],
        totals: ["Total", formatPesoAscii(125000)],
      }),
    ],
    ...partial,
  };
}

/** Page count, read from the trailer PDFKit writes. */
function pageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/** Every string PDFKit actually drew, decoded from the content streams. */
function drawnStrings(pdf: Buffer): string[] {
  let content = "";
  for (const m of pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      content += inflateSync(Buffer.from(m[1], "latin1")).toString("latin1") + "\n";
    } catch {
      /* fonts and other non-flate streams */
    }
  }

  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith("[") || !line.includes("TJ")) continue;
    let s = "";
    for (const hex of line.matchAll(/<([0-9a-fA-F]+)>/g)) {
      s += Buffer.from(hex[1], "hex").toString("latin1");
    }
    if (s.trim()) out.push(s);
  }
  return out;
}

describe("renderReportDocument", () => {
  it("produces a real PDF", async () => {
    const pdf = await renderReportDocument(spec());

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("renders an empty period rather than throwing", async () => {
    // A report for a quiet day must still print — letterhead, headers and a
    // stated absence. Throwing would leave the owner unable to tell an empty
    // period from a broken export.
    const pdf = await renderReportDocument(
      spec({ tables: [erase<Row>({ columns: spec().tables[0].columns, rows: [], totals: undefined })] })
    );

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("pages a long table and keeps every page in one document", async () => {
    const rows: Row[] = Array.from({ length: 300 }, (_, i) => ({
      category: `Category ${i}`,
      revenue: i * 11.11,
    }));

    const pdf = await renderReportDocument(
      spec({
        tables: [
          erase<Row>({
            columns: [
              { header: "Merchant category", width: 320, value: (r) => r.category },
              {
                header: "Revenue",
                width: 200,
                align: "right",
                value: (r) => formatPesoAscii(r.revenue),
              },
            ],
            rows,
          }),
        ],
      })
    );

    expect(pageCount(pdf)).toBeGreaterThan(1);
  });

  it("numbers every page, with no gaps", async () => {
    // REGRESSION: the footer sits below the bottom text margin, and PDFKit
    // answered that by auto-inserting a page mid-loop — which shifted the page
    // being written and left exactly one page ("Page 5 of 8") with no footer at
    // all. Nothing else about the document looked wrong.
    const rows: Row[] = Array.from({ length: 300 }, (_, i) => ({
      category: `Category ${i}`,
      revenue: i,
    }));

    const pdf = await renderReportDocument(
      spec({
        tables: [
          erase<Row>({
            columns: [
              { header: "Category", width: 400, value: (r) => r.category },
              { header: "Revenue", width: 120, align: "right", value: (r) => String(r.revenue) },
            ],
            rows,
          }),
        ],
      })
    );

    const total = pageCount(pdf);
    const labels = drawnStrings(pdf).filter((s) => s.startsWith("Page "));

    expect(total).toBeGreaterThan(1);
    expect(labels).toEqual(
      Array.from({ length: total }, (_, i) => `Page ${i + 1} of ${total}`)
    );
  });

  it("draws headings and notes at the left margin, not wherever the last cell ended", async () => {
    // REGRESSION: cells are drawn at explicit x offsets and PDFKit leaves the
    // cursor there, so the next unpositioned text() inherited it. Table titles
    // and the NOTES block were landing at x≈480 and wrapping to a few
    // characters against the right edge — "Throughput and " on its own line.
    const pdf = await renderReportDocument(
      spec({
        tables: [{ ...spec().tables[0], title: "Throughput and reliability" }],
        notes: ["A note that must not be squeezed against the right edge."],
      })
    );

    const strings = drawnStrings(pdf);
    expect(strings).toContain("Throughput and reliability");
    expect(strings).toContain("NOTES");
  });

  it("carries notes into the document", async () => {
    // Denominators live in notes. If they silently failed to render, a rate
    // would print with nothing saying what it rests on.
    const withNotes = await renderReportDocument(
      spec({ notes: ["On-time measured over 4 of 22 errands that carried an ETA."] })
    );
    const withoutNotes = await renderReportDocument(spec({ notes: [] }));

    expect(withNotes.length).toBeGreaterThan(withoutNotes.length);
  });

  it("handles a document with several differently-shaped tables", async () => {
    // Rider Performance needs two; erase() is what lets them share one document.
    const pdf = await renderReportDocument(
      spec({
        tables: [
          erase<Row>({
            title: "Throughput",
            columns: [{ header: "Category", width: 520, value: (r) => r.category }],
            rows: [{ category: "Fast Food & Restaurant", revenue: 0 }],
          }),
          erase<{ rider: string; earned: number }>({
            title: "Earnings",
            columns: [
              { header: "Rider", width: 300, value: (r) => r.rider },
              {
                header: "Earned",
                width: 220,
                align: "right",
                value: (r) => formatPesoAscii(r.earned),
              },
            ],
            rows: [{ rider: "Juan Dela Cruz", earned: 1250.5 }],
          }),
        ],
      })
    );

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("money in the PDF", () => {
  it("uses the ISO code, because the peso sign is not in PDFKit's WinAnsi fonts", async () => {
    // U+20B1 does not throw in PDFKit — it silently draws the wrong glyph. This
    // asserts the formatter never lets that character into a document.
    expect(formatPesoAscii(1234.5)).toBe("PHP 1,234.50");
    expect(formatPesoAscii(1234.5)).not.toContain("₱");
  });

  it("prints the same digits as the screen, differing only in the currency mark", () => {
    // The number an owner reads on the dashboard and the number on the printout
    // must never disagree; only the symbol may.
    for (const value of [0, 50, 205, 994.5, 1234.5, -300.25, 1000000]) {
      expect(formatPesoAscii(value).replace("PHP ", "")).toBe(formatPeso(value).replace("₱", ""));
    }
  });

  it("keeps centavos only when there are any", () => {
    expect(formatPesoAscii(205)).toBe("PHP 205");
    expect(formatPesoAscii(994.5)).toBe("PHP 994.50");
  });
});

describe("column widths", () => {
  it("is a fixed content width every spec must divide", () => {
    // Columns are laid out at absolute offsets, so a set that oversums runs off
    // the page edge silently. This is the constant every builder is checked
    // against in reportPdfService's own test.
    expect(CONTENT_WIDTH).toBe(520);
  });
});
