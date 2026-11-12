import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { userRepository } from "../repositories/userRepository.js";
import * as riderBeaconService from "./riderBeaconService.js";
import * as exceptionService from "./exceptionService.js";
import * as reportService from "./reportService.js";
import { RIDER_SHARE_RATE } from "./patterns/commissionSplit.js";
import { type ReportPeriod } from "./patterns/reportPeriodStrategy.js";
import { getKuyaSugoEnabled } from "./sysAdminDevOpsService.js";
import { callerHasPermission } from "../lib/permissionCache.js";
import type { CopilotChatMessage } from "../validators/ownerCopilotValidators.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

export function scrubPii(text: string): string {
  if (!text) return "";
  return text
    .replace(/(?:\+63|0)9\d{2}[-\s]?\d{3}[-\s]?\d{4}/g, "[PHONE_MASKED]")
    .replace(/(?:\+63|0)9\d{9}/g, "[PHONE_MASKED]");
}

export interface CopilotActionLink {
  label: string;
  action: "open_module" | "open_report";
  target: string;
  description?: string;
}

export interface CopilotChatResponse {
  reply: string;
  toolsUsed: string[];
  actionLinks: CopilotActionLink[];
}

/**
 * Resolves Gemini API key with priority:
 * 1. process.env.GEMINI_API_KEY
 * 2. process.env.GEMMA_API_KEY
 * 3. ml/.env file (development & container fallback)
 */
function resolveGeminiApiKey(): string | null {
  if (process.env.GEMINI_API_KEY?.trim()) return process.env.GEMINI_API_KEY.trim();
  if (process.env.GEMMA_API_KEY?.trim()) return process.env.GEMMA_API_KEY.trim();

  try {
    const candidatePaths = [
      path.resolve(process.cwd(), "ml/.env"),
      path.resolve(process.cwd(), "../ml/.env"),
      path.resolve(process.cwd(), "../../ml/.env"),
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        const parsed = dotenv.parse(fs.readFileSync(p, "utf-8"));
        const key = parsed.GEMMA_API_KEY?.trim() || parsed.GEMINI_API_KEY?.trim();
        if (key) {
          process.env.GEMMA_API_KEY = key;
          return key;
        }
      }
    }
  } catch (err) {
    logger.warn("[OwnerCopilot] Could not read ml/.env for Gemini API key:", err);
  }
  return null;
}

function resolvePeriodDates(period: string = "today"): { start: Date; end: Date; label: string } {
  const normalized = (period || "today").toLowerCase().trim();
  const now = new Date();

  // Local Manila calendar boundary
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);

  if (normalized === "yesterday") {
    const yestStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
    return {
      start: yestStart,
      end: todayStart,
      label: `Yesterday (${yestStart.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})`,
    };
  }

  if (normalized === "week" || normalized === "weekly") {
    // Current Sunday start
    const dayOfWeek = todayStart.getDay(); // 0 is Sunday
    const weekStart = new Date(todayStart);
    weekStart.setDate(todayStart.getDate() - dayOfWeek);
    return {
      start: weekStart,
      end: tomorrowStart,
      label: `This Week (since Sunday, ${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })})`,
    };
  }

  if (normalized === "month" || normalized === "monthly") {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    return {
      start: monthStart,
      end: tomorrowStart,
      label: `This Month (${now.toLocaleDateString("en-US", { month: "long", year: "numeric" })})`,
    };
  }

  if (normalized === "year" || normalized === "yearly") {
    const yearStart = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    return {
      start: yearStart,
      end: tomorrowStart,
      label: `Year ${now.getFullYear()}`,
    };
  }

  // Default: Today
  return {
    start: todayStart,
    end: tomorrowStart,
    label: `Today (${now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})`,
  };
}

