import { beforeEach, describe, expect, it, vi } from "vitest";

// Two real Tacurong receipts from the fixtures, on one two-stop errand.
const JOLLIBEE_TOTAL = 176.0;
const SAVEMORE_TOTAL = 994.0;

const ERRAND_ID = "ERR-2-STOPS";
const RIDER_ID = 7;

const markItemsPurchased = vi.fn();
const emitToErrand = vi.fn();

/** Rows standing in for errand_proof_images joined to receipt_extractions. */
let storedReceipts: { extraction: { confirmedTotal: number | null } }[] = [];
let imageById: Record<number, any> = {};

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    errandProofImage: {
      findMany: vi.fn(async () => storedReceipts),
      findUnique: vi.fn(async ({ where }: any) => imageById[where.id] ?? null),
      create: vi.fn(),
    },
    receiptExtraction: {
      update: vi.fn(async ({ where, data }: any) => ({
        id: where.id,
        extractedTotal: imageById[where.id]?.extraction?.extractedTotal ?? null,
        ...data,
      })),
    },
  },
}));

vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: {
    emitToErrand: (...a: unknown[]) => emitToErrand(...a),
    emit: vi.fn(),
    emitToRole: vi.fn(),
    emitToRider: vi.fn(),
  },
}));

vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/lib/ocr/resilientOcrService.js", () => ({
  readText: vi.fn(),
  configuredEngines: () => ["CLOUD_VISION"],
}));

vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: {
    findByIdBasic: vi.fn(async () => ({ id: ERRAND_ID, riderId: RIDER_ID })),
  },
}));

vi.mock("../src/services/errandService.js", () => ({
  markItemsPurchased: (...a: unknown[]) => markItemsPurchased(...a),
}));

const { confirmProofImage } = await import("../src/services/proofImageService.js");

/** Registers a receipt image the way an upload would have. */
function addReceipt(id: number, extractedTotal: number | null) {
  imageById[id] = {
    id,
    errandId: ERRAND_ID,
    kind: "RECEIPT",
    extraction: { id, extractedTotal, confirmedTotal: null },
  };
}

/** What the DB would hold once these ids have been confirmed. */
function confirmed(...totals: (number | null)[]) {
  storedReceipts = totals.map((confirmedTotal) => ({ extraction: { confirmedTotal } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  storedReceipts = [];
  imageById = {};
});

describe("confirming a receipt total", () => {
  it("bills the sum of every store, not just the last one confirmed", async () => {
    addReceipt(1, JOLLIBEE_TOTAL);
    addReceipt(2, SAVEMORE_TOTAL);

    // Store one.
    confirmed(JOLLIBEE_TOTAL);
    await confirmProofImage(ERRAND_ID, 1, RIDER_ID, JOLLIBEE_TOTAL);
    expect(markItemsPurchased).toHaveBeenLastCalledWith(ERRAND_ID, RIDER_ID, 176.0);

    // Store two. The Jollibee spend must survive.
    confirmed(JOLLIBEE_TOTAL, SAVEMORE_TOTAL);
    await confirmProofImage(ERRAND_ID, 2, RIDER_ID, SAVEMORE_TOTAL);
    expect(markItemsPurchased).toHaveBeenLastCalledWith(ERRAND_ID, RIDER_ID, 1170.0);
  });

  it("counts only receipts the rider has actually confirmed", async () => {
    addReceipt(1, JOLLIBEE_TOTAL);
    // A second photo is uploaded but its total is still unconfirmed — a machine
    // guess, which must not reach the customer's bill.
    confirmed(JOLLIBEE_TOTAL, null);

    await confirmProofImage(ERRAND_ID, 1, RIDER_ID, JOLLIBEE_TOTAL);
    expect(markItemsPurchased).toHaveBeenLastCalledWith(ERRAND_ID, RIDER_ID, 176.0);
  });

  it("recomputes rather than double-counts when a total is corrected", async () => {
    addReceipt(1, JOLLIBEE_TOTAL);

    confirmed(JOLLIBEE_TOTAL);
    await confirmProofImage(ERRAND_ID, 1, RIDER_ID, JOLLIBEE_TOTAL);

    // The rider re-reads the paper and corrects it.
    confirmed(186.5);
    await confirmProofImage(ERRAND_ID, 1, RIDER_ID, 186.5);

    expect(markItemsPurchased).toHaveBeenLastCalledWith(ERRAND_ID, RIDER_ID, 186.5);
  });

  it("rounds to centavos rather than carrying float drift", async () => {
    addReceipt(1, 0.1);
    confirmed(0.1, 0.2);
    await confirmProofImage(ERRAND_ID, 1, RIDER_ID, 0.1);
    expect(markItemsPurchased).toHaveBeenLastCalledWith(ERRAND_ID, RIDER_ID, 0.3);
  });

  it("tells dispatch when the rider's figure is far off what was read", async () => {
    addReceipt(1, JOLLIBEE_TOTAL);
    confirmed(900);

    await confirmProofImage(ERRAND_ID, 1, RIDER_ID, 900);

    expect(emitToErrand).toHaveBeenCalledWith(
      ERRAND_ID,
      "errand:receipt_mismatch",
      expect.objectContaining({ extractedTotal: JOLLIBEE_TOTAL, confirmedTotal: 900 })
    );
  });

  it("stays quiet when the rider fixes a misread digit", async () => {
    addReceipt(1, JOLLIBEE_TOTAL);
    confirmed(180);

    await confirmProofImage(ERRAND_ID, 1, RIDER_ID, 180);

    expect(emitToErrand).not.toHaveBeenCalled();
  });
});
