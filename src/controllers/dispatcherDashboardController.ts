import { Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { prisma } from "../lib/prisma.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import * as exceptionService from "../services/exceptionService.js";

export interface DashboardAttentionItem {
  id: string;
  errandId: string;
  kind: "UNCLAIMED_STALE" | "STALLED_STOP" | "OVERAGE_DISPUTE" | "CANCELLED_AFTER_PURCHASE";
  title: string;
  detail: string;
  severity: "critical" | "warning";
  action: "claim" | "chat" | "exceptions";
  createdAt: string;
}

export interface DispatcherDashboardSummary {
  unclaimedCount: number;
  urgentUnclaimedCount: number;
  activeInMotionCount: number;
  deliveredTodayCount: number;
  helpDeskCount: number;
  pipeline: {
    claimed: number;
    toStore: number;
    bought: number;
    onTheWay: number;
    delivered: number;
  };
  attentionItems: DashboardAttentionItem[];
  topMerchantsToday: Array<{ name: string; count: number }>;
  todayDeclines: Array<{ reason: string; count: number }>;
  myShiftStats: {
    myHandledToday: number;
    myAvgClaimLatencySeconds: number | null;
  };
}

export const getDispatcherDashboardSummary = asyncHandler<AuthenticatedRequest>(
  async (req, res: Response) => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const threeMinutesAgo = new Date(now.getTime() - 3 * 60 * 1000);
    const currentUserId = req.user?.id;

    const [
      unclaimedCount,
      urgentUnclaimedCount,
      activeErrands,
      deliveredTodayCount,
      staleUnclaimedErrands,
      stalledDwells,
      disputedErrands,
      todayPinpoints,
      todayDeclinesList,
      myTodayLogs,
      openExceptions,
    ] = await Promise.all([
      // 1. Unclaimed count
      prisma.errand.count({
        where: { status: "AVAILABLE" },
      }),

      // 2. Urgent unclaimed (> 3m)
      prisma.errand.count({
        where: {
          status: "AVAILABLE",
          createdAt: { lt: threeMinutesAgo },
        },
      }),

      // 3. Active in-progress errands
      prisma.errand.findMany({
        where: {
          status: { in: ["PENDING", "ASSIGNED", "IN_TRANSIT"] },
        },
        select: {
          id: true,
          status: true,
          itemsPurchasedAt: true,
          halfPaymentRequestedAt: true,
          proximityAlertSentAt: true,
        },
      }),

      // 4. Delivered today
      prisma.errand.count({
        where: {
          status: { in: ["DELIVERED", "COMPLETED"] },
          OR: [
            { deliveredAt: { gte: startOfDay } },
            { deliveredAt: null, updatedAt: { gte: startOfDay } },
          ],
        },
      }),

      // 5. Stale unclaimed list
      prisma.errand.findMany({
        where: {
          status: "AVAILABLE",
          createdAt: { lt: threeMinutesAgo },
        },
        orderBy: { createdAt: "asc" },
        take: 5,
        select: {
          id: true,
          category: true,
          pickupAddress: true,
          deliveryAddress: true,
          createdAt: true,
          pinpoints: {
            take: 1,
            select: { storeName: true },
          },
        },
      }),

      // 6. Stalled dwells in transit
      prisma.dwellObservation.findMany({
        where: {
          stalled: true,
          errand: { status: "IN_TRANSIT" },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          errandId: true,
          dwellSeconds: true,
          createdAt: true,
          pinpoint: {
            select: { storeName: true },
          },
        },
      }),

      // 7. Disputed or cancelled after purchase
      prisma.errand.findMany({
        where: {
          OR: [
            {
              overageEscalatedAt: { not: null },
              overageResolvedAt: null,
            },
            {
              status: "CANCELLED",
              itemsPurchasedAt: { not: null },
              updatedAt: { gte: startOfDay },
            },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: {
          id: true,
          status: true,
          overageEscalatedAt: true,
          updatedAt: true,
          pinpoints: {
            take: 1,
            select: { storeName: true },
          },
        },
      }),

      // 8. Top store stops today
      prisma.errandPinpoint.findMany({
        where: {
          errand: { createdAt: { gte: startOfDay } },
        },
        select: { storeName: true },
      }),

      // 9. Declines recorded today
      prisma.errandDeclineReason.findMany({
        where: {
          createdAt: { gte: startOfDay },
        },
        select: { reason: true },
      }),

      // 10. My dispatch logs today
      currentUserId
        ? prisma.dispatchLog.findMany({
            where: {
              dispatcherId: currentUserId,
              dispatchedAt: { gte: startOfDay },
            },
            select: {
              dispatchedAt: true,
              verifiedAt: true,
              errand: { select: { createdAt: true } },
            },
          })
        : Promise.resolve([]),

      // 11. Open exceptions for help desk
      exceptionService
        .findExceptions(new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000), now, {
          openOnly: true,
        })
        .catch(() => []),
    ]);

    // Map pipeline counts
    const pipeline = {
      claimed: 0,
      toStore: 0,
      bought: 0,
      onTheWay: 0,
      delivered: deliveredTodayCount,
    };

    for (const e of activeErrands) {
      if (e.status === "PENDING") {
        pipeline.claimed++;
      } else if (e.status === "ASSIGNED" || (e.status === "IN_TRANSIT" && !e.itemsPurchasedAt)) {
        pipeline.toStore++;
      } else if (
        e.status === "IN_TRANSIT" &&
        e.itemsPurchasedAt &&
        !e.halfPaymentRequestedAt &&
        !e.proximityAlertSentAt
      ) {
        pipeline.bought++;
      } else if (e.status === "IN_TRANSIT") {
        pipeline.onTheWay++;
      }
    }

    // Assemble attention items (deduplicated by errandId)
    const attentionItems: DashboardAttentionItem[] = [];
    const seenErrandIds = new Set<string>();

    for (const e of staleUnclaimedErrands) {
      if (seenErrandIds.has(e.id)) continue;
      seenErrandIds.add(e.id);
      const elapsedMins = Math.max(
        1,
        Math.round((now.getTime() - new Date(e.createdAt).getTime()) / 60000)
      );
      const storeLabel = e.pinpoints?.[0]?.storeName || e.category || "General Errand";
      attentionItems.push({
        id: `unclaimed-${e.id}`,
        errandId: e.id,
        kind: "UNCLAIMED_STALE",
        title: `Unclaimed for ${elapsedMins}m (${storeLabel})`,
        detail: `Customer waiting in ${e.deliveryAddress || "Tacurong City"}`,
        severity: elapsedMins >= 5 ? "critical" : "warning",
        action: "claim",
        createdAt: e.createdAt.toISOString(),
      });
    }

    for (const d of stalledDwells) {
      if (seenErrandIds.has(d.errandId)) continue;
      seenErrandIds.add(d.errandId);
      const mins = Math.round(d.dwellSeconds / 60);
      attentionItems.push({
        id: `stalled-${d.id}`,
        errandId: d.errandId,
        kind: "STALLED_STOP",
        title: `Stalled Stop at ${d.pinpoint?.storeName || "Store"} (${mins}m)`,
        detail: "Rider dwell time far exceeds typical store duration",
        severity: "warning",
        action: "chat",
        createdAt: d.createdAt.toISOString(),
      });
    }

    for (const disp of disputedErrands) {
      if (seenErrandIds.has(disp.id)) continue;
      seenErrandIds.add(disp.id);
      const isCancelled = disp.status === "CANCELLED";
      attentionItems.push({
        id: `dispute-${disp.id}`,
        errandId: disp.id,
        kind: isCancelled ? "CANCELLED_AFTER_PURCHASE" : "OVERAGE_DISPUTE",
        title: isCancelled
          ? "Cancelled After Purchase (Goods bought)"
          : "Receipt Overage Escalation",
        detail: isCancelled
          ? "Goods were purchased before cancellation; needs inventory / refund resolution"
          : "Receipt exceeded agreed budget; needs dispatcher review",
        severity: "critical",
        action: "exceptions",
        createdAt: (disp.overageEscalatedAt || disp.updatedAt).toISOString(),
      });
    }

    // Calculate top merchants today
    const merchantCounts = new Map<string, number>();
    for (const p of todayPinpoints) {
      const name = (p.storeName || "").trim();
      if (!name) continue;
      merchantCounts.set(name, (merchantCounts.get(name) || 0) + 1);
    }
    const topMerchantsToday = Array.from(merchantCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Calculate today's decline reasons
    const declineCounts = new Map<string, number>();
    for (const d of todayDeclinesList) {
      const reason = (d.reason || "Declined").trim();
      declineCounts.set(reason, (declineCounts.get(reason) || 0) + 1);
    }
    const todayDeclines = Array.from(declineCounts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Calculate personal shift metrics: verified orders and claim latency
    const myHandledToday = myTodayLogs.filter((log) => log.verifiedAt !== null).length;
    let totalLatencySeconds = 0;
    let latencyCount = 0;
    for (const log of myTodayLogs) {
      if (log.errand?.createdAt && log.dispatchedAt) {
        const diffSecs = (log.dispatchedAt.getTime() - log.errand.createdAt.getTime()) / 1000;
        if (diffSecs >= 0) {
          totalLatencySeconds += diffSecs;
          latencyCount++;
        }
      }
    }
    const myAvgClaimLatencySeconds =
      latencyCount > 0 ? Math.round(totalLatencySeconds / latencyCount) : null;

    const summary: DispatcherDashboardSummary = {
      unclaimedCount,
      urgentUnclaimedCount,
      activeInMotionCount: activeErrands.filter((e) => e.status !== "PENDING").length,
      deliveredTodayCount,
      helpDeskCount: Array.isArray(openExceptions) ? openExceptions.length : 0,
      pipeline,
      attentionItems,
      topMerchantsToday,
      todayDeclines,
      myShiftStats: {
        myHandledToday,
        myAvgClaimLatencySeconds,
      },
    };

    res.json(summary);
  }
);
