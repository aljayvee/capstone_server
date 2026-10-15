import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /errands/:id carries the rider, dispatcher and payment mode flat as well
 * as nested (2026-10-10). The customer app's errand details screen read only
 * the flat fields its list sends, so a pull-to-refresh onto this response
 * showed an assigned rider as "Assigning" and a chosen GCash as "Pending
 * Selection". Installed apps cannot be rebuilt from here; the response can.
 */

const row = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("../src/repositories/errandRepository.js", () => ({
  errandRepository: { findById: vi.fn(async () => row.current) },
  dispatchLogRepository: {},
}));

import { getErrandById } from "../src/services/errandService.js";

const assigned = {
  id: "SGO-2B37D6",
  customerId: 9,
  status: "ASSIGNED",
  riderId: 4,
  customer: { information: { firstName: "Ana", lastName: "Reyes", phone: "09170000000" } },
  rider: { firstName: "Juan", lastName: "Dela Cruz", phone: "09180000000" },
  dispatchLogs: [{ dispatcherId: 7, dispatcher: { firstName: "Maria", lastName: "Santos" } }],
  paymentSelection: { paymentMode: { name: "GCash / PayMaya" } },
  pinpoints: [],
  payments: [],
};

describe("errand responses carry flat names", () => {
  beforeEach(() => {
    row.current = null;
  });

  it("names the rider, the dispatcher and the confirmed payment mode", async () => {
    row.current = assigned;
    const errand = (await getErrandById("SGO-2B37D6")) as Record<string, unknown>;
    expect(errand.riderName).toBe("Juan Dela Cruz");
    expect(errand.dispatcherName).toBe("Maria Santos");
    expect(errand.paymentMethod).toBe("GCash / PayMaya");
    // The nested shape the portal and rider app read is unchanged.
    expect((errand.rider as { name: string }).name).toBe("Juan Dela Cruz");
  });

  it("says nobody when the rider declined or no dispatcher claimed it", async () => {
    row.current = { ...assigned, status: "AVAILABLE", riderId: null, rider: null, dispatchLogs: [] };
    const errand = (await getErrandById("SGO-2B37D6")) as Record<string, unknown>;
    expect(errand.riderName).toBeNull();
    expect(errand.dispatcherName).toBeNull();
  });

  it("adds no payment method before one is confirmed", async () => {
    row.current = { ...assigned, paymentSelection: null };
    const errand = (await getErrandById("SGO-2B37D6")) as Record<string, unknown>;
    // Absent, not null: a socket update merged into the app's list must not
    // blank the method the list already shows.
    expect("paymentMethod" in errand).toBe(false);
  });

  it("claims nothing for a payload that does not carry the relations", async () => {
    const { rider: _rider, dispatchLogs: _logs, ...slim } = assigned;
    row.current = slim;
    const errand = (await getErrandById("SGO-2B37D6")) as Record<string, unknown>;
    expect("riderName" in errand).toBe(false);
    expect("dispatcherName" in errand).toBe(false);
  });
});
