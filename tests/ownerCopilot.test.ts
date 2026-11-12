import { describe, it, expect, vi, beforeEach } from "vitest";
import { copilotChatSchema } from "../src/validators/ownerCopilotValidators.js";
import {
  executeSalesPulse,
  executeFleetHealth,
  executeExceptionRecap,
  executeCategoryPerformance,
  chatWithOwnerCopilot,
} from "../src/services/ownerCopilotService.js";

// Mock prisma and services
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    errand: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    dwellObservation: {
      findMany: vi.fn(),
    },
    errandPinpoint: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../src/repositories/userRepository.js", () => ({
  userRepository: {
    findAllRiders: vi.fn(),
  },
}));

vi.mock("../src/services/riderBeaconService.js", () => ({
  availabilityForRiders: vi.fn(),
}));

vi.mock("../src/services/exceptionService.js", () => ({
  findExceptions: vi.fn(),
}));

vi.mock("../src/services/reportService.js", () => ({
  getSalesReport: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { userRepository } from "../src/repositories/userRepository.js";
import * as riderBeaconService from "../src/services/riderBeaconService.js";
import * as exceptionService from "../src/services/exceptionService.js";
import * as reportService from "../src/services/reportService.js";

describe("Owner AI Copilot ('Kuya Sugo') Backend Service & Tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Validation Schema (copilotChatSchema)", () => {
    it("should accept valid chat messages payload", () => {
      const valid = {
        messages: [
          { role: "user", content: "What is today's sales pulse?" },
        ],
        portalContext: { activeModule: "dashboard" },
      };
      const parsed = copilotChatSchema.safeParse(valid);
      expect(parsed.success).toBe(true);
    });

    it("should reject empty messages array", () => {
      const invalid = { messages: [] };
      const parsed = copilotChatSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });

    it("should reject empty message content", () => {
      const invalid = {
        messages: [{ role: "user", content: "   " }],
      };
      const parsed = copilotChatSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });

    it("should accept detailed assistant messages exceeding 2,000 chars in history", () => {
      const longAssistantReply = "Sales report: ".repeat(200); // ~2,800 chars
      const payload = {
        messages: [
          { role: "user", content: "Show me the report" },
          { role: "model", content: longAssistantReply },
          { role: "user", content: "What was the top store?" },
        ],
      };
      const parsed = copilotChatSchema.safeParse(payload);
      expect(parsed.success).toBe(true);
    });

    it("should reject user message exceeding 2,000 characters", () => {
      const longUserQuery = "a".repeat(2001);
      const invalid = {
        messages: [{ role: "user", content: longUserQuery }],
      };
      const parsed = copilotChatSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });
  });

  describe("Tool: executeSalesPulse", () => {
    it("should calculate correct gross sales, delivery fees, and order counts", async () => {
      const mockErrands = [
        { totalCost: 550, deliveryFee: 70, tip: 20, estimatedCost: 460 },
        { totalCost: 320, deliveryFee: 50, tip: 0, estimatedCost: 270 },
      ];

      (prisma.errand.findMany as any).mockResolvedValue(mockErrands);
      (prisma.errand.groupBy as any).mockResolvedValue([
        { status: "AVAILABLE", _count: { _all: 2 } },
        { status: "IN_TRANSIT", _count: { _all: 1 } },
      ]);

      const result = await executeSalesPulse("today");

      expect(result.completedOrders).toBe(2);
      // GMV = (550 - 20) + (320 - 0) = 530 + 320 = 850
      expect(result.grossSalesPesos).toBe(850);
      expect(result.deliveryFeesPesos).toBe(120);
      expect(result.tipsPesos).toBe(20);
      expect(result.itemCostPesos).toBe(730);
      expect(result.currentLiveQueue.ordersWaitingForDispatcher).toBe(2);
      expect(result.currentLiveQueue.ordersInTransitWithRider).toBe(1);
    });
  });

  describe("Tool: executeFleetHealth", () => {
    it("should categorize idle riders, active orders, and store delays", async () => {
      (userRepository.findAllRiders as any).mockResolvedValue([
        { id: 1, firstName: "Juan", lastName: "Dela Cruz" },
        { id: 2, firstName: "Pedro", lastName: "Penduko" },
      ]);

      const availabilityMap = new Map([
        [1, { state: "AVAILABLE" }],
        [2, { state: "AVAILABLE" }],
      ]);
      (riderBeaconService.availabilityForRiders as any).mockResolvedValue(availabilityMap);

      (prisma.errand.findMany as any).mockResolvedValue([
        {
          id: "err-1",
          referenceNo: "261027-ABC12-0001",
          riderId: 1,
          status: "IN_TRANSIT",
          category: "Fast Food",
          assignedAt: new Date(Date.now() - 15 * 60000),
          acceptedAt: new Date(Date.now() - 14 * 60000),
          itemsPurchasedAt: null,
          rider: { firstName: "Juan", lastName: "Dela Cruz" },
        },
      ]);

      (prisma.dwellObservation.findMany as any).mockResolvedValue([
        {
          id: 101,
          errandId: "err-1",
          dwellSeconds: 1500, // 25 mins
          createdAt: new Date(),
          errand: {
            referenceNo: "261027-ABC12-0001",
            rider: { firstName: "Juan", lastName: "Dela Cruz" },
          },
          pinpoint: { storeName: "McDonald's Tacurong" },
        },
      ]);

      (prisma.errandPinpoint.findMany as any).mockResolvedValue([
        {
          id: 202,
          storeName: "Jollibee Tacurong",
          arrivedAt: new Date(Date.now() - 30 * 60000), // 30 mins ago
          departedAt: null,
          errand: {
            id: "err-1",
            referenceNo: "261027-ABC12-0001",
            rider: { firstName: "Juan", lastName: "Dela Cruz" },
          },
        },
      ]);

      const result = await executeFleetHealth();

      expect(result.totalRosterCount).toBe(2);
      expect(result.onDutyCount).toBe(2);
      expect(result.activeErrandsCount).toBe(1);
      expect(result.idleOnDutyCount).toBe(1); // Pedro is idle
      expect(result.idleRiders).toContain("Pedro Penduko");
      expect(result.delaysAtStores.length).toBe(2);
      expect(result.delaysAtStores.some((d) => d.storeName === "McDonald's Tacurong")).toBe(true);
      expect(result.delaysAtStores.some((d) => d.storeName === "Jollibee Tacurong")).toBe(true);
    });
  });

  describe("Tool: executeExceptionRecap", () => {
    it("should aggregate exceptions and cancelled errands", async () => {
      (exceptionService.findExceptions as any).mockResolvedValue({
        summary: {
          openCount: 2,
          resolvedCount: 3,
          totalAtRisk: 420.5,
          byKind: [{ kind: "CASH_VARIANCE", count: 1, atRisk: 120.5 }],
        },
        exceptions: [
          {
            errandId: "err-2",
            referenceNo: "261027-XYZ-0002",
            kind: "CASH_VARIANCE",
            amountAtRisk: 120.5,
            detail: "Short ₱120.50 at door",
            riderName: "Juan Dela Cruz",
            resolvedAt: null,
          },
        ],
      });

      (prisma.errand.findMany as any).mockResolvedValue([
        {
          id: "err-3",
          referenceNo: "261027-CAN-0003",
          createdAt: new Date(),
          declineReasons: [{ reason: "Store was closed" }],
        },
      ]);

      const result = await executeExceptionRecap("week");

      expect(result.openExceptionsCount).toBe(2);
      expect(result.totalPesosAtRisk).toBe(420.5);
      expect(result.totalCancelledOrders).toBe(1);
      expect(result.commonCancellationReasons[0].reason).toBe("Store was closed");
      expect(result.topOpenIssues[0].referenceNo).toBe("261027-XYZ-0002");
    });

    it("should scrub customer phone numbers from exception details and decline reasons", async () => {
      (exceptionService.findExceptions as any).mockResolvedValue({
        summary: { openCount: 1, resolvedCount: 0, totalAtRisk: 100, byKind: [] },
        exceptions: [
          {
            errandId: "err-p",
            referenceNo: "261027-PII-0001",
            kind: "UNPAID_BALANCE",
            amountAtRisk: 100,
            detail: "Customer at 09171234567 promised to pay via GCash",
            riderName: "Juan Dela Cruz",
            resolvedAt: null,
          },
        ],
      });

      (prisma.errand.findMany as any).mockResolvedValue([
        {
          id: "err-can",
          referenceNo: "261027-CAN-0002",
          createdAt: new Date(),
          declineReasons: [{ reason: "Called customer 09987654321 but no answer" }],
        },
      ]);

      const result = await executeExceptionRecap("week");

      expect(result.topOpenIssues[0].detail).not.toContain("09171234567");
      expect(result.topOpenIssues[0].detail).toContain("[PHONE_MASKED]");
      expect(result.commonCancellationReasons[0].reason).not.toContain("09987654321");
      expect(result.commonCancellationReasons[0].reason).toContain("[PHONE_MASKED]");
    });
  });

  describe("Tool: executeCategoryPerformance", () => {
    it("should rank top categories by sales volume", async () => {
      (reportService.getSalesReport as any).mockResolvedValue({
        coverageLabel: "October 2026",
        totalRevenue: 50000,
        totalOrders: 200,
        byCategory: [
          {
            category: "Fast Food & Restaurant",
            revenue: 25000,
            itemCost: 20000,
            deliveryFee: 5000,
            orderCount: 120,
          },
          {
            category: "Supermarket & Grocery",
            revenue: 15000,
            itemCost: 12000,
            deliveryFee: 3000,
            orderCount: 50,
          },
        ],
      });

      const result = await executeCategoryPerformance("month");

      expect(result.totalRevenuePesos).toBe(50000);
      expect(result.totalOrders).toBe(200);
      expect(result.topCategories[0].category).toBe("Fast Food & Restaurant");
      expect(result.topCategories[0].shareOfTotalSalesPercent).toBe(50);
    });
  });

  describe("chatWithOwnerCopilot Deterministic Grounding & Anti-AI-Slop Invariants", () => {
    it("should process chat and sanitize any em dashes in reply", async () => {
      // Mock fetch to simulate Gemini tool calling loop cleanly in unit tests
      const originalFetch = global.fetch;
      const mockFetch = vi.fn();

      // Turn 1: model calls getSalesPulse
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      name: "getSalesPulse",
                      args: { period: "today" },
                    },
                    thoughtSignature: "mock-sig",
                  },
                ],
              },
            },
          ],
        }),
      });

      // Turn 2: model answers with grounded text
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: "Kumusta, Boss! Today we achieved ₱12,500 in total sales across 35 completed orders.",
                  },
                ],
              },
            },
          ],
        }),
      });

      global.fetch = mockFetch;

      (prisma.errand.findMany as any).mockResolvedValue([
        { totalCost: 500, deliveryFee: 70, tip: 0, estimatedCost: 430 },
      ]);
      (prisma.errand.groupBy as any).mockResolvedValue([]);

      try {
        const response = await chatWithOwnerCopilot([
          { role: "user", content: "What is today's sales pulse?" },
        ]);

        expect(response.reply).toBeDefined();
        expect(response.reply).toContain("Kumusta, Boss!");
        expect(response.reply).not.toContain("—");
        expect(response.reply).not.toContain("–");
        expect(response.toolsUsed).toContain("getSalesPulse");
        expect(response.actionLinks.some((l) => l.target === "sales")).toBe(true);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("should gracefully handle external API failure by using deterministic DB fallback", async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error("Network connection lost"));

      (prisma.errand.findMany as any).mockResolvedValue([
        { totalCost: 1000, deliveryFee: 140, tip: 0, estimatedCost: 860 },
      ]);
      (prisma.errand.groupBy as any).mockResolvedValue([]);

      try {
        const response = await chatWithOwnerCopilot([
          { role: "user", content: "Show me today's sales" },
        ]);

        expect(response.reply).toBeDefined();
        expect(response.reply).toContain("Sales Pulse");
        expect(response.reply).not.toContain("—");
        expect(response.toolsUsed).toContain("getSalesPulse");
        expect(response.actionLinks.some((l) => l.target === "sales")).toBe(true);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("should group parallel function responses into a single user turn", async () => {
      const originalFetch = global.fetch;
      const mockFetch = vi.fn();

      // Turn 1: model returns 2 function calls in parallel
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { functionCall: { name: "getSalesPulse", args: { period: "today" } } },
                  { functionCall: { name: "getCategoryPerformance", args: { period: "month" } } },
                ],
              },
            },
          ],
        }),
      });

      // Turn 2: model returns final grounded answer
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "Sales today is ₱5,000, and Fast Food leads all categories." }],
              },
            },
          ],
        }),
      });

      global.fetch = mockFetch;
      (prisma.errand.findMany as any).mockResolvedValue([]);
      (prisma.errand.groupBy as any).mockResolvedValue([]);
      (reportService.getSalesReport as any).mockResolvedValue({
        coverageLabel: "October 2026",
        totalRevenue: 5000,
        totalOrders: 10,
        byCategory: [],
      });

      try {
        const response = await chatWithOwnerCopilot([
          { role: "user", content: "Give me sales and category breakdown" },
        ]);

        expect(response.toolsUsed).toContain("getSalesPulse");
        expect(response.toolsUsed).toContain("getCategoryPerformance");
        expect(response.reply).toContain("Sales today is ₱5,000");

        // Verify the second fetch request payload: the turn following the model's parallel call
        // MUST have role: "user" and parts array with 2 functionResponse objects
        expect(mockFetch).toHaveBeenCalledTimes(2);
        const secondCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
        const lastUserTurn = secondCallBody.contents[secondCallBody.contents.length - 1];
        expect(lastUserTurn.role).toBe("user");
        expect(lastUserTurn.parts.length).toBe(2);
        expect(lastUserTurn.parts[0].functionResponse.name).toBe("getSalesPulse");
        expect(lastUserTurn.parts[1].functionResponse.name).toBe("getCategoryPerformance");
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("should strip leading model greetings so request always starts with role user", async () => {
      const originalFetch = global.fetch;
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "All fleet operations are green." }],
              },
            },
          ],
        }),
      });

      global.fetch = mockFetch;

      try {
        await chatWithOwnerCopilot([
          { role: "model", content: "Magandang araw, Boss! Ako si Kuya Sugo." },
          { role: "user", content: "Fleet status please" },
        ]);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
        // The first content in the sent Gemini payload MUST be role 'user'
        expect(requestBody.contents[0].role).toBe("user");
        expect(requestBody.contents[0].parts[0].text).toContain("Fleet status please");
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("should refuse requests when Kuya Sugo is disabled by SysAdmin", async () => {
      const { setKuyaSugoEnabled } = await import("../src/services/sysAdminDevOpsService.js");
      await setKuyaSugoEnabled(false);
      try {
        const response = await chatWithOwnerCopilot([
          { role: "user", content: "What is today's sales?" },
        ]);
        expect(response.reply).toContain("Kuya Sugo is currently turned off by the system administrator");
        expect(response.toolsUsed).toEqual([]);
      } finally {
        await setKuyaSugoEnabled(true);
      }
    });
  });
});
