import { describe, expect, it } from "vitest";
import { firebaseUidFor } from "../src/lib/firebaseAdmin.js";

/**
 * The uid scheme the Realtime Database security rules parse.
 *
 * `firebase/database.rules.json` writes ownership as string arithmetic — a
 * rider's pin is writable only by `'rider_' + $riderId` — so these prefixes are
 * not cosmetic. They are one half of a contract whose other half lives in a file
 * this test cannot import, which is exactly why the shape is pinned here: a
 * rename that looks harmless in TypeScript silently unlocks or locks out every
 * client against rules that were never changed to match.
 */
describe("the Firebase uid for one of our users", () => {
  it("namespaces riders and customers apart", () => {
    // The failure this prevents. Staff and riders are rows in `users`, customers
    // are rows in `customer_accounts`, and both sequences start at 1. An
    // unprefixed numeric uid would make customer 3 and rider 3 the same Firebase
    // principal, and `riders/3` — writable by `rider_3` — would become writable
    // by a customer who happened to share the id.
    expect(firebaseUidFor("RIDER", 3)).toBe("rider_3");
    expect(firebaseUidFor("CUSTOMER", 3)).toBe("customer_3");
    expect(firebaseUidFor("RIDER", 3)).not.toBe(firebaseUidFor("CUSTOMER", 3));
  });

  it("puts both staff roles in one namespace", () => {
    // The rules separate staff from everyone else by the `role` claim, not by
    // uid, because an owner and a dispatcher get the same access to the fleet.
    expect(firebaseUidFor("OWNER", 1)).toBe("staff_1");
    expect(firebaseUidFor("DISPATCHER", 1)).toBe("staff_1");
  });

  it("does not care how the role was cased", () => {
    // Role reaches this from a JWT claim, and the codebase is not consistent
    // about case. A lowercase "rider" producing `staff_7` would hand that rider
    // staff-shaped access and lock them out of writing their own pin.
    expect(firebaseUidFor("rider", 7)).toBe("rider_7");
    expect(firebaseUidFor("Customer", 7)).toBe("customer_7");
  });

  it("falls back to staff rather than to an unprefixed id", () => {
    // Deny-by-default, in uid form. An unrecognised role must not produce
    // something that could collide with a real rider or customer uid; it
    // produces a staff uid, which the rules then check against the `role` claim
    // and refuse, because that claim will not say OWNER or DISPATCHER.
    expect(firebaseUidFor("", 5)).toBe("staff_5");
    expect(firebaseUidFor("SOMETHING_NEW", 5)).toBe("staff_5");
  });
});

/**
 * The other half of the contract: what happens when nobody configured this.
 *
 * A missing service account is the most likely state for a fresh checkout and a
 * plausible one for a misconfigured deploy. It must leave the API running, so
 * that a real-time convenience being unset degrades the live map rather than
 * taking down errand creation, dispatch and payments with it.
 */
describe("when no service account is configured", () => {
  it("reports itself unconfigured instead of throwing on import", async () => {
    const { isFirebaseConfigured, firebaseConfigurationError } = await import(
      "../src/lib/firebaseAdmin.js"
    );

    // This suite runs without FIREBASE_SERVICE_ACCOUNT_PATH or _JSON set, which
    // is the case being pinned. Reaching this line at all is half the assertion:
    // an import that threw would have failed the whole file.
    expect(isFirebaseConfigured()).toBe(false);

    // And it says why, in words an operator can act on, rather than failing mute.
    expect(firebaseConfigurationError()).toMatch(/FIREBASE_SERVICE_ACCOUNT/);
  });

  it("refuses to mint rather than returning a token nothing will accept", async () => {
    const { mintCustomToken } = await import("../src/lib/firebaseAdmin.js");
    await expect(mintCustomToken("RIDER", 3)).rejects.toThrow();
  });
});
