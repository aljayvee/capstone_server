import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rider's photo of the customer's transfer at the door (RIDER_BALANCE_PROOF).
 * Since 2026-10-08 it is how a GCash / PayMaya or Bank Transfer bill is paid:
 * read against the whole bill, stored, and recorded as paid by the system. When
 * it cannot be accepted, the rider is told to collect cash instead.
 */

const ERRAND = "ERR-T";
const RIDER = 7;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    errandProofImage: {
      create: vi.fn(async ({ data }: any) => ({ id: 31, ...data, extraction: data.extraction?.create ?? null })),
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
  errandPaymentRepository: { findAmountsByErrandId: vi.fn(async () => []) },
}));
vi.mock("../src/services/errandService.js", () => ({}));
vi.mock("../src/services/errandPaymentService.js", () => ({
  confirmBalanceFromRiderProof: vi.fn(async () => ({})),
}));

import { readText } from "../src/lib/ocr/resilientOcrService.js";
import { errandRepository } from "../src/repositories/errandRepository.js";
import { paymentSelectionRepository } from "../src/repositories/paymentSelectionRepository.js";
import { confirmBalanceFromRiderProof } from "../src/services/errandPaymentService.js";
import { uploadProofImage } from "../src/services/proofImageService.js";

function today(): string {
  const d = new Date();
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${M[d.getMonth()]} ${String(d.getDate()).padStart(2, "0")}, ${d.getFullYear()}`;
}

const photo = (text: string | null) => {
  vi.mocked(readText).mockResolvedValue(text === null ? null : ({ text, engine: "CLOUD_VISION", confidence: 0.95 } as never));
  return uploadProofImage(ERRAND, RIDER, {
    kind: "RIDER_BALANCE_PROOF",
    imageData: "data:image/jpeg;base64,AAAA",
    mimeType: "image/jpeg",
    fileSize: 1000,
  } as never);
};

const gcash = (amount: string) =>
  `GCash\nSent via GCash\nAmount\nPHP ${amount}\nRef No. 0123 4567 8901\n${today()}\nSugo Express On the Go`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(errandRepository.findByIdBasic).mockResolvedValue({
    id: ERRAND, riderId: RIDER, estimatedCost: 1000, totalCost: 1120, status: "IN_TRANSIT",
  } as never);
  vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue({
    paymentMode: { name: "Bank Transfer" },
  } as never);
});

describe("a transfer photographed at the door", () => {
  it("records the whole bill as paid, citing the photo", async () => {
    await photo(gcash("1120.00"));
    expect(confirmBalanceFromRiderProof).toHaveBeenCalledWith(ERRAND, {
      proofImageId: 31,
      amount: 1120,
      referenceNo: "012345678901",
    });
  });

  it("tells the rider to take cash when it is for the wrong amount", async () => {
    await expect(photo(gcash("560.00"))).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("collect the payment in cash instead"),
    });
    expect(confirmBalanceFromRiderProof).not.toHaveBeenCalled();
  });

  it("tells the rider to take cash when the photo cannot be read", async () => {
    await expect(photo(null)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("collect the payment in cash instead"),
    });
  });

  it("is refused on a cash on delivery order", async () => {
    vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue({
      paymentMode: { name: "Cash on Delivery" },
    } as never);
    await expect(photo(gcash("1120.00"))).rejects.toMatchObject({ status: 409 });
  });
});