// ── Tool 1: Sales Pulse ──────────────────────────────────────────────────────
export async function executeSalesPulse(period: string = "today") {
  const { start, end, label } = resolvePeriodDates(period);

  const [finishedRows, statusCounts] = await Promise.all([
    prisma.errand.findMany({
      where: {
        createdAt: { gte: start, lt: end },
        status: { in: ["DELIVERED", "COMPLETED"] },
      },
      select: {
        totalCost: true,
        deliveryFee: true,
        tip: true,
        estimatedCost: true,
      },
    }),
    prisma.errand.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
  ]);

  const completedOrders = finishedRows.length;
  const grossSales = round2(finishedRows.reduce((sum, r) => sum + (r.totalCost - (r.tip ?? 0)), 0));
  const deliveryFees = round2(finishedRows.reduce((sum, r) => sum + r.deliveryFee, 0));
  const tips = round2(finishedRows.reduce((sum, r) => sum + (r.tip ?? 0), 0));
  const itemsPurchasedCost = round2(finishedRows.reduce((sum, r) => sum + r.estimatedCost, 0));

  const sugoCommission = round2(deliveryFees * (1 - RIDER_SHARE_RATE));
  const riderPayout = round2(deliveryFees * RIDER_SHARE_RATE + tips);

  const countOf = (statuses: string[]) =>
    statusCounts.filter((s) => statuses.includes(s.status)).reduce((sum, s) => sum + s._count._all, 0);

  return {
    periodLabel: label,
    completedOrders,
    grossSalesPesos: grossSales,
    deliveryFeesPesos: deliveryFees,
    itemCostPesos: itemsPurchasedCost,
    tipsPesos: tips,
    sugoCommissionPesos: sugoCommission,
    riderPayoutPesos: riderPayout,
    averageOrderValuePesos: completedOrders > 0 ? round2(grossSales / completedOrders) : 0,
    currentLiveQueue: {
      ordersWaitingForDispatcher: countOf(["AVAILABLE", "PENDING"]),
      ordersInTransitWithRider: countOf(["ASSIGNED", "IN_TRANSIT"]),
    },
  };
}

