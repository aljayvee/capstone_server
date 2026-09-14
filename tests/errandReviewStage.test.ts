import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: {
    findById: vi.fn(),
    findByIdBasic: vi.fn(),
    update: vi.fn(),
  },
  dispatchLogRepository: {
    findLatestByErrandId: vi.fn(),
    markVerified: vi.fn(),
    deleteUnverifiedForErrand: vi.fn(),
  },
}));
vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: { emit: vi.fn(), emitToErrand: vi.fn(), emitToRole: vi.fn(), emitToRider: vi.fn() },
}));

import { errandRepository, dispatchLogRepository } from "../src/repositories/errandRepository.js";
import { releaseErrand, verifyErrand } from "../src/services/errandService.js";

const OWNER_ID = 7;
const OTHER_ID = 9;

function log(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    errandId: "e1",
    dispatcherId: OWNER_ID,
    verifiedAt: null,
    dispatchedAt: new Date(),
    notes: null,
    dispatcher: { firstName: "Mark", lastName: "Batcharo" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(errandRepository.findById).mockResolvedValue({ id: "e1" } as never);
  vi.mocked(errandRepository.findByIdBasic).mockResolvedValue({
    id: "e1",
    riderId: null,
  } as never);
  vi.mocked(errandRepository.update).mockResolvedValue({ id: "e1" } as never);
  vi.mocked(dispatchLogRepository.markVerified).mockResolvedValue({ count: 1 } as never);
  vi.mocked(dispatchLogRepository.deleteUnverifiedForErrand).mockResolvedValue({ count: 1 } as never);
});

describe("verifyErrand", () => {
  it("stamps the claiming dispatcher's own review", async () => {
    vi.mocked(dispatchLogRepository.findLatestByErrandId).mockResolvedValue(log() as never);

    await verifyErrand("e1", OWNER_ID);

    expect(dispatchLogRepository.markVerified).toHaveBeenCalledWith("e1", OWNER_ID);
  });

  it("refuses a dispatcher who did not open the request", async () => {
    // The claim is what makes someone the person the customer has been talking
    // to. Letting a second dispatcher accept on their behalf would hand the
    // conversation to a stranger mid-sentence.
    vi.mocked(dispatchLogRepository.findLatestByErrandId).mockResolvedValue(log() as never);

    await expect(verifyErrand("e1", OTHER_ID)).rejects.toMatchObject({
      status: 403,
    });
    expect(dispatchLogRepository.markVerified).not.toHaveBeenCalled();
  });

  it("refuses to verify an order nobody has opened", async () => {
    vi.mocked(dispatchLogRepository.findLatestByErrandId).mockResolvedValue(null as never);

    await expect(verifyErrand("e1", OWNER_ID)).rejects.toMatchObject({ status: 409 });
  });

  it("is idempotent — a double click cannot move the accepted moment", async () => {
    // markVerified filters on `verifiedAt: null`, so the second call matches
    // nothing. The moment the customer was told "accepted" is the one that counts.
    vi.mocked(dispatchLogRepository.findLatestByErrandId).mockResolvedValue(
      log({ verifiedAt: new Date("2026-09-01T10:00:00Z") }) as never
    );
    vi.mocked(dispatchLogRepository.markVerified).mockResolvedValue({ count: 0 } as never);

    await expect(verifyErrand("e1", OWNER_ID)).resolves.toBeTruthy();
  });
});

describe("releaseErrand", () => {
  it("puts an opened-but-unaccepted request back in the queue", async () => {
    vi.mocked(dispatchLogRepository.findLatestByErrandId).mockResolvedValue(log() as never);

    await releaseErrand("e1", OWNER_ID);

    expect(dispatchLogRepository.deleteUnverifiedForErrand).toHaveBeenCalledWith("e1", OWNER_ID);
    expect(errandRepository.update).toHaveBeenCalledWith("e1", { status: "AVAILABLE" });
  });

  it("refuses once the order has been accepted", async () => {
    // The customer has been told who their dispatcher is and work has started.
    // Walking away silently would leave them talking to nobody; declining is the
    // honest exit, and it tells them why.
    vi.mocked(dispatchLogRepository.findLatestByErrandId).mockResolvedValue(
      log({ verifiedAt: new Date() }) as never
    );

    await expect(releaseErrand("e1", OWNER_ID)).rejects.toMatchObject({ status: 409 });
    expect(errandRepository.update).not.toHaveBeenCalled();
  });

  it("refuses to release someone else's review", async () => {
    vi.mocked(dispatchLogRepository.findLatestByErrandId).mockResolvedValue(log() as never);

    await expect(releaseErrand("e1", OTHER_ID)).rejects.toMatchObject({ status: 403 });
    expect(dispatchLogRepository.deleteUnverifiedForErrand).not.toHaveBeenCalled();
  });

  it("refuses once a rider is on it", async () => {
    vi.mocked(errandRepository.findByIdBasic).mockResolvedValue({
      id: "e1",
      riderId: 3,
    } as never);

    await expect(releaseErrand("e1", OWNER_ID)).rejects.toMatchObject({ status: 409 });
  });

  it("does not strand the errand if the log was already gone", async () => {
    // Two tabs, both hitting Return to queue. The second finds nothing to delete
    // and must not flip an errand someone else has since claimed.
    vi.mocked(dispatchLogRepository.findLatestByErrandId).mockResolvedValue(log() as never);
    vi.mocked(dispatchLogRepository.deleteUnverifiedForErrand).mockResolvedValue({
      count: 0,
    } as never);

    await expect(releaseErrand("e1", OWNER_ID)).rejects.toMatchObject({ status: 409 });
    expect(errandRepository.update).not.toHaveBeenCalled();
  });
});
