import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/socket.js", () => ({ io: { on: vi.fn() } }));

import {
  __testing,
  HEARTBEAT_LOST_AFTER_MS,
  liveLinkOf,
  onLiveLinkChange,
  registerRiderLiveLink,
} from "../src/lib/riderLiveLink.js";
import { io } from "../src/lib/socket.js";

const T0 = 1_000_000;

beforeEach(() => __testing.reset());

describe("the one-second rider heartbeat", () => {
  it("knows nothing about a rider who never sent one", () => {
    expect(liveLinkOf(3)).toBeNull();
  });

  it("marks a rider lost after the heartbeat grace period, and says so once", () => {
    const changes: Array<[number, boolean]> = [];
    onLiveLinkChange((id, lost) => changes.push([id, lost]));

    __testing.heartbeat(3, "s1", T0);
    __testing.tick(T0 + HEARTBEAT_LOST_AFTER_MS - 1);
    expect(liveLinkOf(3)?.lost).toBe(false);

    __testing.tick(T0 + HEARTBEAT_LOST_AFTER_MS + 1);
    __testing.tick(T0 + HEARTBEAT_LOST_AFTER_MS + 500);
    expect(liveLinkOf(3)?.lost).toBe(true);
    expect(changes).toEqual([[3, true]]);
  });

  it("brings the rider back on the first heartbeat after the gap", () => {
    const changes: Array<[number, boolean]> = [];
    onLiveLinkChange((id, lost) => changes.push([id, lost]));

    __testing.heartbeat(3, "s1", T0);
    __testing.tick(T0 + HEARTBEAT_LOST_AFTER_MS + 1000);
    __testing.heartbeat(3, "s2", T0 + HEARTBEAT_LOST_AFTER_MS + 3000);

    expect(liveLinkOf(3)).toEqual({ lastHeartbeatAt: T0 + HEARTBEAT_LOST_AFTER_MS + 3000, lost: false });
    expect(changes).toEqual([
      [3, true],
      [3, false],
    ]);
  });

  it("stops expecting a heartbeat once the app says it went to the background", () => {
    __testing.heartbeat(3, "s1", T0);
    __testing.pause(3);
    __testing.tick(T0 + 60_000);
    // Silent, but not lost: beacons from the background task decide now.
    expect(liveLinkOf(3)).toBeNull();
  });

  it("ignores a flood of heartbeats from one socket", () => {
    __testing.heartbeat(3, "s1", T0);
    __testing.heartbeat(3, "s1", T0 + 100);
    expect(liveLinkOf(3)?.lastHeartbeatAt).toBe(T0);
  });

  it("applies the grace period to transport failures and tolerates a quick reconnect", () => {
    registerRiderLiveLink();
    const connection = vi.mocked(io.on).mock.calls.at(-1)![1] as (socket: any) => void;
    const handlers = new Map<string, (...args: any[]) => void>();
    connection({ id: "s1", data: { riderId: 3, role: "RIDER" }, on: (name: string, fn: any) => handlers.set(name, fn) });
    const changes = vi.fn();
    onLiveLinkChange(changes);
    __testing.heartbeat(3, "s1", T0);
    handlers.get("disconnect")!("transport close");
    expect(liveLinkOf(3)?.lost).toBe(false);
    __testing.tick(T0 + HEARTBEAT_LOST_AFTER_MS - 1);
    __testing.heartbeat(3, "s2", T0 + HEARTBEAT_LOST_AFTER_MS - 1);
    expect(changes).not.toHaveBeenCalled();
    // A late disconnect from the old socket must not affect the new link.
    handlers.get("disconnect")!("transport close");
    __testing.tick(T0 + 2 * HEARTBEAT_LOST_AFTER_MS);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledWith(3, true);
  });
});
