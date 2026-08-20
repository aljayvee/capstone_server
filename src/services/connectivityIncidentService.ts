import { connectivityIncidentRepository } from "../repositories/connectivityIncidentRepository.js";
import { ServiceError } from "./ServiceError.js";

// Idempotent: if the rider already has an open incident (e.g. the device
// flapped and fired a second "disconnected" event before reconnecting, or
// the app was killed mid-incident and the client is re-flushing a backfilled
// copy of one the server already has), return that one instead of opening a
// duplicate row. `disconnectedAt` lets the client backfill the real moment
// connectivity dropped when this call only lands once back online — see
// useConnectivity.ts's queue-then-flush design.
export async function openIncident(riderId: number, errandId?: string, disconnectedAt?: Date) {
  const existing = await connectivityIncidentRepository.findOpenForRider(riderId);
  if (existing) {
    return existing;
  }
  return connectivityIncidentRepository.create({ riderId, errandId, disconnectedAt });
}

export async function resolveIncident(incidentId: number, riderId: number) {
  const incident = await connectivityIncidentRepository.findById(incidentId);
  if (!incident) {
    throw new ServiceError(404, "Connectivity incident not found");
  }
  if (incident.riderId !== riderId) {
    throw new ServiceError(403, "Access denied: You can only resolve your own connectivity incidents.");
  }
  if (incident.reconnectedAt) {
    return incident;
  }
  return connectivityIncidentRepository.resolve(incidentId);
}
