/**
 * What a confirmed errand is billed at.
 *
 * The delivery fee is priced live from a measured route, and recalculateFee
 * re-measures on every call — including the one markItemsPurchased makes when a
 * rider uploads a receipt. Distance is charged in whole started kilometres, so
 * pricing is a step function: the same Tacurong leg measures 2716 m on Google,
 * 2724 m as stored and 2756 m on OSRM, and near a kilometre boundary that
 * ordinary spread moves the fare a whole ₱10. A customer quoted ₱90 was charged
 * ₱80 that way, 35 seconds after a re-measurement, with nobody deciding it.
 *
 * So once the customer has agreed to a fare, that fare is what they pay. The
 * item money is deliberately NOT frozen with it: a receipt that beats the
 * estimate is still theirs to pay, and checkReceiptOverage is what stops an
 * overage they never agreed to. What was agreed was the FARE.
 */

export interface LivePrice {
  deliveryFee: number;
  totalCost: number;
}

export interface AgreedFare {
  deliveryFee: number;
  totalCost: number;
  /** True when the customer's agreed fare was used instead of the live price. */
  frozen: boolean;
}

/**
 * Picks between the agreed fare and a freshly computed one.
 *
 * `agreedFare` is null until the customer confirms, and on every errand that
 * predates the column — both of which mean "price it live", which is exactly the
 * behaviour that came before.
 */
export function fareAfterAgreement(input: {
  agreedFare: number | null | undefined;
  livePrice: LivePrice;
  estimatedCost: number;
  tip: number;
}): AgreedFare {
  const { agreedFare, livePrice, estimatedCost, tip } = input;

  if (agreedFare === null || agreedFare === undefined) {
    return { deliveryFee: livePrice.deliveryFee, totalCost: livePrice.totalCost, frozen: false };
  }

  // Rebuilt rather than taken from the live price, because the basket legitimately
  // moves after agreement — the receipt is the real figure — while the fare does
  // not. Rounded to the centavo: the fare is whole pesos but item money is not,
  // and floating point otherwise leaves a total like 139.99999999999997.
  const totalCost = Math.round((agreedFare + estimatedCost + tip) * 100) / 100;

  return { deliveryFee: agreedFare, totalCost, frozen: true };
}
