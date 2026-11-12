import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/pdf/reportPdfService.js", () => ({ renderReportPdf: vi.fn() }));
vi.mock("../src/repositories/userRepository.js", () => ({ userRepository: { findById: vi.fn() } }));
vi.mock("../src/repositories/reportPrintLogRepository.js", () => ({
  reportPrintLogRepository: { create: vi.fn() },
}));

import { exportReportPdf } from "../src/controllers/reportController.js";
import { renderReportPdf } from "../src/services/pdf/reportPdfService.js";
import { userRepository } from "../src/repositories/userRepository.js";
import { reportPrintLogRepository } from "../src/repositories/reportPrintLogRepository.js";

const RESOLVED = {
  start: new Date(2026, 9, 18),
  end: new Date(2026, 9, 25),
  label: "Oct 18 - Oct 24, 2026",
  period: "DAILY" as const,
};

function call() {
  const req = {
    params: { reportType: "sales" },
    query: { period: "DAILY", date: "2026-10-22" },
    user: { id: 7, username: "owner1", role: "OWNER" },
    ip: "203.0.113.9",
    get: (name: string) => (name.toLowerCase() === "user-agent" ? "Test Browser" : undefined),
  };
  const res = { setHeader: vi.fn(), send: vi.fn() };
  const next = vi.fn();

  exportReportPdf(req as never, res as never, next);
  // asyncHandler does not return its promise; let it settle.
  return new Promise<{ res: typeof res; next: typeof next }>((resolve) =>
    setTimeout(() => resolve({ res, next }), 20)
  );
}

describe("exportReportPdf print log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userRepository.findById).mockResolvedValue({
      id: 7,
      firstName: "Aljay Vee",
      lastName: "Versola",
      username: "owner1",
      role: "OWNER",
    } as never);
    vi.mocked(renderReportPdf).mockResolvedValue({
      buffer: Buffer.from("%PDF-1.3 test"),
      filename: "Sugo_Sales_Report_DAILY_2026-10-18.pdf",
      resolved: RESOLVED,
      coverageLabel: "This week, by day: Sunday, Oct 18, 2026 to Saturday, Oct 24, 2026",
      subject: null,
    });
  });

  it("signs the PDF with the full name and role, and logs the print before sending", async () => {
    vi.mocked(reportPrintLogRepository.create).mockResolvedValue({} as never);

    const { res, next } = await call();

    expect(vi.mocked(renderReportPdf).mock.calls[0][0].printedBy).toEqual({
      fullName: "Aljay Vee Versola",
      roleLabel: "Owner",
    });
    expect(reportPrintLogRepository.create).toHaveBeenCalledWith({
      userId: 7,
      printedByName: "Aljay Vee Versola",
      role: "OWNER",
      reportType: "sales",
      period: "DAILY",
      rangeStart: RESOLVED.start,
      rangeEnd: RESOLVED.end,
      coverageLabel: "This week, by day: Sunday, Oct 18, 2026 to Saturday, Oct 24, 2026",
      ipAddress: "203.0.113.9",
      userAgent: "Test Browser",
    });
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(
      vi.mocked(reportPrintLogRepository.create).mock.invocationCallOrder[0]
    ).toBeLessThan(res.send.mock.invocationCallOrder[0]);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      expect.stringMatching(/^inline;/)
    );
  });

  it("sends no PDF when the print cannot be logged", async () => {
    vi.mocked(reportPrintLogRepository.create).mockRejectedValue(new Error("db down"));

    const { res, next } = await call();

    expect(res.send).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("a one-rider print", () => {
  it("names the rider in the audit row", async () => {
    vi.clearAllMocks();
    vi.mocked(userRepository.findById).mockResolvedValue({ id: 7, firstName: "Aljay Vee", lastName: "Versola", username: "owner1", role: "OWNER" } as never);
    vi.mocked(reportPrintLogRepository.create).mockResolvedValue({} as never);
    vi.mocked(renderReportPdf).mockResolvedValue({
      buffer: Buffer.from("%PDF-1.3 test"),
      filename: "Sugo_Rider_Performance_Report_Juan_Dela_Cruz_DAILY_2026-10-18.pdf",
      resolved: RESOLVED,
      coverageLabel: "This week, by day: Sunday, Oct 18, 2026 to Saturday, Oct 24, 2026",
      subject: { label: "Rider", value: "Juan Dela Cruz" },
    });

    const req = {
      params: { reportType: "rider-performance" },
      query: { period: "DAILY", date: "2026-10-22", riderId: "3" },
      user: { id: 7, username: "owner1", role: "OWNER" },
      ip: "203.0.113.9",
      get: () => undefined,
    };
    const res = { setHeader: vi.fn(), send: vi.fn() };
    exportReportPdf(req as never, res as never, vi.fn());
    await new Promise((r) => setTimeout(r, 20));

    expect(vi.mocked(renderReportPdf).mock.calls[0][0].request).toMatchObject({ riderId: 3 });
    expect(vi.mocked(reportPrintLogRepository.create).mock.calls[0][0].coverageLabel).toBe(
      "Rider: Juan Dela Cruz (#3). This week, by day: Sunday, Oct 18, 2026 to Saturday, Oct 24, 2026"
    );
    expect(res.send).toHaveBeenCalledTimes(1);
  });
});
