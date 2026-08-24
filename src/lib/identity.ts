/**
 * Canonical forms for the two identifiers someone can sign in with.
 *
 * Both usernames and email addresses are matched case-insensitively, and until
 * now only one of them said so. Emails were lowercased in application code;
 * usernames only *behaved* case-insensitively because `users.username` and
 * `customer_accounts.username` are declared `utf8mb4_unicode_ci`, where the
 * `_ci` suffix means the column itself ignores case. Nothing in the source hinted
 * at that — `findUnique({ where: { username } })` reads as an exact match — so
 * the real rule lived in a column definition nobody looks at, and would have
 * changed silently under a collation edit or a move to Postgres, which is
 * case-sensitive by default.
 *
 * Routing every read and write through here makes the rule explicit and makes it
 * hold on its own, independently of how the columns happen to be declared. The
 * `_ci` collation stays as it is: belt and braces, not the mechanism.
 *
 * Note what is deliberately absent: there is no equivalent for passwords. A
 * password is the secret itself, and folding its case would cut the alphabet
 * from 62 characters to 36 and weaken every account at once. Passwords are only
 * ever edge-trimmed, never case-folded.
 */

/**
 * The stored and searchable form of a username.
 *
 * Lowercased so `jayvee`, `Jayvee` and `JAYVEE` are one account rather than
 * three — which is also what stops one person registering a visual lookalike of
 * another's name.
 */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The stored and searchable form of an email address.
 *
 * RFC 5321 permits a case-sensitive local part, but no mail provider in practice
 * treats it that way, and both mobile keyboards autocapitalise the first letter
 * of a field. Matching case-sensitively here would reject the same person's own
 * address depending on how their phone felt about it.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * True when the identifier should be resolved against the email column.
 *
 * A single shared test, so the customer and staff lookups cannot drift into
 * disagreeing about what counts as an email address.
 */
export function looksLikeEmail(identifier: string): boolean {
  return identifier.includes("@");
}
