import { Request } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { reportPdfParamsSchema, reportQuerySchema } from "../validators/reportValidators.js";
import * as reportService from "../services/reportService.js";
import { renderReportPdf } from "../services/pdf/reportPdfService.js";
import { userRepository } from "../repositories/userRepository.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

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
 * Any of the six reports, as a PDF in the standard format.
 *
 * Replaces the dashboard's `window.print()`, which had no print stylesheet to
 * work with and so printed the whole application shell around the numbers.
 *
 * The buffer is built completely before a single byte is written. Piping PDFKit
 * straight to `res` would commit the status line first, and errorHandler.ts
 * short-circuits once `res.headersSent` — so a failure mid-render would hand the
 * owner a truncated file and no error at all. Buffering means every failure
 * still returns the ordinary JSON error the client knows how to display.
 */
export const exportReportPdf = asyncHandler(async (req, res) => {
  const { reportType } = parseOrThrow(reportPdfParamsSchema, req.params);
  const request = parseQuery(req);

  // The JWT carries id/username/email/role but no name, and a report that says
  // who ran it should say it the way a person would be addressed.
  const caller = (req as AuthenticatedRequest).user;
  const account = caller ? await userRepository.findById(caller.id) : null;
  const generatedBy =
    [account?.firstName, account?.lastName].filter(Boolean).join(" ").trim() ||
    account?.username ||
    caller?.username ||
    "Unknown";

  const { buffer, filename } = await renderReportPdf({
    reportType,
    request,
    generatedBy,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.setHeader("Content-Length", String(buffer.length));
  // The document embeds a generated-at stamp and the identity of whoever ran it.
  // No cache, shared or private, may hold a copy of that.
  res.setHeader("Cache-Control", "no-store");

  res.send(buffer);
});
