/**
 * The permission catalog: every key an access group can hold, for the two
 * roles that have groups (Admin = OWNER, and DISPATCHER). The single source of
 * truth; the portal reads it from GET /access/catalog and renders whatever is
 * here, so adding a key needs no web change to appear in the group editor.
 *
 * Riders have no groups: the rider app has one job, and its routes stay gated
 * by role alone.
 *
 * Managing access is deliberately NOT a key. It belongs to the Main Owner
 * account alone (mainOwner.ts), so no group or override can grant it, and no
 * combination of edits can leave the system with nobody able to manage it.
 *
 * A key added here later is automatically part of "Full access" (an account
 * with no group), and absent from every custom group until the Main Owner
 * ticks it. New features therefore start closed for restricted accounts.
 */

export type PermissionScope = "OWNER" | "DISPATCHER";

export interface PermissionDefinition {
  key: string;
  scope: PermissionScope;
  /** Heading the group editor files the key under. */
  area: string;
  /** The checklist line in the group editor. */
  title: string;
  /**
   * Keys this one is useless without, for the editor: ticking it ticks them,
   * unticking one of them unticks it. The server checks each key on its own.
   */
  requires?: readonly string[];
  /** Short, and the end of the refusal sentence: "...does not include <label>." */
  label: string;
  description: string;
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  // Admin (Owner portal)
  {
    key: "dashboard.view",
    scope: "OWNER",
    area: "Overview",
    title: "View the dashboard",
    label: "the dashboard",
    description: "Sales, order and fleet figures on the Dashboard.",
  },
  {
    key: "reports.view",
    scope: "OWNER",
    area: "Overview",
    title: "View reports",
    label: "reports",
    description: "Every report tab: sales, rider performance, commission, settlement, transactions and the help desk report.",
  },
  {
    key: "reports.print",
    scope: "OWNER",
    area: "Overview",
    title: "Print reports",
    requires: ["reports.view"],
    label: "printing reports",
    description: "Print a report or save it as a PDF. Every printout is logged.",
  },
  {
    key: "users.view",
    scope: "OWNER",
    area: "People",
    title: "View users",
    label: "the user directory",
    description: "See staff and rider accounts in Users.",
  },
  {
    key: "users.manage",
    scope: "OWNER",
    area: "People",
    title: "Manage dispatcher and rider accounts",
    requires: ["users.view"],
    label: "managing dispatcher and rider accounts",
    description: "Create, edit and deactivate dispatcher and rider accounts. Admin accounts stay with the Main Owner.",
  },
  {
    key: "tracking.view",
    scope: "OWNER",
    area: "Operations",
    title: "Track riders",
    label: "rider tracking",
    description: "The live rider map and each rider's current route.",
  },
  {
    key: "merchants.manage",
    scope: "OWNER",
    area: "Configuration",
    title: "Manage merchant categories and places",
    label: "managing merchant categories and places",
    description: "Add, edit and archive merchant categories, store photos and verified places.",
  },
  {
    key: "rates.manage",
    scope: "OWNER",
    area: "Configuration",
    title: "Change service rates",
    label: "changing service rates",
    description: "Delivery fees, the commission split and the other rates customers pay.",
  },
  {
    key: "copilot.use",
    scope: "OWNER",
    area: "Assistant",
    title: "Use Kuya Sugo",
    label: "Kuya Sugo",
    description: "Ask Kuya Sugo questions. It only answers from data this account can already see.",
  },

  // Dispatcher (Dispatcher portal)
  {
    key: "queue.view",
    scope: "DISPATCHER",
    area: "Orders",
    title: "View the order queue",
    label: "the order queue",
    description: "See incoming and active orders and the dispatcher dashboard.",
  },
  {
    key: "errands.review",
    scope: "DISPATCHER",
    area: "Orders",
    title: "Review orders",
    requires: ["queue.view"],
    label: "reviewing orders",
    description: "Claim, verify, release and decline orders, set store pins and edit items.",
  },
  {
    key: "errands.assign",
    scope: "DISPATCHER",
    area: "Orders",
    title: "Assign riders",
    requires: ["queue.view"],
    label: "assigning riders",
    description: "Assign a rider to an order.",
  },
  {
    key: "errands.cancel",
    scope: "DISPATCHER",
    area: "Orders",
    title: "Cancel orders",
    requires: ["queue.view"],
    label: "cancelling orders",
    description: "Cancel an order.",
  },
  {
    key: "payments.confirm",
    scope: "DISPATCHER",
    area: "Money",
    title: "Confirm payments",
    requires: ["queue.view"],
    label: "confirming payments",
    description: "Turn on payment for an order and confirm upfront, top-up and balance payments.",
  },
  {
    key: "payments.refund",
    scope: "DISPATCHER",
    area: "Money",
    title: "Record refunds",
    requires: ["queue.view"],
    label: "recording refunds",
    description: "Record money returned to a customer.",
  },
  {
    key: "settlements.adjust",
    scope: "DISPATCHER",
    area: "Money",
    title: "Adjust settlements",
    label: "settlement adjustments",
    description: "See money riders still owe, and record or void settlement adjustments.",
  },
  {
    key: "exceptions.resolve",
    scope: "DISPATCHER",
    area: "Help desk",
    title: "Resolve exceptions",
    label: "the exception queue",
    description: "See and resolve help desk exceptions.",
  },
  {
    key: "feedback.view",
    scope: "DISPATCHER",
    area: "Help desk",
    title: "Read customer feedback",
    label: "customer feedback",
    description: "Read and mark customer feedback.",
  },
];

const BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));

export function getPermission(key: string): PermissionDefinition | undefined {
  return BY_KEY.get(key);
}

export function isPermissionKey(key: string, scope?: PermissionScope): boolean {
  const permission = BY_KEY.get(key);
  return Boolean(permission && (!scope || permission.scope === scope));
}

export function permissionKeysFor(scope: PermissionScope): string[] {
  return PERMISSIONS.filter((p) => p.scope === scope).map((p) => p.key);
}

/** The roles that have access groups, or null for one that does not. */
export function scopeOfRole(role: string | null | undefined): PermissionScope | null {
  const upper = String(role ?? "").toUpperCase();
  return upper === "OWNER" || upper === "DISPATCHER" ? upper : null;
}

/** Name the built-in group goes by, for an account with no group. */
export const FULL_ACCESS_GROUP_NAME = "Full access";
