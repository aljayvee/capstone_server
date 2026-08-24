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

  errandAccepted(dispatcherName: string, storeSummary: string): NotificationContent {
    return {
      type: "ERRAND_ACCEPTED",
      // Named, because "a dispatcher" is an abstraction and a person is not.
      // This is the moment the customer stops waiting on a system and starts
      // dealing with someone, and the copy should carry that.
      title: `${dispatcherName} is handling your errand`,
      body: storeSummary
        ? `Tap to chat about your ${storeSummary} request.`
        : "Tap to chat about your errand.",
    };
  },

  errandDeclined(reason: string): NotificationContent {
    return {
      type: "ERRAND_DECLINED",
      title: "Your errand could not be accepted",
      // The reason travels in the notification itself. A customer who is told
      // only that their request was cancelled has to open the app to find out
      // why, and the why is the entire content of the message.
      body: reason,
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
