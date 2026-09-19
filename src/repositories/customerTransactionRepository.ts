import type { ProofImageKind } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

// The kinds that carry a purchase amount. TRANSFER and PROOF_OF_DELIVERY do
// not, and PROOF_OF_DELIVERY has no stop attached at all.
//
// Declared out here rather than inline: WITH_REPORT_DETAILS below is `as const`,
// which would make this array readonly, and Prisma's enum filter takes a mutable
// one. Mirrors proofImageService.confirmedReceiptTotal, which sums the same two.
const RECEIPT_KINDS: ProofImageKind[] = ["RECEIPT", "NO_RECEIPT"];

const WITH_ERRAND_DETAILS = {
  errand: {
    include: {
      pabiliDetails: true,
      pinpoints: { orderBy: { sequence: "asc" as const } },
      rider: { select: { firstName: true, lastName: true } },
    },
  },
} as const;

// Transaction Summary report needs rider name, customer name, and full errand
// context in one shot — a superset of WITH_ERRAND_DETAILS above.
//
// `Errand.category` is deliberately NOT selected: errandValidators pins it to
// the literal "Pabili", so as a report column it said nothing. The merchant
// category is resolved instead from the same evidence the Sales report uses —
// receipts, then items, then pinned stops — which is why the item and pinpoint
// relations are pulled here. Loading them with the transaction is one query;
// resolving them afterwards would be three per row.
const WITH_REPORT_DETAILS = {
  errand: {
    select: {
      id: true,
      status: true,
      pickupAddress: true,
      deliveryAddress: true,
      deliveryFee: true,
      estimatedCost: true,
      rider: { select: { firstName: true, lastName: true } },
      // The live payment method. CustomerTransaction.paymentMethod is written
      // once at creation and defaults to COD; PaymentSelection is what a
      // dispatcher actually confirms with the customer.
      paymentMode: { select: { name: true } },
      paymentSelection: { select: { paymentMode: { select: { name: true } } } },
      pabiliItemRequests: { select: { storeCategory: true, quantity: true } },
      pabiliDetails: { select: { storeCategory: true, quantity: true } },
      pinpoints: { select: { id: true, category: { select: { name: true, status: true } } } },
      proofImages: {
        where: { kind: { in: RECEIPT_KINDS } },
        select: {
          pinpointId: true,
          declaredTotal: true,
          extraction: { select: { confirmedTotal: true } },
        },
      },
      // The confirmed ledger row (UPFRONT/FINAL/TOP_UP/REFUND) and, where one
      // exists, the exact photo that justified it — the customer's own upload,
      // or a rider's door-side RIDER_BALANCE_PROOF. Lets the report show a
      // reference number and say whose evidence backed the money, not just
      // that it arrived.
      payments: {
        select: {
          kind: true,
          amount: true,
          confirmedByUserId: true,
          confirmedBy: { select: { firstName: true, lastName: true } },
          proofImage: {
            select: {
              riderId: true,
              customerId: true,
              capturedAt: true,
              extraction: { select: { referenceNo: true, transactionId: true } },
            },
          },
        },
      },
    },
  },
  customer: { select: { information: { select: { firstName: true, lastName: true } } } },
} as const;

export const customerTransactionRepository = {
  create(customerId: number, errandId: string, amount: number, paymentMethod: string) {
    return prisma.customerTransaction.create({
      data: { customerId, errandId, amount, paymentMethod },
    });
  },

  findByCustomerId(customerId: number) {
    return prisma.customerTransaction.findMany({
      where: { customerId },
      include: WITH_ERRAND_DETAILS,
      orderBy: { createdAt: "desc" },
    });
  },

  updateAmountByErrandId(errandId: string, amount: number) {
    return prisma.customerTransaction.updateMany({
      where: { errandId },
      data: { amount },
    });
  },

  findBetween(start: Date, end: Date) {
    return prisma.customerTransaction.findMany({
      where: { createdAt: { gte: start, lt: end } },
      include: WITH_REPORT_DETAILS,
      orderBy: { createdAt: "desc" },
    });
  },
};
