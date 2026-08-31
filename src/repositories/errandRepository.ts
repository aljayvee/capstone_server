import { prisma } from "../lib/prisma.js";
import type { Prisma, ErrandStatus } from "@prisma/client";

// Shared Prisma include shape for errand relations. firstName/lastName are selected
// (not a stored `name` column — see 3NF note on the User model) and combined into a
// display-only `name` field by errandService.attachErrandNames() before the response.
// `customer` is nested under CustomerInformation (split from CustomerAccount) —
// errandService.attachErrandNames() flattens it back to firstName/lastName/phone/name
// so the HTTP response contract the web dashboard consumes is unchanged.
export const ERRAND_INCLUDE = {
  customer: { select: { information: { select: { firstName: true, lastName: true, phone: true } } } },
  rider: { select: { firstName: true, lastName: true, phone: true } },
  pabiliDetails: true,
  pabiliItemRequests: true,
  pinpoints: {
    orderBy: { sequence: "asc" as const },
    // The geofence radius and the category name. attachErrandNames flattens both
    // onto each pinpoint so a client never has to know stops have categories at
    // all — it just gets a radius to draw and a label to print.
    include: { category: { select: { geofenceRadiusMeters: true, name: true } } },
  },
  // The recorded payout, where the errand has finished. attachErrandNames
  // prefers it over recomputing so a rider is never shown a different figure
  // from the one they were actually paid.
  commission: true,
  dispatchLogs: {
    include: { dispatcher: { select: { firstName: true, lastName: true } } },
    orderBy: { dispatchedAt: "desc" as const },
    take: 1,
  },
} as const;

