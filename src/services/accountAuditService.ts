import {
  accountAuditRepository,
  type CreateModificationLogInput,
} from "../repositories/accountAuditRepository.js";
import { logger } from "../lib/logger.js";

interface AuditMetadata {
  ipAddress?: string | null;
  userAgent?: string | null;
  verifiedVia?: string;
}

export async function recordCustomerModifications(
  customerId: number,
  oldState: Record<string, any>,
  newState: Record<string, any>,
  meta: AuditMetadata = {}
): Promise<void> {
  const diffs: CreateModificationLogInput[] = [];

  for (const [key, newVal] of Object.entries(newState)) {
    if (newVal === undefined) continue;

    const oldVal = oldState[key];
    const oldStr = oldVal !== null && oldVal !== undefined ? String(oldVal).trim() : null;
    const newStr = newVal !== null && newVal !== undefined ? String(newVal).trim() : null;

    if (oldStr !== newStr) {
      diffs.push({
        role: "CUSTOMER",
        customerId,
        fieldModified: key,
        oldValue: oldStr,
        newValue: newStr,
        ipAddress: meta.ipAddress || null,
        userAgent: meta.userAgent || null,
        verifiedVia: meta.verifiedVia || "RECAPTCHA",
      });
    }
  }

  if (diffs.length > 0) {
    logger.info(`[AUDIT] Recording ${diffs.length} modification logs for Customer #${customerId}`);
    await accountAuditRepository.createMany(diffs);
  }
}

export async function recordUserModifications(
  userId: number,
  role: string,
  oldState: Record<string, any>,
  newState: Record<string, any>,
  meta: AuditMetadata = {}
): Promise<void> {
  const diffs: CreateModificationLogInput[] = [];

  for (const [key, newVal] of Object.entries(newState)) {
    if (newVal === undefined) continue;

    const oldVal = oldState[key];
    const oldStr = oldVal !== null && oldVal !== undefined ? String(oldVal).trim() : null;
    const newStr = newVal !== null && newVal !== undefined ? String(newVal).trim() : null;

    if (oldStr !== newStr) {
      diffs.push({
        role: role.toUpperCase(),
        userId,
        fieldModified: key,
        oldValue: oldStr,
        newValue: newStr,
        ipAddress: meta.ipAddress || null,
        userAgent: meta.userAgent || null,
        verifiedVia: meta.verifiedVia || "RECAPTCHA",
      });
    }
  }

  if (diffs.length > 0) {
    logger.info(`[AUDIT] Recording ${diffs.length} modification logs for ${role} #${userId}`);
    await accountAuditRepository.createMany(diffs);
  }
}

export function getCustomerModificationLogs(customerId: number) {
  return accountAuditRepository.findByCustomerId(customerId);
}

export function getUserModificationLogs(userId: number) {
  return accountAuditRepository.findByUserId(userId);
}

export function getAllModificationLogs(limit?: number) {
  return accountAuditRepository.listAll(limit);
}
