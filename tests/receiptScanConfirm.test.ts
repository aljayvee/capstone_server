import { readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * A receipt is read first and saved only when the rider confirms its total.
 *
 * Saving at the reading stage left every retake behind as a second copy of the
 * same receipt (errand ...aa24aa holds two receipts for stop 5, both confirmed
 * at ₱75). These pin the new order: read, hold, confirm, write once.
 */

const ERRAND_ID = "ERR-SCAN";
const RIDER_ID = 7;
const JOLLIBEE_TEXT = readFileSync(new URL("./fixtures/receipts/jollibee.txt", import.meta.url), "utf8");
const JOLLIBEE_TOTAL = 176;

const applyReceiptTotal = vi.fn();
const emitToErrand = vi.fn();
const readText = vi.fn();
const create = vi.fn();

/** Rows written to errand_proof_images, standing in for the table. */
let rows: any[] = [];
let errandRider = RIDER_ID;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    errandProofImage: {
      create: (...a: unknown[]) => create(...a),
      findMany: vi.fn(async () =>
        rows.map((r) => ({ declaredTotal: null, extraction: { confirmedTotal: r.extraction.confirmedTotal } }))
      ),
      findUnique: vi.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
    },
    receiptExtraction: {
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.extraction.id === where.id);
        Object.assign(row.extraction, data);
        return row.extraction;
      }),
    },
  },
}));

vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emitToErrand: (...a: unknown[]) => emitToErrand(...a), emit: vi.fn() },
}));

vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/lib/ocr/resilientOcrService.js", () => ({
  readText: (...a: unknown[]) => readText(...a),
  configuredEngines: () => ["CLOUD_VISION"],
}));

vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: {
    findByIdBasic: vi.fn(async (id: string) => ({ id, riderId: errandRider })),
  },
}));

vi.mock("../src/services/errandService.js", () => ({
  applyReceiptTotal: (...a: unknown[]) => applyReceiptTotal(...a),
}));

const { scanProofImage, confirmScannedProof } = await import("../src/services/proofImageService.js");
const { __resetPendingScans, __pendingScanCount, PENDING_SCAN_TTL_MS } = await import(
  "../src/lib/pendingReceiptScans.js"
);

