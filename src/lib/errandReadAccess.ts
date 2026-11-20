import { ServiceError } from "../services/ServiceError.js";

// The fields the check reads. findById's ERRAND_INCLUDE already carries the
// latest dispatch log (take 1, newest first) with the dispatcher's name.
export interface DispatcherReadableErrand {
  status: string;
  dispatchLogs?: Array<{
    dispatcherId: number;
    dispatcher?: { firstName: string; lastName: string } | null;
  }>;
}

export interface ErrandReadCaller {
  id?: number;
  role?: string;
}

/**
 * IDOR check: dispatchers can only see unclaimed (AVAILABLE) errands, or
 * errands they claimed. Shared by the errand record and its GPS trail, so the
 * trail is never easier to read than the errand it belongs to.
 *
 * Other roles pass through untouched: the caller's route decides who reaches
 * here at all, and customers and riders have their own checks.
 */
export function assertDispatcherMayRead(errand: DispatcherReadableErrand, caller: ErrandReadCaller): void {
  const callerRole = String(caller.role || "").toUpperCase();
  const callerId = caller.id;
  if (callerRole !== "DISPATCHER" || !callerId) return;

  const latestLog = errand.dispatchLogs?.[0];
  const isAvailable = String(errand.status).toUpperCase() === "AVAILABLE";
  if (!isAvailable && latestLog && latestLog.dispatcherId !== callerId) {
    const claimant = latestLog.dispatcher
      ? `${latestLog.dispatcher.firstName} ${latestLog.dispatcher.lastName}`.trim()
      : "another dispatcher";
    throw new ServiceError(403, `Access denied: This errand is currently assigned to ${claimant}.`);
  }
}
