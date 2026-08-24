import { prisma } from "../lib/prisma.js";
import { assignItemsToStops, type AssignableStop } from "../lib/itemStopAssignment.js";

export const pabiliItemRepository = {
  findByErrandId(errandId: string) {
    return prisma.pabiliItemRequest.findMany({
      where: { errandId },
      orderBy: { id: "asc" },
    });
  },

  /**
   * Files every item under the stop the rider buys it at.
   *
   * Both item lists are attached, from the same rule, because they answer
   * different questions:
   *
   *  - `pabili_details_tbl` is the WORKING list. The dispatcher edits it, and it
   *    is what the rider shops from, so its answer is the authoritative one.
   *  - `pabili_item_requests_tbl` is the customer's immutable original. Its
   *    answer records where the customer's own ask would have landed, which is
   *    what a dispute needs to see.
   *
   * They can legitimately differ — that difference IS the dispatcher's
   * correction — but they can never differ in logic, because the matching lives
   * in one place (see lib/itemStopAssignment).
   *
   * Deliberately conservative: an item matching no pinned stop is left
   * unattached rather than guessed onto the nearest one. The rider's view shows
   * unattached items as a general list, which is honest, whereas an item
   * silently filed under the wrong shop sends them to buy it in the wrong place.
   *
   * Returns how many working-list items were filed.
   */
  async attachToPinpoints(errandId: string): Promise<number> {
    const [details, requests, pinpoints] = await Promise.all([
      prisma.pabiliDetail.findMany({
        where: { errandId },
        select: { id: true, storeCategory: true },
      }),
      prisma.pabiliItemRequest.findMany({
        where: { errandId },
        select: { id: true, storeCategory: true },
      }),
      prisma.errandPinpoint.findMany({
        where: { errandId },
        orderBy: { sequence: "asc" },
        select: { id: true, sequence: true, storeName: true, category: { select: { name: true } } },
      }),
    ]);

    if (pinpoints.length === 0) return 0;

    // The dispatcher numbers stores by position in the visit order, and
    // `sequence` is 0-based in the database while their labels read "Store 1".
    // Normalise here so the matching rule never has to know that.
    const stops: AssignableStop[] = pinpoints.map((pin, index) => ({
      id: pin.id,
      sequence: index + 1,
      storeName: pin.storeName,
      categoryName: pin.category?.name ?? null,
    }));

    const detailAssignments = assignItemsToStops(details, stops);
    const requestAssignments = assignItemsToStops(requests, stops);

    if (detailAssignments.length === 0 && requestAssignments.length === 0) return 0;

    await prisma.$transaction([
      ...detailAssignments.map((a) =>
        prisma.pabiliDetail.update({ where: { id: a.id }, data: { pinpointId: a.pinpointId } })
      ),
      ...requestAssignments.map((a) =>
        prisma.pabiliItemRequest.update({ where: { id: a.id }, data: { pinpointId: a.pinpointId } })
      ),
    ]);

    return detailAssignments.length;
  },
};