export const errandRepository = {
  findMany() {
    return prisma.errand.findMany({ include: ERRAND_INCLUDE, orderBy: { createdAt: "desc" } });
  },

  // Dispatcher-scoped queue: every unclaimed (AVAILABLE) errand, every errand
  // cancelled before any dispatcher claimed it (same "unowned, visible to all"
  // reasoning as AVAILABLE — otherwise it has no DispatchLog row and would be
  // silently invisible to every dispatcher, including in Recent Chats), plus
  // every errand this dispatcher has personally claimed (any status) — hides
  // other dispatchers' claims while keeping this dispatcher's own in-progress/
  // completed work visible.
  findManyForDispatcher(dispatcherId: number) {
    return prisma.errand.findMany({
      where: {
        OR: [{ status: "AVAILABLE" }, { status: "CANCELLED" }, { dispatchLogs: { some: { dispatcherId } } }],
      },
      include: ERRAND_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
  },

  findById(id: string) {
    return prisma.errand.findUnique({ where: { id }, include: ERRAND_INCLUDE });
  },

  findByIdWithPabiliDetails(id: string) {
    return prisma.errand.findUnique({ where: { id }, include: { pabiliDetails: true } });
  },

  findByIdBasic(id: string) {
    return prisma.errand.findUnique({ where: { id } });
  },

  findStatusAndRiderById(id: string) {
    return prisma.errand.findUnique({ where: { id }, select: { status: true, riderId: true } });
  },

  findByIdWithDispatchLogs(id: string) {
    return prisma.errand.findUnique({ where: { id }, include: { dispatchLogs: true } });
  },

  findByCustomerId(customerId: number) {
    return prisma.errand.findMany({
      where: { customerId },
      include: ERRAND_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
  },

  // Every option is optional and every default reproduces the original
  // unbounded query, so existing callers are untouched. They exist because this
  // returns the rider's ENTIRE history with the full ERRAND_INCLUDE join on it —
  // fine for the handful of errands a rider is carrying, less fine after a year.
  findByRiderId(
    riderId: number,
    opts: { status?: ErrandStatus[]; take?: number; skip?: number } = {}
  ) {
    return prisma.errand.findMany({
      where: {
        riderId,
        ...(opts.status?.length ? { status: { in: opts.status } } : {}),
      },
      include: ERRAND_INCLUDE,
      orderBy: { createdAt: "desc" },
      // Passed straight through: Prisma reads `undefined` as "no limit", which is
      // the original behaviour. Spreading these conditionally instead turns the
      // argument object into a union and silently drops the include payload from
      // the inferred return type, which is what broke every caller downstream.
      take: opts.take,
      skip: opts.skip,
    });
  },

  /**
   * Claims an errand for a rider, enforcing the concurrency cap in the SAME
   * transaction that performs the write.
   *
   * assignRider used to read the candidates' active-errand counts and then write
   * the assignment as two separate statements. Two dispatchers auto-assigning in
   * the same second both read `2 < 3`, both passed, and both wrote — leaving one
   * rider holding four errands, with nothing in the schema to catch it because
   * the cap lived only in application memory.
   *
   * Serializable because the count and the write have to see one snapshot: a
   * REPEATABLE READ count can still be stale by the time the update lands. The
   * isolation cost is affordable here and nowhere else — assignment runs a few
   * times a minute, so a retry is one extra round trip rather than a bottleneck.
   *
   * The status guard closes the other half of the race, where two dispatchers
   * assign the SAME errand: only PENDING may become ASSIGNED (errandStateMachine),
   * so the second update matches no rows instead of overwriting the first.
   */
  claimForRider(
    errandId: string,
    riderId: number,
    maxActive: number
  ): Promise<"CLAIMED" | "AT_CAPACITY" | "ERRAND_MOVED"> {
    return prisma.$transaction(
      async (tx) => {
        const active = await tx.errand.count({
          where: { riderId, status: { in: ["ASSIGNED", "IN_TRANSIT"] } },
        });
        if (active >= maxActive) return "AT_CAPACITY" as const;

        const { count } = await tx.errand.updateMany({
          where: { id: errandId, status: "PENDING" },
          data: { riderId, status: "ASSIGNED", assignedAt: new Date() },
        });
        return count === 1 ? ("CLAIMED" as const) : ("ERRAND_MOVED" as const);
      },
      { isolationLevel: "Serializable" }
    );
  },

  // How many errands this ONE rider is already carrying, counting only those they
  // have actually accepted. An ASSIGNED errand is an offer they have not answered
  // yet, so it is deliberately not counted — otherwise a dispatcher could park
  // three offers on a rider and lock them out of accepting any of them.
  countInTransitForRider(riderId: number) {
    return prisma.errand.count({ where: { riderId, status: "IN_TRANSIT" } });
  },

  // Counts in-progress (not yet DELIVERED/COMPLETED/CANCELLED) errands per rider in one
  // query. Deliberately excludes rather than includes specific "active" status names —
  // sidesteps the documented IN_TRANSIT-vs-DB-enum mismatch (see errandStateMachine.ts)
  // entirely, since it only needs to know what's NOT finished yet.
  countActiveByRider() {
    return prisma.errand.groupBy({
      by: ["riderId"],
      where: { riderId: { not: null }, status: { notIn: ["DELIVERED", "COMPLETED", "CANCELLED"] } },
      _count: { _all: true },
    });
  },

  // All-time snapshot count per status — backs the Dashboard's live operational
  // tiles (pending/active/completed). Deliberately unscoped by date: "4 pending
  // errands" means right now, not "created today".
  countByStatus() {
    return prisma.errand.groupBy({ by: ["status"], _count: { _all: true } });
  },

  // Revenue/volume totals for one resolved period window (see reportPeriodStrategy.ts).
  // Scoped strictly to realized/completed transactions (DELIVERED and COMPLETED)
  // so pending, in-flight, or cancelled orders are not counted as realized revenue.
  aggregateBetween(start: Date, end: Date) {
    return prisma.errand.aggregate({
      where: {
        createdAt: { gte: start, lt: end },
        status: { in: ["DELIVERED", "COMPLETED"] },
      },
      _sum: { totalCost: true, deliveryFee: true, estimatedCost: true, tip: true },
      _count: { _all: true },
    });
  },

  // Category breakdown for the Sales report. Groups on whatever `category` values
  // exist strictly for realized/completed errands.
  groupByCategoryBetween(start: Date, end: Date) {
    return prisma.errand.groupBy({
      by: ["category"],
      where: {
        createdAt: { gte: start, lt: end },
        status: { in: ["DELIVERED", "COMPLETED"] },
      },
      _sum: { totalCost: true },
      _count: { _all: true },
    });
  },

  // Feeds the Settlement report's grossRevenue figure — includes each completed errand's
  // real reconciled cash (SettlementRecord.collectedAmount) where one exists.
  /**
   * Everything an exception could be derived from, for one range.
   *
   * One query rather than six: the alternative is a round trip per signal and
   * then stitching them by errand id in memory, which is slower and gets the
   * rider's name wrong on whichever query forgot to include it.
   */
  findWithReconciliationEvidenceBetween(start: Date, end: Date) {
    return prisma.errand.findMany({
      where: { createdAt: { gte: start, lt: end } },
      select: {
        id: true,
        createdAt: true,
        totalCost: true,
        estimatedCost: true,
        status: true,
        riderId: true,
        rider: { select: { firstName: true, lastName: true } },
        settlement: {
          select: { collectedAmount: true, expectedAmount: true, variance: true, status: true, shortReason: true, settledAt: true },
        },
        pinpoints: {
          select: {
            id: true,
            storeName: true,
            mismatchDetectedAt: true,
            observedPlace: { select: { name: true } },
            items: { select: { id: true } },
          },
        },
        proofImages: {
          select: {
            id: true,
            kind: true,
            pinpointId: true,
            verified: true,
            declaredTotal: true,
            capturedAt: true,
            extraction: { select: { extractedTotal: true, confirmedTotal: true } },
          },
        },
        dwellObservations: { select: { pinpointId: true, dwellSeconds: true, stalled: true, departedAt: true } },
        exceptionReviews: {
          select: {
            kind: true,
            reason: true,
            amountAtRisk: true,
            resolvedAt: true,
            reviewer: { select: { firstName: true, lastName: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  },

  findWithSettlementBetween(start: Date, end: Date) {
    return prisma.errand.findMany({
      where: {
        createdAt: { gte: start, lt: end },
        status: { in: ["DELIVERED", "COMPLETED"] },
      },
      select: {
        totalCost: true,
        deliveryFee: true,
        estimatedCost: true,
        tip: true,
        settlement: { select: { collectedAmount: true } },
        // Preferred over recomputing when present, so a payout already recorded
        // for a rider cannot be restated by a later report run.
        commission: { select: { riderShare: true, businessShare: true } },
      },
    });
  },

  // Raw rows for the Dashboard trend chart — fetched once strictly for completed errands
  findRevenueRowsBetween(start: Date, end: Date) {
    return prisma.errand.findMany({
      where: {
        createdAt: { gte: start, lt: end },
        status: { in: ["DELIVERED", "COMPLETED"] },
      },
      // deliveryFee/tip/estimatedCost as well as totalCost: the dashboard's
      // revenue tile reports gross order value, but the rider/business split
      // beside it may only ever be taken on fees.
      select: { createdAt: true, totalCost: true, deliveryFee: true, tip: true, estimatedCost: true },
    });
  },

  // Feeds the Rider Performance report's per-rider completed-count and average-
  // delivery-time math (computed in reportService.ts, not here — this just returns
  // the raw rows). Treats DELIVERED and COMPLETED as both "finished": DELIVERED is
  // what the rider app actually sets today (see modules/home's "Mark as Delivered"),
  // COMPLETED is a separate settlement-closure step with no UI trigger built yet —
  // counting only COMPLETED would silently report zero completions for every rider.
  findFinishedBetween(start: Date, end: Date) {
    return prisma.errand.findMany({
      where: { status: { in: ["DELIVERED", "COMPLETED"] }, updatedAt: { gte: start, lt: end } },
      select: { riderId: true, createdAt: true, updatedAt: true },
    });
  },

  // Unchecked* input types are used here (not the relation-based CreateInput/UpdateInput)
  // because callers pass scalar foreign keys directly (customerId, riderId), matching the
  // original inline handlers this was migrated from.
  create(data: Prisma.ErrandUncheckedCreateInput) {
    return prisma.errand.create({ data, include: ERRAND_INCLUDE });
  },

  update(id: string, data: Prisma.ErrandUncheckedUpdateInput) {
    return prisma.errand.update({ where: { id }, data, include: ERRAND_INCLUDE });
  },

  // Atomic claim guard: only flips AVAILABLE -> PENDING if it's still AVAILABLE at
  // the moment of the write, closing the TOCTOU race between the read-then-write
  // "already claimed?" check in errandService.claimErrand and this update.
  claimIfAvailable(id: string) {
    return prisma.errand.updateMany({ where: { id, status: "AVAILABLE" }, data: { status: "PENDING" } });
  },
};

export const dispatchLogRepository = {
  findLatestByErrandId(errandId: string) {
    return prisma.dispatchLog.findFirst({
      where: { errandId },
      include: { dispatcher: true },
      orderBy: { dispatchedAt: "desc" },
    });
  },

  create(errandId: string, dispatcherId: number) {
    return prisma.dispatchLog.create({ data: { errandId, dispatcherId } });
  },
};
