import { Request } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { parseOrThrow } from "../validators/validate.js";
import { reportQuerySchema } from "../validators/reportValidators.js";
import * as reportService from "../services/reportService.js";

function parseQuery(req: Request) {
  const { period, date } = parseOrThrow(reportQuerySchema, req.query);
  return { period, referenceDate: date ?? new Date() };
}

export const getSalesReport = asyncHandler(async (req, res) => {
  const { period, referenceDate } = parseQuery(req);
  res.json(await reportService.getSalesReport(period, referenceDate));
});

export const getRiderPerformanceReport = asyncHandler(async (req, res) => {
  const { period, referenceDate } = parseQuery(req);
  res.json(await reportService.getRiderPerformanceReport(period, referenceDate));
});

export const getCommissionReport = asyncHandler(async (req, res) => {
  const { period, referenceDate } = parseQuery(req);
  res.json(await reportService.getCommissionReport(period, referenceDate));
});

export const getSettlementReport = asyncHandler(async (req, res) => {
  const { period, referenceDate } = parseQuery(req);
  res.json(await reportService.getSettlementReport(period, referenceDate));
});

export const getTransactionSummary = asyncHandler(async (req, res) => {
  const { period, referenceDate } = parseQuery(req);
  res.json(await reportService.getTransactionSummary(period, referenceDate));
});
