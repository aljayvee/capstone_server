import { prisma } from "../lib/prisma.js";
import type { ErrandPaymentKind } from "@prisma/client";

/**
 * The payment ledger for one errand.
 *
 * Deliberately has no `update` and no `delete`. Every row records money that
 * arrived and a person who vouched for it; correcting one by editing it in place
 * would erase the attestation along with the mistake. A payment recorded in
 * error is corrected with a REFUND row, which is also what actually happens to
 * the money.
 *
 * Mirrors paymentSelectionRepository, which is append-only for the same reason.
 */
export const errandPaymentRepository = {
  findByErrandId(errandId: string) {
    return prisma.errandPayment.findMany({
      where: { errandId },
      orderBy: { confirmedAt: "asc" },
      include: {
        confirmedBy: { select: { id: true, firstName: true, lastName: true, role: true } },
      },
    });
  },

  /** Just the amounts, for the many callers that only need a running total. */
  findAmountsByErrandId(errandId: string) {
    return prisma.errandPayment.findMany({
      where: { errandId },
      select: { kind: true, amount: true },
    });
  },

  findOneOfKind(errandId: string, kind: ErrandPaymentKind) {
    return prisma.errandPayment.findFirst({ where: { errandId, kind } });
  },

  /**
   * Whether a transfer reference number already backs a payment on ANOTHER
   * errand. One real transfer is one payment; the same screenshot sent twice is
   * the cheapest fraud there is, and the only one automatic confirmation cannot
   * see on its own.
   */
  async isReferenceUsedElsewhere(referenceNo: string, errandId: string): Promise<boolean> {
    const hit = await prisma.receiptExtraction.findFirst({
      where: {
        referenceNo,
        proofImage: {
          errandId: { not: errandId },
          kind: { in: ["PAYMENT_PROOF", "RIDER_BALANCE_PROOF", "TRANSFER"] },
        },
      },
      select: { id: true },
    });
    return hit !== null;
  },

  create(data: {
    errandId: string;
    kind: ErrandPaymentKind;
    amount: number;
    /** Null only for an automatic confirmation from a receipt that passed every check. */
    confirmedByUserId: number | null;
    note?: string | null;
    /** The photo (customer's or rider's) that justified this attestation. */
    proofImageId?: number | null;
  }) {
    return prisma.errandPayment.create({
      data,
      include: {
        confirmedBy: { select: { id: true, firstName: true, lastName: true, role: true } },
      },
    });
  },
};
