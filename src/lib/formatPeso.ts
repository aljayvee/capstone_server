/**
 * Shared money formatting, server side.
 *
 * Mirrors `Capstone_Project_Web/src/utils/format.ts` and
 * `CustomerApp/src/utils/format.ts` verbatim — four separate npm projects with
 * no shared package, and one errand's total must read the same on all of them.
 *
 * Grouping is done by hand rather than through Intl for the same reason the
 * clients do it: the same function has to give the same answer everywhere.
 */

/**
 * The digits, grouped, with centavos only when there are any.
 *
 * The delivery fare is charged in whole pesos, so "205.00" spends three
 * characters saying nothing. Item money is not whole — a receipt reads
 * 994.50 — so this cannot simply drop the decimals; it drops them only when
 * they are zero.
 */
function formatAmount(value: number): { sign: string; digits: string } | null {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;

  const rounded = Math.round(amount * 100) / 100;
  const sign = rounded < 0 ? "-" : "";
  const magnitude = Math.abs(rounded);

  const text = Number.isInteger(magnitude) ? String(magnitude) : magnitude.toFixed(2);
  const [whole, centavos] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return { sign, digits: `${grouped}${centavos ? `.${centavos}` : ""}` };
}

/** Money with the peso sign, matching what the dashboard renders on screen. */
export function formatPeso(value: number): string {
  const parts = formatAmount(value);
  if (!parts) return "₱0";
  return `${parts.sign}₱${parts.digits}`;
}

/**
 * Money with the ISO 4217 code instead of the sign, for the PDF exports.
 *
 * PDFKit's built-in fonts (Helvetica and the rest) are WinAnsi-encoded, and
 * **U+20B1 PESO SIGN is not in WinAnsi**. It does not throw — it silently draws
 * the wrong glyph — so a PDF built with `formatPeso` above would ship money
 * figures with a corrupted currency mark and nothing would catch it.
 *
 * Fixing that properly needs a TTF with the glyph registered via
 * `doc.registerFont`. None is bundled: DejaVu is not a dependency here, and the
 * Windows system fonts that do carry the sign are neither redistributable nor
 * present on a Linux host. "PHP" is the ISO code, unambiguous in a financial
 * document, and renders in every font.
 *
 * The DIGITS are produced by the same helper as `formatPeso`, so the number in
 * the PDF and the number on screen can never disagree — only the currency mark
 * differs. If a suitable font is ever added, point `reportDocument.ts` at it and
 * switch this to `formatPeso`.
 */
export function formatPesoAscii(value: number): string {
  const parts = formatAmount(value);
  if (!parts) return "PHP 0";
  return `${parts.sign}PHP ${parts.digits}`;
}
