import { describe, expect, it, vi } from "vitest";

/**
 * CANCELLED_AFTER_PURCHASE (2026-10-09) is a kind the reason network was never
 * trained on. It must get "no suggestion", not a guess built from an all-zero
 * kind input, and the network's input layout must not change to fit it.
 */

const { findWithReconciliationEvidenceById } = vi.hoisted(() => ({
  findWithReconciliationEvidenceById: vi.fn(async () => {
    throw new Error("the model path should not have been taken");
  }),
}));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { findWithReconciliationEvidenceById },
}));

const { suggestExceptionReason } = await import("../src/services/exceptionReasonService.js");
const { EXCEPTION_KIND_ORDER, isModelCompatible } = await import("../src/services/patterns/exceptionReasonModel.js");
const { EXCEPTION_REASON_MODEL } = await import("../src/services/patterns/exceptionReasonWeights.js");

describe("an exception kind the reason model was not trained on", () => {
  it("gets no suggestion, without consulting the model or the second opinion", async () => {
    const result = await suggestExceptionReason("ERR-1", "CANCELLED_AFTER_PURCHASE");
    expect(result).toMatchObject({ confident: false, suggestion: null, reasonCode: null, secondOpinion: null });
    expect(findWithReconciliationEvidenceById).not.toHaveBeenCalled();
  });

  it("leaves the trained network's input layout as it was", () => {
    expect(EXCEPTION_KIND_ORDER).not.toContain("CANCELLED_AFTER_PURCHASE");
    expect(isModelCompatible(EXCEPTION_REASON_MODEL)).toBe(true);
  });
});
