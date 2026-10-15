import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Transfer confirmations since 2026-10-08. The whole bill is paid at the door
 * and the RIDER photographs the customer's confirmation, read against the bill
 * by the same validator the customer's own upload used. The customer's upload
 * is refused, with where to go instead, because a receipt recorded there could
 * be paid a second time at the door.
 */

vi.mock("../src/lib/prisma.js", () => ({ prisma: { errandProofImage: { findFirst: vi.fn() } } }));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { findByIdBasic: vi.fn() },
}));
vi.mock("../src/repositories/paymentSelectionRepository.js", () => ({
  paymentSelectionRepository: { findByErrandId: vi.fn() },
}));
vi.mock("../src/repositories/errandPaymentRepository.js", () => ({
  errandPaymentRepository: { findAmountsByErrandId: vi.fn().mockResolvedValue([]) },
}));

import { errandRepository } from "../src/repositories/errandRepository.js";
import { paymentSelectionRepository } from "../src/repositories/paymentSelectionRepository.js";
import { errandPaymentRepository } from "../src/repositories/errandPaymentRepository.js";
import { uploadPaymentProof } from "../src/services/paymentProofService.js";
import { validateTransferReceipt } from "../src/services/patterns/transferValidation.js";
import { paymentProofUploadSchema } from "../src/validators/paymentProofValidators.js";

const CUSTOMER = 42;
const ERRAND = "ERR-1";
const IMAGE = { imageData: "data:image/jpeg;base64,AAAA", mimeType: "image/jpeg", fileSize: 1000 } as never;

/** A GCash confirmation, dated whatever the test needs. */
function screenshot({ amount = "1120.00", ref = "Ref No. 0123 4567 8901", date = today() } = {}) {
  return `GCash\nSent via GCash\nAmount\nPHP ${amount}\n${ref}\n${date}\nSugo Express On the Go`;
}

function today(): string {
  const d = new Date();
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${M[d.getMonth()]} ${String(d.getDate()).padStart(2, "0")}, ${d.getFullYear()}`;
}

/** The rider's photo at the door, read against a ₱1,120 bill. */
const read = (text: string) => validateTransferReceipt({ ocrText: text, dueAmount: 1120, dueLabel: "balance" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(errandRepository.findByIdBasic).mockResolvedValue({
    id: ERRAND, customerId: CUSTOMER, estimatedCost: 1000, totalCost: 1120, status: "IN_TRANSIT",
  } as never);
  vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue({
    paymentMode: { name: "GCash / PayMaya" },
  } as never);
  vi.mocked(errandPaymentRepository.findAmountsByErrandId).mockResolvedValue([]);
});

describe("a confirmation photographed at the door", () => {
  it("is accepted for the whole bill and keeps the reference", () => {
    expect(read(screenshot())).toMatchObject({ referenceNo: "012345678901", amount: 1120 });
  });

  it("is refused for half the bill: there is no downpayment any more", () => {
    expect(() => read(screenshot({ amount: "560.00" }))).toThrow(/₱1,120.00 is the balance due/);
  });

  it("is refused when it is not from today", () => {
    expect(() => read(screenshot({ date: "Jan 02, 2020" }))).toThrow(/isn't from today/);
  });

  it("is refused when there is no reference number to look up", () => {
    expect(() => read(screenshot({ ref: "Thanks for paying" }))).toThrow(/reference number/);
  });
});

describe("the customer's own upload", () => {
  it("sends them to the rider at the door while the bill is owed", async () => {
    await expect(uploadPaymentProof(ERRAND, CUSTOMER, IMAGE)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Show your GCash, PayMaya or bank confirmation to your rider"),
    });
  });

  it("has nothing to settle once the bill is paid", async () => {
    vi.mocked(errandPaymentRepository.findAmountsByErrandId).mockResolvedValue([{ kind: "FINAL", amount: 1120 }]);
    await expect(uploadPaymentProof(ERRAND, CUSTOMER, IMAGE)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("nothing currently due"),
    });
  });

  it("refuses someone else's errand", async () => {
    await expect(uploadPaymentProof(ERRAND, 999, IMAGE)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a COD errand, which has nothing to upload", async () => {
    vi.mocked(paymentSelectionRepository.findByErrandId).mockResolvedValue({
      paymentMode: { name: "Cash on Delivery" },
    } as never);
    await expect(uploadPaymentProof(ERRAND, CUSTOMER, IMAGE)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("cash on delivery"),
    });
  });
});

describe("receipt file size validation", () => {
  const sample = {
    imageData: "data:image/jpeg;base64,AAAA",
    mimeType: "image/jpeg" as const,
    fileSize: 1000,
  };

  it("accepts a receipt up to 15MB", () => {
    const result = paymentProofUploadSchema.safeParse({
      ...sample,
      fileSize: 15 * 1024 * 1024,
    });
    expect(result.success).toBe(true);
  });

  it("refuses a receipt over 15MB with clear copy", () => {
    const result = paymentProofUploadSchema.safeParse({
      ...sample,
      fileSize: 15 * 1024 * 1024 + 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("That image is too large. Please use one under 15MB.");
    }
  });
});