// ── Tool 2: Fleet Health ─────────────────────────────────────────────────────
export async function executeFleetHealth() {
  const riders = await userRepository.findAllRiders();
  const riderIds = riders.map((r) => r.id);

  const [availabilityMap, activeErrands, stalledDwells, ongoingStops] = await Promise.all([
    riderBeaconService.availabilityForRiders(riderIds),
    prisma.errand.findMany({
      where: {
        status: { in: ["ASSIGNED", "IN_TRANSIT"] },
      },
      select: {
        id: true,
        referenceNo: true,
        riderId: true,
        status: true,
        category: true,
        assignedAt: true,
        acceptedAt: true,
        itemsPurchasedAt: true,
        rider: {
          select: { firstName: true, lastName: true },
        },
      },
    }),
    prisma.dwellObservation.findMany({
      where: {
        stalled: true,
        errand: { status: "IN_TRANSIT" },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        errandId: true,
        dwellSeconds: true,
        createdAt: true,
        errand: {
          select: {
            referenceNo: true,
            rider: { select: { firstName: true, lastName: true } },
          },
        },
        pinpoint: {
          select: { storeName: true },
        },
      },
    }),
    prisma.errandPinpoint.findMany({
      where: {
        errand: { status: "IN_TRANSIT" },
        arrivedAt: { not: null },
        departedAt: null,
      },
      select: {
        id: true,
        storeName: true,
        arrivedAt: true,
        errand: {
          select: {
            id: true,
            referenceNo: true,
            rider: { select: { firstName: true, lastName: true } },
          },
        },
      },
    }),
  ]);

  const activeRiderIds = new Set(activeErrands.map((e) => e.riderId).filter(Boolean) as number[]);

  const riderSummaries = riders.map((r) => {
    const avail = availabilityMap.get(r.id)?.state ?? "OFFLINE";
    const hasOrder = activeRiderIds.has(r.id);
    return {
      id: r.id,
      name: `${r.firstName} ${r.lastName}`.trim(),
      state: avail,
      hasActiveOrder: hasOrder,
    };
  });

  const onDutyRiders = riderSummaries.filter(
    (r) => r.state === "AVAILABLE" || r.state === "NEEDS_PERMISSIONS"
  );
  const idleOnDutyRiders = onDutyRiders.filter((r) => !r.hasActiveOrder);
  const offlineRiders = riderSummaries.filter(
    (r) => r.state === "OFFLINE" || r.state === "OFF_DUTY" || r.state === "LOGGED_OUT"
  );
  const signalLostRiders = riderSummaries.filter((r) => r.state === "SIGNAL_LOST");

  const nowMs = Date.now();
  const activeDeliveries = activeErrands.map((e) => {
    const startStamp = e.itemsPurchasedAt || e.acceptedAt || e.assignedAt;
    const elapsedMinutes = startStamp ? Math.max(0, Math.round((nowMs - startStamp.getTime()) / 60000)) : 0;
    return {
      referenceNo: e.referenceNo || e.id.slice(0, 8),
      riderName: e.rider ? `${e.rider.firstName} ${e.rider.lastName}`.trim() : "Unassigned",
      status: e.status,
      elapsedMinutes,
      category: e.category,
    };
  });

  const ongoingDelays = (ongoingStops || [])
    .map((p) => {
      const elapsedMinutes = p.arrivedAt ? Math.max(0, Math.round((nowMs - p.arrivedAt.getTime()) / 60000)) : 0;
      return {
        orderRef: p.errand?.referenceNo || p.errand?.id.slice(0, 8) || "Unknown",
        riderName: p.errand?.rider ? `${p.errand.rider.firstName} ${p.errand.rider.lastName}`.trim() : "Unknown",
        storeName: p.storeName || "Store Stop",
        dwellMinutes: elapsedMinutes,
      };
    })
    .filter((d) => d.dwellMinutes >= 20);

  const completedDelays = (stalledDwells || []).map((d) => ({
    orderRef: d.errand?.referenceNo || d.errandId.slice(0, 8),
    riderName: d.errand?.rider ? `${d.errand.rider.firstName} ${d.errand.rider.lastName}`.trim() : "Unknown",
    storeName: d.pinpoint?.storeName || "Store Stop",
    dwellMinutes: Math.round(d.dwellSeconds / 60),
  }));

  const delaysMap = new Map<string, { orderRef: string; riderName: string; storeName: string; dwellMinutes: number }>();
  for (const d of [...ongoingDelays, ...completedDelays]) {
    const key = `${d.orderRef}:${d.storeName}`;
    if (!delaysMap.has(key)) delaysMap.set(key, d);
  }
  const delaysAtStores = [...delaysMap.values()];

  return {
    totalRosterCount: riders.length,
    onDutyCount: onDutyRiders.length,
    idleOnDutyCount: idleOnDutyRiders.length,
    activeErrandsCount: activeErrands.length,
    signalLostCount: signalLostRiders.length,
    offlineCount: offlineRiders.length,
    idleRiders: idleOnDutyRiders.map((r) => r.name),
    activeDeliveries,
    delaysAtStores,
  };
}

