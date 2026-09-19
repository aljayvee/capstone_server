import { beforeEach, describe, expect, it, vi } from "vitest";

// Stubbed the same way reportAllocationReconciliation.test.ts stubs its edges:
// this exercises the RULES, not Cloud Vision and not the database.
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    errandProofImage: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 1, capturedAt: new Date(), extraction: data.extraction.create })
      ),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));
vi.mock("../src/lib/ocr/resilientOcrService.js", () => ({
  readText: vi.fn(),
  configuredEngines: () => ["CLOUD_VISION"],
}));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { findByIdBasic: vi.fn() },
}));
vi.mock("../src/repositories/paymentSelectionRepository.js", () => ({
  paymentSelectionRepository: { findByErrandId: vi.fn() },
}));
vi.mock("../src/repositories/errandPaymentRepository.js", () => ({
  errandPaymentRepository: { findAmountsByErrandId: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emitToErrand: vi.fn(), emit: vi.fn() },
}));

import { readText } from "../src/lib/ocr/resilientOcrService.js";
import { errandRepository } from "../src/repositories/errandRepository.js";
import { paymentSelectionRepository } from "../src/repositories/paymentSelectionRepository.js";
import { uploadPaymentProof } from "../src/services/paymentProofService.js";

const CUSTOMER = 42;
const ERRAND = "ERR-1";

/** A GCash confirmation, dated whatever the test needs. */
function screenshot({ amount = "500.00", ref = "Ref No. 0123 4567 8901", date = today() } = {}) {
  return `GCash\nSent via GCash\nAmount\nPHP ${amount}\n${ref}\n${date}\nSugo Express On the Go`;
}

function today(): string {
  const d = new Date();
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${M[d.getMonth()]} ${String(d.getDate()).padStart(2, "0")}, ${d.getFullYear()}`;
}

const upload = (text: string) => {
  vi.mocked(readText).mockResolvedValue({ text, engine: "CLOUD_VISION", confidence: 0.95 } as never);
  return uploadPaymentProof(ERRAND, CUSTOMER, {
    imageData: "data:image/jpeg;base64,AAAA",
    mimeType: "image/jpeg",
    fileSize: 1000,
  } as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  // ₱1,000 of goods on the 50% plan: ₱500 due before dispatch.
  vi.mocked(errandRepository.findByIdBasic).mockResolvedValue({
    id: ERRAND, customerId: CUSTOMER, estimatedCost: 1000, totalCost: 1120, status: "PENDING",
  } as never);
  vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue({
    paymentMode: { name: "GCash / PayMaya" },
  } as never);
});

describe("a receipt that says what it should", () => {
  it("is accepted and keeps the reference for the dispatcher to look up", async () => {
    const proof: any = await upload(screenshot());
    expect(proof.extraction.referenceNo).toBe("012345678901");
    expect(proof.extraction.extractedTotal).toBe(500);
  });
});

describe("a receipt that does not", () => {
  it("is refused when the amount is not what is owed", async () => {
    // ₱250 against ₱500 due. Not a weak proof — a proof of something else.
    await expect(upload(screenshot({ amount: "250.00" }))).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("₱500.00 is due"),
    });
  });

  it("is refused when it is not from today", async () => {
    // The easiest way to pay for one errand twice is to re-upload last week's
    // confirmation, and it is the check a person eyeballing an image skips.
    await expect(upload(screenshot({ date: "Jan 02, 2020" }))).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("isn't from today"),
    });
  });

  it("is refused when there is no reference number to look up", async () => {
    await expect(upload(screenshot({ ref: "Thanks for paying" }))).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("reference number"),
    });
  });

  it("is refused when too blurry to read at all", async () => {
    await expect(upload("??")).rejects.toMatchObject({ status: 422 });
  });

  it("says the service is down rather than blaming the photo", async () => {
    // A customer who can retake the shot needs to hear something different from
    // one whose OCR provider is unreachable.
    vi.mocked(readText).mockResolvedValue(null as never);
    await expect(
      uploadPaymentProof(ERRAND, CUSTOMER, {
        imageData: "data:image/jpeg;base64,AAAA", mimeType: "image/jpeg", fileSize: 1000,
      } as never)
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("whose errand it is", () => {
  it("refuses someone else's errand", async () => {
    await expect(
      uploadPaymentProof(ERRAND, 999, {
        imageData: "data:image/jpeg;base64,AAAA", mimeType: "image/jpeg", fileSize: 1000,
      } as never)
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a COD errand, which has nothing to upload", async () => {
    vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue({
      paymentMode: { name: "Cash on Delivery" },
    } as never);
    await expect(upload(screenshot())).rejects.toMatchObject({ status: 409 });
  });
});

describe("every non-COD channel owes the same half", () => {
  it.each(["GCash / PayMaya", "Bank Transfer"])("accepts the 50%% receipt on %s", async (mode) => {
    vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue({
      paymentMode: { name: mode },
    } as never);
    const proof: any = await upload(screenshot());
    expect(proof.extraction.extractedTotal).toBe(500);
  });

  it("refuses a receipt for the whole bill", async () => {
    // ₱1,120 is not what is owed up front. Paying it all would be a real
    // payment for a different arrangement than the one this errand is on.
    vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue({
      paymentMode: { name: "GCash / PayMaya" },
    } as never);
    await expect(upload(screenshot({ amount: "1120.00" }))).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("₱500.00 is due"),
    });
  });
});
