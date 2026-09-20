import { Response } from "express";
import jwt from "jsonwebtoken";
import { getTrafficSummary, getGoAccessHtmlReport } from "../services/sysAdminTrafficService.js";
import { ServiceError } from "../services/ServiceError.js";
import { JWT_SECRET } from "../config/env.js";
import { isRevoked } from "../lib/blocklistCache.js";
import type { AuthenticatedRequest, TokenPayload } from "../middleware/auth.js";

export async function getTrafficSummaryHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const summary = await getTrafficSummary();
    return res.status(200).json(summary);
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : "Failed to fetch traffic summary.";
    return res.status(500).json({ error: message });
  }
}

export async function getGoAccessHtmlReportHandler(req: AuthenticatedRequest, res: Response) {
  try {
    // Check if token is passed either in Bearer Header or as query param (for iframe embedding)
    let token = req.headers["authorization"]?.split(" ")[1];
    if (!token && typeof req.query.token === "string") {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).send("<h1>401 Unauthorized: Valid SysAdmin session token required</h1>");
    }

    if (await isRevoked(token)) {
      return res.status(401).send("<h1>401 Unauthorized: Token has been revoked</h1>");
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload;
      if (decoded.role !== "SYSADMIN") {
        return res.status(403).send("<h1>403 Forbidden: SysAdmin privileges required</h1>");
      }
    } catch {
      return res.status(401).send("<h1>401 Unauthorized: Invalid or expired token</h1>");
    }

    const html = await getGoAccessHtmlReport();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    return res.status(200).send(html);
  } catch (err: unknown) {
    return res.status(500).send("<h1>500 Internal Server Error: Failed to generate GoAccess report</h1>");
  }
}