// ── Tool 3: Exception Recap ──────────────────────────────────────────────────
export async function executeExceptionRecap(period: string = "week") {
  const { start, end, label } = resolvePeriodDates(period);

  const [exceptionData, cancelledErrands] = await Promise.all([
    exceptionService.findExceptions(start, end),
    prisma.errand.findMany({
      where: {
        status: "CANCELLED",
        createdAt: { gte: start, lt: end },
      },
      select: {
        id: true,
        referenceNo: true,
        createdAt: true,
        declineReasons: {
          select: { reason: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);

  const { summary, exceptions } = exceptionData;

  const topOpenIssues = exceptions
    .filter((e) => !e.resolvedAt)
    .slice(0, 5)
    .map((e) => ({
      referenceNo: e.referenceNo || e.errandId.slice(0, 8),
      kind: e.kind,
      amountAtRiskPesos: e.amountAtRisk,
      riderName: e.riderName || "Unknown",
      detail: scrubPii(e.detail),
    }));

  const cancellationReasonsCount = new Map<string, number>();
  for (const c of cancelledErrands) {
    const rawReason = c.declineReasons?.[0]?.reason || "No explicit reason logged";
    const reason = scrubPii(rawReason);
    cancellationReasonsCount.set(reason, (cancellationReasonsCount.get(reason) || 0) + 1);
  }

  return {
    periodLabel: label,
    openExceptionsCount: summary.openCount,
    resolvedExceptionsCount: summary.resolvedCount,
    totalPesosAtRisk: summary.totalAtRisk,
    byKindBreakdown: summary.byKind,
    totalCancelledOrders: cancelledErrands.length,
    commonCancellationReasons: [...cancellationReasonsCount.entries()].map(([reason, count]) => ({
      reason,
      count,
    })),
    topOpenIssues,
  };
}

// ── Tool 4: Category Performance ─────────────────────────────────────────────
export async function executeCategoryPerformance(period: string = "month") {
  const normalized = (period || "month").toUpperCase();
  const validPeriod: ReportPeriod =
    normalized === "DAILY" || normalized === "TODAY"
      ? "DAILY"
      : normalized === "WEEKLY" || normalized === "WEEK"
      ? "WEEKLY"
      : normalized === "YEARLY" || normalized === "YEAR"
      ? "YEARLY"
      : "MONTHLY";

  const salesReport = await reportService.getSalesReport({
    period: validPeriod,
    date: new Date(),
  });

  const categories = (salesReport.byCategory || []).map((c) => ({
    category: c.category,
    revenuePesos: c.revenue,
    itemCostPesos: c.itemCost,
    deliveryFeePesos: c.deliveryFee,
    orderCount: c.orderCount,
    shareOfTotalSalesPercent:
      salesReport.totalRevenue > 0 ? round2((c.revenue / salesReport.totalRevenue) * 100) : 0,
  }));

  return {
    coverageLabel: salesReport.coverageLabel,
    totalRevenuePesos: salesReport.totalRevenue,
    totalOrders: salesReport.totalOrders,
    topCategories: categories.slice(0, 6),
  };
}

// ── Gemini Tool Declarations ─────────────────────────────────────────────────
const GEMINI_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "getSalesPulse",
        description:
          "Query completed errands, gross merchandise value (sales), delivery fees, tips, commissions, and order counts for a period.",
        parameters: {
          type: "OBJECT",
          properties: {
            period: {
              type: "STRING",
              description: "Time period: 'today', 'yesterday', 'week', 'month', or 'year'. Defaults to 'today'.",
            },
          },
        },
      },
      {
        name: "getFleetHealth",
        description:
          "Query live rider fleet status, on-duty vs idle riders, active deliveries in progress, and riders delayed at store stops (>20 mins).",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "getExceptionRecap",
        description:
          "Query operational exceptions, money at risk, cash reconciliation variances, unverified purchases, and cancelled order root causes.",
        parameters: {
          type: "OBJECT",
          properties: {
            period: {
              type: "STRING",
              description: "Time period: 'today', 'week', or 'month'. Defaults to 'week'.",
            },
          },
        },
      },
      {
        name: "getCategoryPerformance",
        description:
          "Query merchant category rankings, sales breakdown by store type, item volumes, and order counts.",
        parameters: {
          type: "OBJECT",
          properties: {
            period: {
              type: "STRING",
              description: "Time period: 'daily', 'weekly', or 'monthly'. Defaults to 'monthly'.",
            },
          },
        },
      },
    ],
  },
];

// Each tool reads data a restricted Admin may not be allowed to see. It is offered
// only when the account holds one of these keys, and runTool checks again, so
// Kuya Sugo cannot be used to read around an access group. Any one key is enough:
// the sales and category figures are on the Dashboard as well as in Reports.
const TOOL_PERMISSIONS: Record<string, readonly string[]> = {
  getSalesPulse: ["dashboard.view", "reports.view"],
  getFleetHealth: ["tracking.view"],
  getExceptionRecap: ["reports.view"],
  getCategoryPerformance: ["dashboard.view", "reports.view"],
};

type CopilotCaller = { id: number; role: string };

/** No caller (tests, internal use) means every tool, as before groups existed. */
async function allowedToolNames(caller?: CopilotCaller): Promise<Set<string>> {
  const names = Object.keys(TOOL_PERMISSIONS);
  if (!caller) return new Set(names);
  const allowed = new Set<string>();
  for (const name of names) {
    for (const key of TOOL_PERMISSIONS[name]) {
      if (await callerHasPermission(caller, key)) {
        allowed.add(name);
        break;
      }
    }
  }
  return allowed;
}

function toolsFor(allowed: Set<string>) {
  const functionDeclarations = GEMINI_TOOLS[0].functionDeclarations.filter((d) => allowed.has(d.name));
  return functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined;
}

const OUTSIDE_ACCESS_REPLY =
  "That is outside what your access group includes, so I cannot answer it. The Main Owner can change your access in Settings.";

const KUYA_SUGO_SYSTEM_INSTRUCTION = `You are Kuya Sugo, the trusted, knowledgeable, and friendly executive AI co-pilot for the business owner of SUGO Errand & Logistics in Tacurong City, Sultan Kudarat, Philippines.

Your role is to assist the business owner with concise, operational, and financial intelligence regarding daily sales, rider fleet movements, store bottlenecks, cancellations, and merchant categories.

Key Operating Invariants:
1. Grounding & Zero Hallucination: NEVER guess or invent numbers. Always invoke the available tools (getSalesPulse, getFleetHealth, getExceptionRecap, getCategoryPerformance) to retrieve real-time MariaDB database records before answering.
2. Tone & Persona: Friendly, polite, respectful, and sharp ("Kuya Sugo"). You can use warm everyday Filipino/Ilonggo greetings (e.g. "Magandang araw, Boss!", "Kumusta, Boss!"), but keep the core analysis crisp, professional, and easy to read.
3. Layman's Terms First: Present numbers simply and intuitively (e.g., explain what gross sales vs rider payouts mean without confusing database jargon).
4. Absolute Ban on Em Dashes: NEVER use em dashes. Use standard hyphens (-), colons (:), or parentheses instead.
5. PII Privacy Protection: Never reveal customer passwords, customer phone numbers, or private full home coordinates. Focus strictly on order reference numbers (e.g. 261027-ABC12-0001), store names, rider first names, and financial aggregates.
6. Currency & Metrics: Format Philippine Pesos as ₱X,XXX.XX or PHP X,XXX.XX.
`;

/**
 * Executes a deterministic tool call and returns the JSON result.
 */
async function runTool(name: string, args: Record<string, any>, allowed: Set<string>): Promise<any> {
  if (!allowed.has(name)) {
    return { error: "This account's access group does not include the data this tool returns. Tell the user so plainly; do not estimate it." };
  }
  switch (name) {
    case "getSalesPulse":
      return executeSalesPulse(args.period);
    case "getFleetHealth":
      return executeFleetHealth();
    case "getExceptionRecap":
      return executeExceptionRecap(args.period);
    case "getCategoryPerformance":
      return executeCategoryPerformance(args.period);
    default:
      return { error: `Unknown tool function: ${name}` };
  }
}

/**
 * Builds relevant navigation action badges based on tools used and user queries.
 */
function buildActionLinks(toolsUsed: string[], queryText: string): CopilotActionLink[] {
  const links: CopilotActionLink[] = [];
  const text = queryText.toLowerCase();

  if (toolsUsed.includes("getSalesPulse") || text.includes("sales") || text.includes("revenue")) {
    links.push({
      label: "View Financial Reports",
      action: "open_report",
      target: "sales",
      description: "Inspect detailed sales and commission breakdown",
    });
  }

  if (toolsUsed.includes("getFleetHealth") || text.includes("fleet") || text.includes("rider") || text.includes("delay")) {
    links.push({
      label: "Open Fleet Tracking Map",
      action: "open_module",
      target: "tracking",
      description: "Track live rider locations across Tacurong",
    });
  }

  if (toolsUsed.includes("getExceptionRecap") || text.includes("exception") || text.includes("cancel") || text.includes("variance")) {
    links.push({
      label: "View Exception Queue",
      action: "open_report",
      target: "exceptions",
      description: "Review unverified receipts and cash variances",
    });
  }

  if (toolsUsed.includes("getCategoryPerformance") || text.includes("category") || text.includes("store")) {
    links.push({
      label: "Manage Merchant Categories",
      action: "open_module",
      target: "merchants",
      description: "Configure store categories and verified directory",
    });
  }

  // Deduplicate by target
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.action}:${link.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Graceful fallback when the external Gemini API is unreachable or rate limited:
 * Directly executes relevant database tools and formats a clear, grounded response.
 */
async function handleDeterministicFallback(
  latestUserText: string,
  allowed: Set<string>
): Promise<CopilotChatResponse> {
  const lower = latestUserText.toLowerCase();
  const toolsUsed: string[] = [];

  let reply = "Magandang araw, Boss! Kuya Sugo here.\n\n";

  if (lower.includes("sales") || lower.includes("revenue") || lower.includes("pulse") || lower.includes("benta")) {
    if (!allowed.has("getSalesPulse")) return { reply: OUTSIDE_ACCESS_REPLY, toolsUsed: [], actionLinks: [] };
    const period = lower.includes("yesterday")
      ? "yesterday"
      : lower.includes("week")
      ? "week"
      : lower.includes("month")
      ? "month"
      : "today";
    toolsUsed.push("getSalesPulse");
    const pulse = await executeSalesPulse(period);
    reply += `Here is our **Sales Pulse** for ${pulse.periodLabel}:\n\n` +
      `* **Total Sales (GMV)**: ₱${pulse.grossSalesPesos.toLocaleString("en-PH", { minimumFractionDigits: 2 })}\n` +
      `* **Completed Orders**: ${pulse.completedOrders}\n` +
      `* **Delivery Fees**: ₱${pulse.deliveryFeesPesos.toLocaleString("en-PH", { minimumFractionDigits: 2 })}\n` +
      `* **Sugo Commission Share**: ₱${pulse.sugoCommissionPesos.toLocaleString("en-PH", { minimumFractionDigits: 2 })}\n` +
      `* **Rider Earnings**: ₱${pulse.riderPayoutPesos.toLocaleString("en-PH", { minimumFractionDigits: 2 })}\n` +
      `* **Average Order Value**: ₱${pulse.averageOrderValuePesos.toLocaleString("en-PH", { minimumFractionDigits: 2 })}\n\n` +
      `Currently, there are **${pulse.currentLiveQueue.ordersInTransitWithRider} active orders in transit** and **${pulse.currentLiveQueue.ordersWaitingForDispatcher} waiting in the queue**.`;
  } else if (lower.includes("fleet") || lower.includes("rider") || lower.includes("delay") || lower.includes("stalled")) {
    if (!allowed.has("getFleetHealth")) return { reply: OUTSIDE_ACCESS_REPLY, toolsUsed: [], actionLinks: [] };
    toolsUsed.push("getFleetHealth");
    const fleet = await executeFleetHealth();
    reply += `Here is our **Fleet Health Status**:\n\n` +
      `* **On-Duty Riders**: ${fleet.onDutyCount} of ${fleet.totalRosterCount} registered\n` +
      `* **Active Deliveries**: ${fleet.activeErrandsCount}\n` +
      `* **Idle Riders Available**: ${fleet.idleOnDutyCount} ${fleet.idleRiders.length > 0 ? `(${fleet.idleRiders.join(", ")})` : ""}\n` +
      `* **Signal Lost**: ${fleet.signalLostCount}\n\n`;

    if (fleet.delaysAtStores.length > 0) {
      reply += `⚠️ **Store Delays Detected (>20 mins)**:\n`;
      for (const d of fleet.delaysAtStores) {
        reply += `* ${d.riderName} at ${d.storeName} (${d.dwellMinutes} mins, Order: ${d.orderRef})\n`;
      }
    } else {
      reply += `✓ No critical store bottlenecks or stalled stops detected right now.`;
    }
  } else if (lower.includes("cancel") || lower.includes("exception") || lower.includes("risk") || lower.includes("variance")) {
    if (!allowed.has("getExceptionRecap")) return { reply: OUTSIDE_ACCESS_REPLY, toolsUsed: [], actionLinks: [] };
    toolsUsed.push("getExceptionRecap");
    const recap = await executeExceptionRecap("week");
    reply += `Here is our **Exception & Cancellation Recap** for ${recap.periodLabel}:\n\n` +
      `* **Unresolved Exceptions**: ${recap.openExceptionsCount}\n` +
      `* **Total Money at Risk**: ₱${recap.totalPesosAtRisk.toLocaleString("en-PH", { minimumFractionDigits: 2 })}\n` +
      `* **Cancelled Orders**: ${recap.totalCancelledOrders}\n\n`;

    if (recap.topOpenIssues.length > 0) {
      reply += `**Open Issues Requiring Attention**:\n`;
      for (const issue of recap.topOpenIssues) {
        reply += `* Order ${issue.referenceNo} (${issue.kind}): ₱${issue.amountAtRiskPesos} at risk. Rider: ${issue.riderName}. Detail: ${issue.detail}\n`;
      }
    } else {
      reply += `✓ All recent exceptions have been reviewed and cleared!`;
    }
  } else if (lower.includes("category") || lower.includes("store type") || lower.includes("product") || lower.includes("tindahan")) {
    if (!allowed.has("getCategoryPerformance")) return { reply: OUTSIDE_ACCESS_REPLY, toolsUsed: [], actionLinks: [] };
    toolsUsed.push("getCategoryPerformance");
    const cats = await executeCategoryPerformance("month");
    reply += `Here are our **Top Merchant Categories** for ${cats.coverageLabel}:\n\n` +
      `* **Total Category Revenue**: ₱${cats.totalRevenuePesos.toLocaleString("en-PH", { minimumFractionDigits: 2 })}\n` +
      `* **Total Orders**: ${cats.totalOrders}\n\n`;

    for (const c of cats.topCategories) {
      reply += `* **${c.category}**: ₱${c.revenuePesos.toLocaleString("en-PH", { minimumFractionDigits: 2 })} (${c.orderCount} orders, ${c.shareOfTotalSalesPercent}% of sales)\n`;
    }
  } else {
    // General friendly guidance
    reply += `I am your operational assistant for SUGO Tacurong.\n\n` +
      `You can ask me about:\n` +
      `* **Today's Sales Pulse**: Revenue, delivery fees, and order counts\n` +
      `* **Fleet Health & Delays**: Active riders, idle availability, and store queues\n` +
      `* **Cancellation Recap**: Recent exceptions and money at risk\n` +
      `* **Top Categories**: High-demand stores and pabili items\n\n` +
      `What would you like to inspect first?`;
  }

  const actionLinks = buildActionLinks(toolsUsed, latestUserText);
  return { reply, toolsUsed, actionLinks };
}

/**
 * Main chat handler for Owner AI Copilot ("Kuya Sugo").
 */
export async function chatWithOwnerCopilot(
  messages: CopilotChatMessage[],
  portalContext?: { activeModule?: string; activeTab?: string },
  caller?: CopilotCaller
): Promise<CopilotChatResponse> {
  if (!getKuyaSugoEnabled()) {
    return {
      reply: "Pasensya na, Boss. Kuya Sugo is currently turned off by the system administrator.",
      toolsUsed: [],
      actionLinks: [],
    };
  }

  const allowed = await allowedToolNames(caller);
  const apiKey = resolveGeminiApiKey();
  const latestUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const latestText = latestUserMessage?.content || "What is our current status?";

  if (!apiKey) {
    logger.warn("[OwnerCopilot] No Gemini API key found. Falling back to deterministic DB answers.");
    return handleDeterministicFallback(latestText, allowed);
  }

  // Prepare Gemini REST conversation payload
  // 1. Take at most recent 20 messages to keep context window focused
  const recentMessages = messages.slice(-20);

  // 2. Format history messages into Gemini contents format
  const rawContents: Array<{ role: string; parts: any[] }> = [];
  for (const m of recentMessages) {
    const role = m.role === "assistant" || m.role === "model" ? "model" : "user";
    rawContents.push({
      role,
      parts: [{ text: m.content }],
    });
  }

  // 3. Ensure the conversation starts with a user message (strip leading model greetings)
  while (rawContents.length > 0 && rawContents[0].role !== "user") {
    rawContents.shift();
  }

  if (rawContents.length === 0) {
    rawContents.push({
      role: "user",
      parts: [{ text: latestText }],
    });
  }

  // 4. Merge consecutive turns with the same role so roles strictly alternate (user -> model -> user -> model)
  const contents: Array<{ role: string; parts: any[] }> = [];
  for (const item of rawContents) {
    const prev = contents[contents.length - 1];
    if (prev && prev.role === item.role) {
      prev.parts.push(...item.parts);
    } else {
      contents.push(item);
    }
  }

  // Append contextual hint if portalContext exists
  if (portalContext?.activeModule) {
    const lastContent = contents[contents.length - 1];
    if (lastContent && lastContent.role === "user") {
      // Provide light background context for the model without leaking to UI
      const contextAnnotation = ` [Current Portal Tab: ${portalContext.activeModule}${portalContext.activeTab ? ` > ${portalContext.activeTab}` : ""}]`;
      if (!lastContent.parts[0].text.includes("[Current Portal Tab:")) {
        lastContent.parts[0].text += contextAnnotation;
      }
    }
  }

  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";
  const toolsUsedSet = new Set<string>();

  try {
    let iterations = 0;
    const maxIterations = 3;

    while (iterations < maxIterations) {
      iterations += 1;

      const requestBody: any = {
        systemInstruction: {
          parts: [{ text: KUYA_SUGO_SYSTEM_INSTRUCTION }],
        },
        contents,
        tools: toolsFor(allowed),
        generationConfig: {
          temperature: 0.1,
        },
      };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`[OwnerCopilot] Gemini API error HTTP ${response.status}: ${errorText}`);
        return handleDeterministicFallback(latestText, allowed);
      }

      const result = await response.json();
      const candidate = result.candidates?.[0];
      if (!candidate?.content) {
        return handleDeterministicFallback(latestText, allowed);
      }

      const modelParts = candidate.content.parts || [];
      const functionCalls = modelParts.filter((p: any) => p.functionCall);

      if (functionCalls.length === 0) {
        // Direct answer with grounded text
        const replyText = modelParts
          .filter((p: any) => p.text && !p.thought)
          .map((p: any) => p.text)
          .join("\n")
          .trim();

        // Enforce anti-AI-slop rule: clean em dashes
        const sanitizedReply = replyText.replace(/—/g, "-").replace(/–/g, "-");
        const actionLinks = buildActionLinks([...toolsUsedSet], latestText);

        return {
          reply: sanitizedReply || "Kumusta, Boss! Let me know which operational figures you'd like to inspect.",
          toolsUsed: [...toolsUsedSet],
          actionLinks,
        };
      }

      // Append model content containing functionCalls AND thoughtSignature
      contents.push(candidate.content);

      // Execute function calls and group all function responses into a SINGLE user turn
      const functionResponseParts: any[] = [];
      for (const fcPart of functionCalls) {
        const fnName = fcPart.functionCall.name;
        const fnArgs = fcPart.functionCall.args || {};
        toolsUsedSet.add(fnName);

        const toolResult = await runTool(fnName, fnArgs, allowed);

        functionResponseParts.push({
          functionResponse: {
            name: fnName,
            response: toolResult,
          },
        });
      }

      // Append function response turn with role: "user"
      contents.push({
        role: "user",
        parts: functionResponseParts,
      });
    }

    // If loop reached max iterations, fallback cleanly
    return handleDeterministicFallback(latestText, allowed);
  } catch (err) {
    logger.error("[OwnerCopilot] Error communicating with Gemini API:", err);
    return handleDeterministicFallback(latestText, allowed);
  }
}
