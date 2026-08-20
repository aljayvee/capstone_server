import { Server, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { ALLOWED_ORIGINS, JWT_SECRET } from "../config/env.js";
import { logger } from "./logger.js";
import * as riderPresenceStore from "./riderPresenceStore.js";
import { errandRepository } from "../repositories/errandRepository.js";
import type { TokenPayload } from "../middleware/auth.js";

// NOTE: emits `io.emit(...)` directly rather than going through
// eventPublisher.ts's IEventPublisher wrapper — that wrapper imports `io`
// from this very file, so importing it back here would be a circular import.
// socket.ts is already the concrete Socket.IO implementation; eventPublisher
// exists to decouple *other* modules (services) from it, not this one.

// Constructed standalone (no httpServer yet) so this module has no dependency on
// index.ts/app bootstrap — route files can import `io` directly without a circular
// import. index.ts calls `io.attach(httpServer)` once the HTTP server exists.
export const io = new Server({
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, origin);
      }
      return callback(new Error("CORS policy violation: Origin not allowed"));
    },
    credentials: true,
  },
});

interface AuthenticatedSocketData {
  riderId?: number;
  // Identity from the verified JWT, when one was supplied. Undefined for the
  // anonymous connections some clients still make.
  userId?: number;
  role?: string;
}

// Room naming. Rooms exist because every event used to go to every connected
// client via a bare io.emit — including clients that never authenticated. That
// was survivable while events carried only errand metadata; it is not once they
// carry a rider's live position and ETA.
export const rooms = {
  role: (role: string) => `role:${role.toUpperCase()}`,
  rider: (riderId: number) => `rider:${riderId}`,
  customer: (customerId: number) => `customer:${customerId}`,
  errand: (errandId: string) => `errand:${errandId}`,
};

// Whether this identity may listen to one errand's private channel. Mirrors the
// object-level checks GET /errands/:id already enforces over HTTP — a socket
// subscription must not be a way around them.
async function canSubscribeToErrand(
  errandId: string,
  userId: number | undefined,
  role: string | undefined
): Promise<boolean> {
  const normalizedRole = String(role || "").toUpperCase();
  if (!userId || !normalizedRole) return false;
  if (normalizedRole === "OWNER" || normalizedRole === "DISPATCHER") return true;

  const errand = await errandRepository.findStatusAndRiderById(errandId);
  if (!errand) return false;
  if (normalizedRole === "RIDER") return errand.riderId === userId;

  if (normalizedRole === "CUSTOMER") {
    const full = await errandRepository.findByIdBasic(errandId);
    return full?.customerId === userId;
  }
  return false;
}

// Verifies the same JWT already used for REST calls, when the client sends
// one via the handshake `auth` option. Deliberately non-blocking on a
// missing/invalid token — `next()` always runs — so the web dashboard's
// existing unauthenticated socket connections (dispatcher/owner tracking and
// chat views, none of which send a token today) keep working unchanged. Only
// verified RIDER connections get registered in the presence store below.
io.use((socket: Socket & { data: AuthenticatedSocketData }, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token === "string" && token) {
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (!err && decoded) {
        const payload = decoded as TokenPayload;
        const role = String(payload.role || "").toUpperCase();
        socket.data.userId = payload.id;
        socket.data.role = role;
        if (role === "RIDER") {
          socket.data.riderId = payload.id;
        }
      }
      next();
    });
    return;
  }
  next();
});

io.on("connection", (socket: Socket & { data: AuthenticatedSocketData }) => {
  logger.info(`🔌 Client connected to Socket.IO: ${socket.id}`);

  // Identity-scoped rooms, joined once at connect. An anonymous socket joins
  // nothing and therefore receives only the legacy global broadcasts.
  const { userId, role } = socket.data;
  if (userId !== undefined && role) {
    socket.join(rooms.role(role));
    if (role === "RIDER") socket.join(rooms.rider(userId));
    if (role === "CUSTOMER") socket.join(rooms.customer(userId));
  }

  // Per-errand channel, joined on request and only after the same ownership
  // check the HTTP endpoint applies. Acknowledged so the client can tell an
  // authorization failure from a silent no-op.
  socket.on("subscribe:errand", async (errandId: unknown, ack?: (result: unknown) => void) => {
    if (typeof errandId !== "string" || !errandId) {
      ack?.({ ok: false, error: "errandId must be a string" });
      return;
    }
    try {
      const allowed = await canSubscribeToErrand(errandId, userId, role);
      if (!allowed) {
        ack?.({ ok: false, error: "Not authorized for this errand" });
        return;
      }
      socket.join(rooms.errand(errandId));
      ack?.({ ok: true });
    } catch (error) {
      logger.error(`subscribe:errand failed for ${errandId}:`, error);
      ack?.({ ok: false, error: "Subscription failed" });
    }
  });

  socket.on("unsubscribe:errand", (errandId: unknown) => {
    if (typeof errandId === "string" && errandId) socket.leave(rooms.errand(errandId));
  });

  const riderId = socket.data.riderId;
  if (riderId !== undefined) {
    const becameOnline = riderPresenceStore.addSocket(riderId, socket.id);
    if (becameOnline) {
      io.emit("rider:presence_changed", { riderId, online: true });
    }
  }

  socket.on("disconnect", () => {
    logger.info(`🔌 Client disconnected: ${socket.id}`);
    if (riderId !== undefined) {
      const becameOffline = riderPresenceStore.removeSocket(riderId, socket.id);
      if (becameOffline) {
        io.emit("rider:presence_changed", { riderId, online: false });
      }
    }
  });
});
