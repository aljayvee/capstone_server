import { Response } from "express";
import {
  requestProfileChangeOtp,
  verifyProfileChangeOtp,
  updateAdminProfile,
} from "../services/sysAdminAuthService.js";
import { ServiceError } from "../services/ServiceError.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

export async function requestProfileOtpHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const adminId = req.user?.id;
    if (!adminId) return res.status(401).json({ error: "Unauthorized." });
    const result = await requestProfileChangeOtp(adminId);
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: "Failed to send verification code." });
  }
}

export async function verifyProfileOtpHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const adminId = req.user?.id;
    if (!adminId) return res.status(401).json({ error: "Unauthorized." });
    const { otp } = req.body;
    if (!otp) return res.status(400).json({ error: "Verification code is required." });
    const result = await verifyProfileChangeOtp(adminId, String(otp));
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ServiceError) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: "Failed to verify code." });
  }
}

export async function updateProfileHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const adminId = req.user?.id;
    if (!adminId) return res.status(401).json({ error: "Unauthorized." });
    const { changeToken, currentPassword, ...newData } = req.body;
    if (!changeToken) return res.status(400).json({ error: "Profile change token is required." });
    if (!currentPassword) return res.status(400).json({ error: "Current password is required to confirm changes." });
    const updated = await updateAdminProfile(adminId, changeToken, currentPassword, newData);
    return res.status(200).json({ message: "Profile updated successfully.", admin: updated });
  } catch (err: unknown) {
    if (err instanceof ServiceError) return res.status(err.status).json({ error: err.message });
    const message = err instanceof Error ? err.message : "Failed to update profile.";
    return res.status(500).json({ error: message });
  }
}
