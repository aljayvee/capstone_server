import { beforeEach, describe, expect, it, vi } from "vitest";

const ERRAND_ID = "ERR-SARI";
const CUSTOMER_ID = 11;
const RIDER_ID = 7;

const markItemsPurchased = vi.fn();
const emitToErrand = vi.fn();
const readText = vi.fn();

let storedProofs: any[] = [];
let created: any[] = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    errandProofImage: {
      findMany: vi.fn(async () => storedProofs),
      findUnique: vi.fn(async ({ where }: any) => storedProofs.find((p) => p.id === where.id) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: created.length + 1, ...data };
        created.push(row);
        return row;
      }),
    },
    receiptExtraction: { update: vi.fn() },
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
  readText: (...a: unknown[]) => readText(...a),
  configuredEngines: () => ["CLOUD_VISION"],
}));

vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: {
    findByIdBasic: vi.fn(async () => ({
      id: ERRAND_ID,
      customerId: CUSTOMER_ID,
      riderId: RIDER_ID,
      totalCost: 293,
    })),
  },
}));

vi.mock("../src/services/errandService.js", () => ({
  markItemsPurchased: (...a: unknown[]) => markItemsPurchased(...a),
}));

const proofs = await import("../src/services/proofImageService.js");

const IMAGE = {
  imageData: "data:image/jpeg;base64,AAAA",
  mimeType: "image/jpeg",
  fileSize: 1024,
};

beforeEach(() => {
  vi.clearAllMocks();
  storedProofs = [];
  created = [];
});

describe("a shop that issues no receipt", () => {
  it("stores the purchase without ever calling OCR", async () => {
    // The photo is of the goods. There is nothing printed to read, so spending a
    // paid Vision call to discover that would be pure waste — and the legibility
    // floor would then reject a perfectly sharp photo as "too blurry".
    const row = await proofs.uploadProofImage(ERRAND_ID, RIDER_ID, {
      ...IMAGE,
      kind: "NO_RECEIPT",
      declaredTotal: 176,
    } as any);

    expect(readText).not.toHaveBeenCalled();
    expect(row.kind).toBe("NO_RECEIPT");
    expect(row.declaredTotal).toBe(176);
  });

  it("marks the purchase unverified, because nothing corroborates it", async () => {
    const row = await proofs.uploadProofImage(ERRAND_ID, RIDER_ID, {
      ...IMAGE,
      kind: "NO_RECEIPT",
      declaredTotal: 176,
    } as any);

    expect(row.verified).toBe(false);
    // Not dressed up as a machine reading.
    expect(row.extraction).toBeNull();
  });

  it("refuses a declaration with no amount", async () => {
    // A photo of goods and no figure is not evidence of anything.
    await expect(
      proofs.uploadProofImage(ERRAND_ID, RIDER_ID, { ...IMAGE, kind: "NO_RECEIPT" } as any)
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      proofs.uploadProofImage(ERRAND_ID, RIDER_ID, { ...IMAGE, kind: "NO_RECEIPT", declaredTotal: 0 } as any)
    ).rejects.toMatchObject({ status: 400 });
  });

  it("tells dispatch while it is happening", async () => {
    await proofs.uploadProofImage(ERRAND_ID, RIDER_ID, {
      ...IMAGE,
      kind: "NO_RECEIPT",
      declaredTotal: 176,
    } as any);

    expect(emitToErrand).toHaveBeenCalledWith(
      ERRAND_ID,
      "errand:unverified_purchase",
      expect.objectContaining({ declaredTotal: 176, riderId: RIDER_ID })
    );
  });

  it("counts a declared amount into the basket beside read receipts", async () => {
    // One shop printed a receipt for 994; the sari-sari did not, and the rider
    // declared 176. The customer's goods cost 1170 either way.
    storedProofs = [
      { id: 1, declaredTotal: null, extraction: { confirmedTotal: 994 } },
      { id: 2, declaredTotal: 176, extraction: null },
    ];

    await proofs.uploadProofImage(ERRAND_ID, RIDER_ID, {
      ...IMAGE,
      kind: "NO_RECEIPT",
      declaredTotal: 176,
    } as any);

    expect(markItemsPurchased).toHaveBeenCalledWith(ERRAND_ID, RIDER_ID, 1170);
  });
});

describe("the handover photo", () => {
  it("is stored with nothing to read and no amount", async () => {
    const row = await proofs.uploadProofImage(ERRAND_ID, RIDER_ID, {
      ...IMAGE,
      kind: "PROOF_OF_DELIVERY",
    } as any);

    expect(readText).not.toHaveBeenCalled();
    expect(row.kind).toBe("PROOF_OF_DELIVERY");
    expect(row.extraction).toBeNull();
    expect(row.declaredTotal ?? null).toBeNull();
  });

  it("does not reprice the errand", async () => {
    await proofs.uploadProofImage(ERRAND_ID, RIDER_ID, {
      ...IMAGE,
      kind: "PROOF_OF_DELIVERY",
    } as any);

    expect(markItemsPurchased).not.toHaveBeenCalled();
  });
});

describe("who may look at an errand's evidence", () => {
  it("lets the customer whose errand it is", async () => {
    await expect(
      proofs.assertMayViewProofs(ERRAND_ID, { id: CUSTOMER_ID, role: "CUSTOMER" })
    ).resolves.toBeTruthy();
  });

  it("refuses a different customer", async () => {
    // The hole this closes: authenticated was the only check, so any signed-in
    // account could enumerate another customer's receipts by errand id.
    await expect(
      proofs.assertMayViewProofs(ERRAND_ID, { id: 999, role: "CUSTOMER" })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lets the rider who ran it, and refuses one who did not", async () => {
    await expect(
      proofs.assertMayViewProofs(ERRAND_ID, { id: RIDER_ID, role: "RIDER" })
    ).resolves.toBeTruthy();
    await expect(
      proofs.assertMayViewProofs(ERRAND_ID, { id: 42, role: "RIDER" })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lets staff see any errand, because a dispute needs investigating", async () => {
    await expect(
      proofs.assertMayViewProofs(ERRAND_ID, { id: 1, role: "DISPATCHER" })
    ).resolves.toBeTruthy();
    await expect(
      proofs.assertMayViewProofs(ERRAND_ID, { id: 2, role: "OWNER" })
    ).resolves.toBeTruthy();
  });

  it("refuses a caller whose role it does not recognise", async () => {
    // Deny by default. A role added to the system later has to be named in the
    // check before it can read anyone's evidence, rather than arriving with
    // access already granted.
    await expect(
      proofs.assertMayViewProofs(ERRAND_ID, undefined)
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      proofs.assertMayViewProofs(ERRAND_ID, { id: 1, role: "AUDITOR" })
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("fetching one image", () => {
  it("refuses an image belonging to a different errand", async () => {
    storedProofs = [{ id: 5, errandId: "SOMEONE-ELSE", kind: "RECEIPT" }];
    await expect(proofs.getProofImage(ERRAND_ID, 5)).rejects.toMatchObject({ status: 404 });
  });

  it("returns the bytes for one that does", async () => {
    storedProofs = [
      { id: 5, errandId: ERRAND_ID, kind: "RECEIPT", mimeType: "image/jpeg", imageData: "AAAA" },
    ];
    await expect(proofs.getProofImage(ERRAND_ID, 5)).resolves.toMatchObject({ imageData: "AAAA" });
  });
});
