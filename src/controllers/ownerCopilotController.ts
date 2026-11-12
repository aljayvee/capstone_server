import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { copilotChatSchema } from "../validators/ownerCopilotValidators.js";
import { chatWithOwnerCopilot } from "../services/ownerCopilotService.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

/**
 * Handles incoming chat messages from the Owner Portal AI companion ("Kuya Sugo").
 * POST /api/owner/copilot/chat
 */
export const copilotChatHandler = asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { messages, portalContext } = parseOrThrow(copilotChatSchema, req.body);

  // The caller decides which tools Kuya Sugo may use (its access group).
  const response = await chatWithOwnerCopilot(
    messages,
    portalContext,
    req.user ? { id: req.user.id, role: req.user.role } : undefined
  );

  res.status(200).json(response);
});
