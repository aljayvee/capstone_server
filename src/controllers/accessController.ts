import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { getClientIp } from "../lib/requestContext.js";
import {
  accountAccessSchema,
  createAccessGroupSchema,
  updateAccessGroupSchema,
} from "../validators/accessValidators.js";
import * as accessService from "../services/accessService.js";
import { ServiceError } from "../services/ServiceError.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

function auditContext(req: AuthenticatedRequest): accessService.AuditContext {
  return { ipAddress: getClientIp(req), userAgent: req.get("user-agent") ?? null };
}

function idParam(value: string | undefined, what: string): number {
  const id = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(id) || id <= 0) throw new ServiceError(400, `Invalid ${what}.`);
  return id;
}

// GET /api/account/permissions - the signed-in Admin's or dispatcher's own access.
export const getOwnPermissions = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json(await accessService.getOwnPermissions(req.user!));
});

// Everything below is the Main Owner's (requireMainOwner on every route).
export const getCatalog = asyncHandler<AuthenticatedRequest>(async (_req, res) => {
  res.json(accessService.getCatalog());
});

export const listGroups = asyncHandler<AuthenticatedRequest>(async (_req, res) => {
  res.json({ groups: await accessService.listGroups() });
});

export const createGroup = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const input = parseOrThrow(createAccessGroupSchema, req.body);
  res.status(201).json(await accessService.createGroup(input, req.user!.id));
});

export const updateGroup = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const input = parseOrThrow(updateAccessGroupSchema, req.body);
  res.json(await accessService.updateGroup(idParam(req.params.id, "group id"), input, req.user!.id, auditContext(req)));
});

export const deleteGroup = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json(await accessService.deleteGroup(idParam(req.params.id, "group id")));
});

export const listAccounts = asyncHandler<AuthenticatedRequest>(async (_req, res) => {
  res.json({ accounts: await accessService.listAccounts() });
});

export const updateAccountAccess = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const input = parseOrThrow(accountAccessSchema, req.body);
  res.json(
    await accessService.updateAccountAccess(idParam(req.params.userId, "account id"), input, req.user!.id, auditContext(req))
  );
});
