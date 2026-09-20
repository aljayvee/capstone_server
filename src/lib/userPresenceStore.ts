// In-process presence tracking for staff/user Socket.IO connections (Owner, Dispatcher, Rider).
// A user counts as "online" while at least one of their sockets is connected.
// Tracks a Set of socket IDs per userId so multiple open tabs do not prematurely
// flip the account to offline when a single tab is closed.

const socketsByUser = new Map<number, Set<string>>();
const lastDisconnectedAt = new Map<number, number>();

export function isOnline(userId: number): boolean {
  return (socketsByUser.get(userId)?.size ?? 0) > 0;
}

export function getLastDisconnectedAt(userId: number): number | undefined {
  return lastDisconnectedAt.get(userId);
}

export function getOnlineUserIds(): number[] {
  const online: number[] = [];
  for (const [userId, sockets] of socketsByUser.entries()) {
    if (sockets.size > 0) {
      online.push(userId);
    }
  }
  return online;
}

/**
 * Returns true if this call transitioned the user from offline to online
 * (i.e. their first live socket connected).
 */
export function addSocket(userId: number, socketId: string): boolean {
  const wasOnline = isOnline(userId);
  let sockets = socketsByUser.get(userId);
  if (!sockets) {
    sockets = new Set();
    socketsByUser.set(userId, sockets);
  }
  sockets.add(socketId);
  return !wasOnline;
}

/**
 * Returns true if this call transitioned the user from online to offline
 * (i.e. their last live socket disconnected).
 */
export function removeSocket(userId: number, socketId: string): boolean {
  const sockets = socketsByUser.get(userId);
  if (!sockets) return false;
  sockets.delete(socketId);
  if (sockets.size === 0) {
    socketsByUser.delete(userId);
    lastDisconnectedAt.set(userId, Date.now());
    return true;
  }
  return false;
}
