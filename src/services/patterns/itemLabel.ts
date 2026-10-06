/**
 * How a pabili item reads to a person: "Chicken · 5 kg".
 *
 * The size lives in its own column (schema.prisma PabiliDetail.size) so the
 * category model, learned memory and the fee see "Chicken". Anything a person
 * reads, a rider's notification, a substitute prompt, a receipt line, gets the
 * two back together through this one function, so every app and message spells
 * it the same way.
 *
 * The separator is a middle dot on purpose. "|" is the store marker in filed
 * item names, a parenthesis is read back as the category by the chat text
 * fallback, and an em dash is banned by the Zero-Slop standard.
 */

const COMPARABLE = /[^a-z0-9.]+/g;

function comparable(text: string): string {
  return text.toLowerCase().replace(COMPARABLE, "");
}

export function formatItemLabel(name: string | null | undefined, size?: string | null): string {
  const cleanName = String(name ?? "").trim();
  const cleanSize = String(size ?? "").trim();
  if (!cleanSize) return cleanName;
  if (!cleanName) return cleanSize;

  // A row saved in fold mode, or typed as "Rice (5kg)", already says it.
  // Repeating it would read "Rice (5kg) · 5 kg".
  if (comparable(cleanName).endsWith(comparable(cleanSize))) return cleanName;

  return `${cleanName} · ${cleanSize}`;
}
