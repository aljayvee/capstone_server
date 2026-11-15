import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted with the mocks below: records every emit with the rooms it was
// addressed to.
const { emitted, chain, findMany, socketListeners, ioOn } = vi.hoisted(() => {
  const emitted: Array<{ rooms: string[]; event: string; payload: any }> = [];
  const chain = (roomsSoFar: string[]): any => ({
    to: (room: string) => chain([...roomsSoFar, room]),
    emit: (event: string, payload: unknown) => emitted.push({ rooms: roomsSoFar, event, payload }),
  });
  const socketListeners: Record<string, (socket: any) => void> = {};
  const ioOn = vi.fn((event: string, cb: (socket: any) => void) => {
    socketListeners[event] = cb;
  });
  return { emitted, chain, findMany: vi.fn(), socketListeners, ioOn };
});

const { recomputeFromLivePosition } = vi.hoisted(() => ({ recomputeFromLivePosition: vi.fn() }));
vi.mock("../src/services/etaService.js", () => ({ recomputeFromLivePosition }));

vi.mock("../src/lib/socket.js", () => ({
  io: { volatile: chain([]), on: ioOn },
  rooms: {
    role: (role: string) => `role:${role}`,
    errand: (id: string) => `errand:${id}`,
    customer: (id: number) => `customer:${id}`,
  },
  canSubscribeToErrand: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { errand: { findMany, findUnique: vi.fn() } } }));

import { broadcastRiderLocation, registerRiderLocationChannel } from "../src/lib/riderLocationBroadcast.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

let riderSeq = 100;

beforeEach(() => {
  emitted.length = 0;
  findMany.mockReset().mockResolvedValue([]);
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-09-23T08:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

const fixAt = (offsetMs: number, latitude = 6.69) => ({
  latitude,
  longitude: 124.67,
  recordedAt: Date.now() + offsetMs,
});

describe("broadcastRiderLocation", () => {
  it("reaches staff, and the customer of the rider's active errand", async () => {
    const riderId = riderSeq++;
    findMany.mockResolvedValue([{ id: "e-1", customerId: 42 }]);

    broadcastRiderLocation(riderId, fixAt(0), "socket");
    await flush();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe("rider:location");
    expect(emitted[0].rooms).toEqual(["role:DISPATCHER", "role:OWNER", "errand:e-1", "customer:42"]);
    expect(emitted[0].payload).toMatchObject({ riderId, latitude: 6.69, source: "socket" });
  });

  it("asks for an ETA refresh on every errand the rider is working", async () => {
    const riderId = riderSeq++;
    recomputeFromLivePosition.mockClear();
    findMany.mockResolvedValue([
      { id: "e-7", customerId: 1 },
      { id: "e-8", customerId: 2 },
    ]);

    broadcastRiderLocation(riderId, fixAt(0), "beacon");
    await flush();

    expect(recomputeFromLivePosition.mock.calls.map(([id]) => id)).toEqual(["e-7", "e-8"]);
  });

  it("sends at most one event per second, and the newest of a burst is never lost", async () => {
    const riderId = riderSeq++;

    broadcastRiderLocation(riderId, fixAt(0, 6.1), "socket");
    broadcastRiderLocation(riderId, fixAt(1, 6.2), "socket");
    broadcastRiderLocation(riderId, fixAt(2, 6.3), "socket");
    await flush();
    expect(emitted.map((e) => e.payload.latitude)).toEqual([6.1]);

    vi.advanceTimersByTime(1000);
    await flush();
    expect(emitted.map((e) => e.payload.latitude)).toEqual([6.1, 6.3]);
  });

  it("drops a fix older than one already sent", async () => {
    const riderId = riderSeq++;

    broadcastRiderLocation(riderId, fixAt(0, 6.5), "socket");
    await flush();
    vi.advanceTimersByTime(5000);
    // A breadcrumb backlog flushed after reconnecting, stamped before the live fix.
    broadcastRiderLocation(riderId, fixAt(-60_000, 6.0), "track");
    await flush();

    expect(emitted.map((e) => e.payload.latitude)).toEqual([6.5]);
  });

  it("still reaches staff when the errand lookup fails", async () => {
    const riderId = riderSeq++;
    findMany.mockRejectedValue(new Error("db down"));

    broadcastRiderLocation(riderId, fixAt(0), "beacon");
    await flush();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].rooms).toEqual(["role:DISPATCHER", "role:OWNER"]);
  });

  it("replaces a device timestamp that is wildly off the server clock", async () => {
    const riderId = riderSeq++;

    broadcastRiderLocation(riderId, fixAt(60 * 60 * 1000), "socket");
    await flush();

    expect(emitted[0].payload.recordedAt).toBe(Date.now());
  });

  it("ignores a fix without real coordinates", async () => {
    broadcastRiderLocation(riderSeq++, { latitude: NaN, longitude: 124.67, recordedAt: Date.now() }, "socket");
    await flush();
    expect(emitted).toHaveLength(0);
  });

  it("propagates speedMps and mocked flags on broadcast", async () => {
    const riderId = riderSeq++;
    broadcastRiderLocation(
      riderId,
      { ...fixAt(0), speedMps: 6.4, mocked: true },
      "socket"
    );
    await flush();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.speedMps).toBe(6.4);
    expect(emitted[0].payload.mocked).toBe(true);
  });

  it("omits mocked when false and sets speedMps to null when omitted", async () => {
    const riderId = riderSeq++;
    broadcastRiderLocation(
      riderId,
      { ...fixAt(0), mocked: false },
      "beacon"
    );
    await flush();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.speedMps).toBeNull();
    expect("mocked" in emitted[0].payload).toBe(false);
  });
});

describe("registerRiderLocationChannel", () => {
  it("propagates speedMps and mocked from inbound rider:location socket events", async () => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const riderId = riderSeq++;
    const fakeSocket = {
      data: { userId: 10, role: "RIDER", riderId },
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        handlers[event] = cb;
      }),
    };

    registerRiderLocationChannel();
    const onConnection = socketListeners.connection;
    expect(typeof onConnection).toBe("function");
    onConnection(fakeSocket);

    handlers["rider:location"]({
      latitude: 6.691,
      longitude: 124.672,
      heading: 90,
      accuracyMeters: 5,
      speedMps: 8.75,
      mocked: true,
      recordedAt: Date.now(),
    });
    await flush();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toMatchObject({
      riderId,
      latitude: 6.691,
      longitude: 124.672,
      speedMps: 8.75,
      mocked: true,
      source: "socket",
    });

    // Next non-mocked fix 1.5s later omits mocked and nulls missing speedMps.
    vi.advanceTimersByTime(1500);
    handlers["rider:location"]({
      latitude: 6.692,
      longitude: 124.673,
      mocked: false,
      recordedAt: Date.now(),
    });
    await flush();

    expect(emitted).toHaveLength(2);
    expect(emitted[1].payload.speedMps).toBeNull();
    expect("mocked" in emitted[1].payload).toBe(false);

    // fleet:snapshot reflects the stored speedMps and mocked state too.
    const staffHandlers: Record<string, (...args: any[]) => void> = {};
    onConnection({
      data: { userId: 1, role: "DISPATCHER" },
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        staffHandlers[event] = cb;
      }),
    });
    const ack = vi.fn();
    staffHandlers["fleet:snapshot"](ack);
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        riders: expect.arrayContaining([
          expect.objectContaining({
            riderId,
            latitude: 6.692,
            longitude: 124.673,
            speedMps: null,
          }),
        ]),
      })
    );
  });
});
