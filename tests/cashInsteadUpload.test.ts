import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rider's cash photo is what records a transfer customer paying cash
 * instead. The photo is the evidence, so it is never refused because the
 * switch could not be written.
 */

const ERRAND = "ERR-CASH-PHOTO";
const RIDER = 7;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    errandProofImage: {
      create: vi.fn(async ({ data }: any) => ({ id: 31, ...data })),
    },
  },
}));
vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emit: vi.fn(), emitToErrand: vi.fn(), emitToErrandParties: vi.fn() },
}));
vi.mock("../src/lib/ocr/resilientOcrService.js", () => ({
  readText: vi.fn(),
  configuredEngines: () => ["CLOUD_VISION"],
}));
vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { findByIdBasic: vi.fn(async () => ({ id: ERRAND, riderId: RIDER })) },
}));
vi.mock("../src/services/errandService.js", () => ({ applyReceiptTotal: vi.fn() }));
vi.mock("../src/services/paymentSelectionService.js", () => ({ switchToCashOnDelivery: vi.fn() }));

import { prisma } from "../src/lib/prisma.js";
import { logger } from "../src/lib/logger.js";
import { switchToCashOnDelivery } from "../src/services/paymentSelectionService.js";
import { uploadProofImage } from "../src/services/proofImageService.js";

const cashPhoto = {
  kind: "CASH_COLLECTED",
  imageData: "data:image/jpeg;base64,AAAA",
  mimeType: "image/jpeg",
  fileSize: 3,
  declaredTotal: 560,
} as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("filing the cash photo", () => {
  it("records the switch to cash on delivery", async () => {
    vi.mocked(switchToCashOnDelivery).mockResolvedValue(true);

    const saved = await uploadProofImage(ERRAND, RIDER, cashPhoto);

    expect(saved).toMatchObject({ id: 31, kind: "CASH_COLLECTED", declaredTotal: 560 });
    expect(switchToCashOnDelivery).toHaveBeenCalledWith(ERRAND);
  });

  it("keeps the photo when the switch cannot be written", async () => {
    vi.mocked(switchToCashOnDelivery).mockRejectedValue(new Error("database away"));

    const saved = await uploadProofImage(ERRAND, RIDER, cashPhoto);

    expect(saved).toMatchObject({ id: 31, kind: "CASH_COLLECTED" });
    expect(prisma.errandProofImage.create).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not record the switch"));
  });

  it("does not switch anything for a store receipt", async () => {
    await uploadProofImage(ERRAND, RIDER, { ...cashPhoto, kind: "NO_RECEIPT", pinpointId: null }).catch(() => {});
    expect(switchToCashOnDelivery).not.toHaveBeenCalled();
  });
});
