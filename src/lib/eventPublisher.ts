import { io, rooms } from "./socket.js";

// Observer (real-time push) wrapped behind an Adapter interface so services depend
// on this abstraction rather than the concrete Socket.IO singleton directly (DIP).
// A future alternate transport (e.g. Redis pub/sub for multi-instance scale-out —
// see AGENTS.md server section 5) is a one-file swap of the implementation below.
export interface IEventPublisher {
  // Global broadcast to every connected client, authenticated or not. Retained
  // for the pre-existing errand-queue events whose consumers (three web hooks,
  // three CustomerApp call sites) still connect anonymously.
  //
  // Do NOT use this for anything carrying a person's location, an ETA, or
  // anything else that is not already public to every dashboard — use the
  // scoped emitters below.
  emit(event: string, payload: unknown): void;

  // Only the parties to one errand: its customer, its rider, and staff.
  emitToErrand(errandId: string, event: string, payload: unknown): void;

  // Every connected user holding a given role.
  emitToRole(role: string, event: string, payload: unknown): void;

  emitToRider(riderId: number, event: string, payload: unknown): void;
}

class SocketIOEventPublisher implements IEventPublisher {
  emit(event: string, payload: unknown): void {
    io.emit(event, payload);
  }

  // Dispatchers and owners are included alongside the errand room so staff see
  // live ETA and delay signals for work they are responsible for without having
  // to subscribe to each errand individually.
  emitToErrand(errandId: string, event: string, payload: unknown): void {
    io.to(rooms.errand(errandId)).to(rooms.role("DISPATCHER")).to(rooms.role("OWNER")).emit(event, payload);
  }

  emitToRole(role: string, event: string, payload: unknown): void {
    io.to(rooms.role(role)).emit(event, payload);
  }

  emitToRider(riderId: number, event: string, payload: unknown): void {
    io.to(rooms.rider(riderId)).emit(event, payload);
  }
}

export const eventPublisher: IEventPublisher = new SocketIOEventPublisher();
