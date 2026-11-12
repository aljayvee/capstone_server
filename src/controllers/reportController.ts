import { Request } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { reportPdfParamsSchema, reportQuerySchema } from "../validators/reportValidators.js";
import * as reportService from "../services/reportService.js";
import { renderReportPdf } from "../services/pdf/reportPdfService.js";
import { userRepository } from "../repositories/userRepository.js";
import { reportPrintLogRepository } from "../repositories/reportPrintLogRepository.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

/** How a role is written under a signature: "Owner", not "OWNER". */
const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner",
  SYSADMIN: "System Administrator",
  DISPATCHER: "Dispatcher",
  RIDER: "Rider",
  CUSTOMER: "Customer",
};

function parseQuery(req: Request) {
  // Passed through whole: the service decides whether an explicit start/end
  // supersedes the named period, so that precedence lives in one place rather
  // than being re-derived at every call site.
  return parseOrThrow(reportQuerySchema, req.query);
}

export const getSalesReport = asyncHandler(async (req, res) => {
  res.json(await reportService.getSalesReport(parseQuery(req)));
});

export const getRiderPerformanceReport = asyncHandler(async (req, res) => {
  res.json(await reportService.getRiderPerformanceReport(parseQuery(req)));
});

export const getCommissionReport = asyncHandler(async (req, res) => {
  res.json(await reportService.getCommissionReport(parseQuery(req)));
});

export const getSettlementReport = asyncHandler(async (req, res) => {
  res.json(await reportService.getSettlementReport(parseQuery(req)));
});

export const getTransactionSummary = asyncHandler(async (req, res) => {
  res.json(await reportService.getTransactionSummary(parseQuery(req)));
});

export const getExceptionReport = asyncHandler(async (req, res) => {
  res.json(await reportService.getExceptionReport(parseQuery(req)));
});

/**
 * Any of the six reports, as a PDF in the standard format, for the print screen.
 *
 * Replaces the dashboard's `window.print()`, which had no print stylesheet to
 * work with and so printed the whole application shell around the numbers.
 *
 * The buffer is built completely before a single byte is written. Piping PDFKit
 * straight to `res` would commit the status line first, and errorHandler.ts
 * short-circuits once `res.headersSent` — so a failure mid-render would hand the
 * owner a truncated file and no error at all. Buffering means every failure
 * still returns the ordinary JSON error the client knows how to display.
 *
 * Every print is written to report_print_logs BEFORE the document is sent. If
 * that write fails the request fails with it: a printout with no audit row is
 * exactly what the log exists to rule out.
 */
export const exportReportPdf = asyncHandler(async (req, res) => {
  const { reportType } = parseOrThrow(reportPdfParamsSchema, req.params);
  const request = parseQuery(req);

  // The JWT carries id/username/email/role but no name, and the signature on a
  // printout should name the person the way they would sign it.
  const caller = (req as AuthenticatedRequest).user;
  const account = caller ? await userRepository.findById(caller.id) : null;
  const fullName =
    [account?.firstName, account?.lastName].filter(Boolean).join(" ").trim() ||
    account?.username ||
    caller?.username ||
    "Unknown";
  const role = String(account?.role ?? caller?.role ?? "").toUpperCase();
  const roleLabel = ROLE_LABEL[role] ?? (role ? role.charAt(0) + role.slice(1).toLowerCase() : "Staff");

  // One instant for the paper and the audit row.
  const printedAt = new Date();
  const { buffer, filename, resolved, coverageLabel, subject } = await renderReportPdf({
    reportType,
    request,
    printedBy: { fullName, roleLabel },
    printedAt,
  });

  await reportPrintLogRepository.create({
    userId: account?.id ?? caller?.id ?? null,
    printedByName: fullName,
    role: role || "UNKNOWN",
    reportType,
    period: resolved.period,
    rangeStart: resolved.start,
    rangeEnd: resolved.end,
    // A one-rider printout names the rider, so the audit row says whose
    // figures left the building, not just which report.
    coverageLabel: (subject
      ? `${subject.label}: ${subject.value} (#${request.riderId}). ${coverageLabel}`
      : coverageLabel
    ).slice(0, 255),
    // req.ip only: trust-proxy resolves it from the proxies we run. A raw
    // X-Forwarded-For read is forgeable (see trustedProxies.ts).
    ipAddress: req.ip ?? null,
    userAgent: req.get("user-agent")?.slice(0, 1000) ?? null,
  });

  res.setHeader("Content-Type", "application/pdf");
  // inline: the portal shows it in the print screen; nothing should download it.
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.setHeader("Content-Length", String(buffer.length));
  // The document embeds a generated-at stamp and the identity of whoever ran it.
  // No cache, shared or private, may hold a copy of that.
  res.setHeader("Cache-Control", "no-store");

  res.send(buffer);
});
