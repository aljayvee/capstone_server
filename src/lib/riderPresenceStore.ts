// In-process presence tracking for riders' Socket.IO connections. A rider
// counts as "online" while at least one of their sockets is connected — this
// is session/connection presence only, never coordinates (see AGENTS.md
// section 5: GPS stays exclusively in Firebase, never this backend). A Set
// per rider (not a single socketId) so a rider with more than one live
// connection doesn't get marked offline by the first one to disconnect.
const socketsByRider = new Map<number, Set<string>>();
const lastDisconnectedAt = new Map<number, number>();

export function isOnline(riderId: number): boolean {
  return (socketsByRider.get(riderId)?.size ?? 0) > 0;
}

export function getLastDisconnectedAt(riderId: number): number | undefined {
  return lastDisconnectedAt.get(riderId);
}

// Returns true if this call transitioned the rider from offline to online
// (i.e. their first live socket) — the caller uses this to decide whether to
// broadcast a presence-changed event.
export function addSocket(riderId: number, socketId: string): boolean {
  const wasOnline = isOnline(riderId);
  let sockets = socketsByRider.get(riderId);
  if (!sockets) {
    sockets = new Set();
    socketsByRider.set(riderId, sockets);
  }
  sockets.add(socketId);
  return !wasOnline;
}

// Returns true if this call transitioned the rider from online to offline
// (i.e. their last live socket disconnected).
export function removeSocket(riderId: number, socketId: string): boolean {
  const sockets = socketsByRider.get(riderId);
  if (!sockets) return false;
  sockets.delete(socketId);
  if (sockets.size === 0) {
    socketsByRider.delete(riderId);
    lastDisconnectedAt.set(riderId, Date.now());
    return true;
  }
  return false;
}
