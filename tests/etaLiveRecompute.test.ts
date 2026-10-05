import { beforeEach, describe, expect, it, vi } from "vitest";

const { findById } = vi.hoisted(() => ({ findById: vi.fn() }));

vi.mock("../src/repositories/errandRepository.js", () => ({ errandRepository: { findById, update: vi.fn() } }));
vi.mock("../src/repositories/pinpointRepository.js", () => ({ pinpointRepository: { findByErrandIdWithCategory: vi.fn() } }));
vi.mock("../src/lib/eventPublisher.js", () => ({ eventPublisher: { emitToErrand: vi.fn() } }));

import { recomputeFromLivePosition } from "../src/services/etaService.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  // An errand that is no longer trackable: the recompute starts, reads it, and stops.
  findById.mockReset().mockResolvedValue(null);
});

describe("recomputeFromLivePosition", () => {
  it("lets one refresh per errand through per minute, however many fixes arrive", async () => {
    const t0 = 1_000_000;
    for (let s = 0; s < 60; s++) recomputeFromLivePosition("errand-a", t0 + s * 1000);
    await flush();
    expect(findById).toHaveBeenCalledTimes(1);

    recomputeFromLivePosition("errand-a", t0 + 60_000);
    await flush();
    expect(findById).toHaveBeenCalledTimes(2);
  });

  it("throttles each errand separately", async () => {
    const t0 = 5_000_000;
    recomputeFromLivePosition("errand-b", t0);
    recomputeFromLivePosition("errand-c", t0);
    await flush();
    expect(findById.mock.calls.map(([id]) => id)).toEqual(["errand-b", "errand-c"]);
  });
});