const photo = (pinpointId: number | null = 5) => ({
  kind: "RECEIPT" as const,
  imageData: "A".repeat(4000),
  mimeType: "image/jpeg" as const,
  fileSize: 3000,
  pinpointId,
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetPendingScans();
  rows = [];
  errandRider = RIDER_ID;
  readText.mockResolvedValue({ text: JOLLIBEE_TEXT, engine: "CLOUD_VISION", confidence: 0.97 });
  create.mockImplementation(async ({ data }: any) => {
    const id = rows.length + 1;
    const row = { id, errandId: data.errandId, kind: data.kind, extraction: { id, ...data.extraction.create } };
    rows.push(row);
    return row;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scanning a receipt", () => {
  it("reads the total and saves nothing", async () => {
    const scan = await scanProofImage(ERRAND_ID, RIDER_ID, photo());

    expect(scan.scanId).toEqual(expect.any(String));
    expect(scan.extraction.extractedTotal).toBe(JOLLIBEE_TOTAL);
    expect(create).not.toHaveBeenCalled();
    expect(applyReceiptTotal).not.toHaveBeenCalled();
  });

  it("holds nothing when the photo cannot be read", async () => {
    readText.mockResolvedValue(null);
    await expect(scanProofImage(ERRAND_ID, RIDER_ID, photo())).rejects.toMatchObject({ status: 422 });
    expect(__pendingScanCount()).toBe(0);
  });

  it("refuses a rider the errand is not assigned to", async () => {
    errandRider = 99;
    await expect(scanProofImage(ERRAND_ID, RIDER_ID, photo())).rejects.toMatchObject({ status: 403 });
    expect(readText).not.toHaveBeenCalled();
  });
});

describe("confirming a scanned receipt", () => {
  it("saves the photo once, with the rider's total, and reprices the basket", async () => {
    const scan = await scanProofImage(ERRAND_ID, RIDER_ID, photo());
    const saved = await confirmScannedProof(ERRAND_ID, scan.scanId, RIDER_ID, JOLLIBEE_TOTAL);

    expect(create).toHaveBeenCalledTimes(1);
    const written = create.mock.calls[0][0].data;
    expect(written).toMatchObject({ errandId: ERRAND_ID, riderId: RIDER_ID, pinpointId: 5, kind: "RECEIPT" });
    expect(written.extraction.create).toMatchObject({
      extractedTotal: JOLLIBEE_TOTAL,
      confirmedTotal: JOLLIBEE_TOTAL,
      status: "OK",
    });
    expect(saved).toMatchObject({ id: 1, extraction: { confirmedTotal: JOLLIBEE_TOTAL } });
    expect(applyReceiptTotal).toHaveBeenCalledWith(ERRAND_ID, RIDER_ID, JOLLIBEE_TOTAL);
  });

  it("keeps only the retake: the first photo of the stop can no longer be saved", async () => {
    const first = await scanProofImage(ERRAND_ID, RIDER_ID, photo());
    const retake = await scanProofImage(ERRAND_ID, RIDER_ID, photo());

    await expect(
      confirmScannedProof(ERRAND_ID, first.scanId, RIDER_ID, JOLLIBEE_TOTAL)
    ).rejects.toMatchObject({ status: 410 });

    await confirmScannedProof(ERRAND_ID, retake.scanId, RIDER_ID, JOLLIBEE_TOTAL);
    expect(rows).toHaveLength(1);
  });

  it("does not let a photo of one stop replace another stop's", async () => {
    const storeOne = await scanProofImage(ERRAND_ID, RIDER_ID, photo(5));
    const storeTwo = await scanProofImage(ERRAND_ID, RIDER_ID, photo(6));

    await confirmScannedProof(ERRAND_ID, storeOne.scanId, RIDER_ID, JOLLIBEE_TOTAL);
    await confirmScannedProof(ERRAND_ID, storeTwo.scanId, RIDER_ID, 39);
    expect(rows.map((r) => r.extraction.confirmedTotal)).toEqual([JOLLIBEE_TOTAL, 39]);
  });

  it("writes one row when the confirm is sent again after its reply was lost", async () => {
    const scan = await scanProofImage(ERRAND_ID, RIDER_ID, photo());
    await confirmScannedProof(ERRAND_ID, scan.scanId, RIDER_ID, JOLLIBEE_TOTAL);
    const again = await confirmScannedProof(ERRAND_ID, scan.scanId, RIDER_ID, 186.5);

    expect(create).toHaveBeenCalledTimes(1);
    expect(again.id).toBe(1);
    // The second press still counts: the corrected total is what gets billed.
    expect(rows[0].extraction.confirmedTotal).toBe(186.5);
    expect(applyReceiptTotal).toHaveBeenLastCalledWith(ERRAND_ID, RIDER_ID, 186.5);
  });

  it("writes one row when Confirm is pressed twice at once", async () => {
    const scan = await scanProofImage(ERRAND_ID, RIDER_ID, photo());
    await Promise.all([
      confirmScannedProof(ERRAND_ID, scan.scanId, RIDER_ID, JOLLIBEE_TOTAL),
      confirmScannedProof(ERRAND_ID, scan.scanId, RIDER_ID, JOLLIBEE_TOTAL),
    ]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("can be confirmed again after the write itself failed", async () => {
    create.mockRejectedValueOnce(new Error("connection reset"));
    const scan = await scanProofImage(ERRAND_ID, RIDER_ID, photo());

    await expect(confirmScannedProof(ERRAND_ID, scan.scanId, RIDER_ID, JOLLIBEE_TOTAL)).rejects.toThrow(
      "connection reset"
    );
    await confirmScannedProof(ERRAND_ID, scan.scanId, RIDER_ID, JOLLIBEE_TOTAL);
    expect(rows).toHaveLength(1);
  });

  it("refuses another rider's scan, and a scan from another errand", async () => {
    const scan = await scanProofImage(ERRAND_ID, RIDER_ID, photo());

    await expect(
      confirmScannedProof("ERR-OTHER", scan.scanId, RIDER_ID, JOLLIBEE_TOTAL)
    ).rejects.toMatchObject({ status: 410 });

    errandRider = 8;
    await expect(confirmScannedProof(ERRAND_ID, scan.scanId, 8, JOLLIBEE_TOTAL)).rejects.toMatchObject({
      status: 410,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("expires a photo nobody confirmed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T08:00:00Z"));
    const scan = await scanProofImage(ERRAND_ID, RIDER_ID, photo());

    vi.setSystemTime(Date.now() + PENDING_SCAN_TTL_MS + 1000);
    await expect(
      confirmScannedProof(ERRAND_ID, scan.scanId, RIDER_ID, JOLLIBEE_TOTAL)
    ).rejects.toMatchObject({ status: 410 });
    expect(create).not.toHaveBeenCalled();
  });
});
