/**
 * The payment modes the rest of the system reasons about by name.
 *
 * `PaymentMode` is a catalogue row an owner could in principle rename, and two
 * separate places already compared against the literal "Cash on Delivery"
 * (errandService.recalculateFee and settlementService.submitSettlement). Two
 * copies of a magic string is how they come to disagree — and a rename that
 * silently turned every COD errand non-COD would reprice the whole board.
 *
 * Naming them here does not make the coupling safe, but it makes it visible and
 * single.
 */
export const PAYMENT_MODE_COD = "Cash on Delivery";

/**
 * The channels a non-COD customer actually pays through.
 *
 * Since 2026-10-08 both are paid at the door, like cash on delivery: the
 * customer transfers the whole bill when the rider arrives, the rider
 * photographs the confirmation and the system reads and records it
 * (errandPaymentService.confirmBalanceFromRiderProof). A confirmation the
 * system cannot accept is paid in cash instead. Nobody pays before delivery and
 * no dispatcher vouches for anything; there is still no gateway behind either.
 *
 * There was briefly a fifth catalogue row called "Non-COD — 50% Downpayment",
 * added on the mistaken reading that the downpayment was a payment METHOD. It
 * is not: nobody pays "via 50% downpayment", they pay via GCash or a bank
 * transfer, and 50%-now-balance-later is the arrangement those two are settled
 * under. The row was never selected by a single customer — it could not be,
 * because it named nothing a person could hand money to — and it has been
 * removed. Debit/Credit Card went Inactive at the same time: no gateway, and no
 * Facebook Page path either.
 */
export const PAYMENT_MODE_GCASH = "GCash / PayMaya";
export const PAYMENT_MODE_BANK = "Bank Transfer";

const NON_COD_MODES: ReadonlySet<string> = new Set([PAYMENT_MODE_GCASH, PAYMENT_MODE_BANK]);

/** The shape both call sites already had to hand. */
interface SelectionLike {
  paymentMode: { name: string };
}

/**
 * Cash on delivery, including the case where nobody has chosen yet.
 *
 * An errand with no confirmed selection is treated as COD: that is what the
 * rider will be handed at the door if nothing else is arranged, and it is the
 * behaviour both original call sites had.
 */
export function isCodSelection(selection: SelectionLike | null | undefined): boolean {
  return !selection || selection.paymentMode.name === PAYMENT_MODE_COD;
}

/**
 * Any mode whose money is tracked in ErrandPayment. Non-COD, in other words.
 *
 * The ledger holds the transfer the rider photographed at the door (a FINAL
 * row), so the rider's cash settlement nets against it. It is no longer a
 * downpayment plan: isDownpaymentPlan went with the 50% on 2026-10-08.
 */
export function hasPaymentLedger(selection: SelectionLike | null | undefined): boolean {
  return selection != null && NON_COD_MODES.has(selection.paymentMode.name);
}

/**
 * Whether the RIDER carries money on this mode.
 *
 * Always, on every mode this system supports: COD hands over the whole bill at
 * the door, and a non-COD customer who cannot transfer pays the rider in cash
 * instead. Kept as a named
 * function rather than inlined `true` because it is the question the settlement
 * guard is actually asking, and a mode that collects nothing is a plausible
 * future — a real gateway, whenever one exists, would be exactly that.
 */
export function riderCollectsCash(_selection: SelectionLike | null | undefined): boolean {
  return true;
}

/**
 * A GCash/PayMaya or bank customer who paid the rider in cash instead.
 *
 * The customer's PaymentSelection is never rewritten, so it keeps what they
 * chose; the errand's own payment mode is moved to Cash on Delivery when the
 * rider files the cash photo (paymentSelectionService.switchToCashOnDelivery).
 * The two disagreeing is the record of the change. Null when they agree, when
 * nothing was chosen, or when the errand moved anywhere but cash.
 */
export function paymentMethodChangeOf(errand: {
  paymentSelection?: SelectionLike | null;
  paymentMode?: { name: string } | null;
}): { from: string; to: string } | null {
  const chosen = errand.paymentSelection?.paymentMode?.name;
  const current = errand.paymentMode?.name;
  if (!chosen || !current || !NON_COD_MODES.has(chosen) || current !== PAYMENT_MODE_COD) return null;
  return { from: chosen, to: current };
}
