import type { ReasonContext } from "../../src/services/patterns/exceptionReasonModel.js";

/**
 * The training set's file format: one ReasonContext per row, plus its label.
 *
 * CSV so it opens in a spreadsheet. Shared by the generator that writes it and
 * the trainer that reads it, so the two cannot disagree about a column.
 */

export interface LabelledRow {
  context: ReasonContext;
  /** A REASONS code from exceptionReasonModel.ts. */
  label: string;
  /** Where the row came from: "scenario" for generated, "production" for a real errand. */
  source: string;
  /** Any further columns, in file order (real-jobs.csv carries the dispatcher's own words). */
  extra?: Record<string, string>;
}

const COLUMNS = [
  "kind",
  "amountAtRisk",
  "billTotal",
  "basket",
  "plan",
  "cashDirection",
  "riderNote",
  "receiptPhotos",
  "noReceiptPhotos",
  "hasCashPhoto",
  "hasDeliveryPhoto",
  "transferProofs",
  "hasRiderBalanceProof",
  "settledInFull",
  "paidUpFront",
  "scannedTotal",
  "confirmedTotal",
  "storeName",
  "observedName",
  "itemsAtStop",
  "receiptsCoverBasket",
  "dwellMinutes",
] as const satisfies readonly (keyof ReasonContext)[];

const BOOLEAN_COLUMNS = new Set<string>([
  "hasCashPhoto",
  "hasDeliveryPhoto",
  "hasRiderBalanceProof",
  "settledInFull",
]);
const TEXT_COLUMNS = new Set<string>(["kind", "plan", "cashDirection", "riderNote", "storeName", "observedName"]);

function quote(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: LabelledRow[], extraColumns: string[] = []): string {
  const header = [...COLUMNS, "label", "source", ...extraColumns].join(",");
  const lines = rows.map((row) =>
    [
      ...COLUMNS.map((col) => {
        const v = row.context[col];
        return typeof v === "boolean" ? (v ? "1" : "0") : quote(String(v));
      }),
      quote(row.label),
      quote(row.source),
      ...extraColumns.map((col) => quote(row.extra?.[col] ?? "")),
    ].join(",")
  );
  return [header, ...lines].join("\n") + "\n";
}

/** RFC 4180 enough for this file: quoted fields, doubled quotes, commas inside quotes. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

export function fromCsv(text: string): LabelledRow[] {
  const [headerLine, ...lines] = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = splitLine(headerLine);
  const expected = [...COLUMNS, "label", "source"];
  const extraColumns = header.slice(expected.length);
  if (header.slice(0, expected.length).join(",") !== expected.join(",")) {
    throw new Error(`Unexpected columns.\n  got:      ${header.join(",")}\n  expected: ${expected.join(",")}`);
  }

  return lines.map((line, n) => {
    const cells = splitLine(line);
    if (cells.length !== header.length) {
      throw new Error(`Row ${n + 2} has ${cells.length} cells, expected ${header.length}.`);
    }
    const context: Record<string, unknown> = {};
    COLUMNS.forEach((col, i) => {
      const raw = cells[i];
      context[col] = BOOLEAN_COLUMNS.has(col)
        ? raw === "1"
        : TEXT_COLUMNS.has(col)
          ? raw
          : Number(raw);
    });
    return {
      context: context as unknown as ReasonContext,
      label: cells[COLUMNS.length],
      source: cells[COLUMNS.length + 1],
      extra: Object.fromEntries(extraColumns.map((col, i) => [col, cells[expected.length + i]])),
    };
  });
}
