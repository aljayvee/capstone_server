export interface NotificationContent {
  type: string;
  title: string;
  body: string;
}

// Factory: notification content differs by type and recipient role — this is
// the "different notification types... by role" case AGENTS.md's Factory
// Pattern guidance names directly. One place shapes title/body; callers never
// string-template a notification themselves. Extend this object with a new
// method per trigger point as they're built (Open/Closed) — don't grow a
// switch statement at each call site instead.
export const notificationFactory = {
  riderAssigned(errandId: string, pickupAddress: string): NotificationContent {
    return {
      type: "ERRAND_ASSIGNED",
      title: "New Errand Assigned",
      body: `Errand #${errandId.slice(0, 8)} — ${pickupAddress}`,
    };
  },

  feeUpdated(errandId: string, totalCost: number): NotificationContent {
    return {
      type: "FEE_UPDATED",
      title: "Delivery Fee Updated",
      body: `Errand #${errandId.slice(0, 8)}'s total is now ₱${totalCost.toFixed(2)}.`,
    };
  },
};
