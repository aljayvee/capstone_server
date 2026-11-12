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
//
// `reference` is the errand number people read (lib/errandReference.ts
// referenceLabel), never the raw id.
export const notificationFactory = {
  riderAssigned(reference: string, pickupAddress: string): NotificationContent {
    return {
      type: "ERRAND_ASSIGNED",
      title: "New Errand Assigned",
      body: `Errand ${reference} — ${pickupAddress}`,
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

  feeUpdated(reference: string, totalCost: number): NotificationContent {
    return {
      type: "FEE_UPDATED",
      title: "Delivery Fee Updated",
      body: `Errand ${reference}'s total is now ₱${totalCost.toFixed(2)}.`,
    };
  },

  /** To the customer: the rider has everything and the half is due now. */
  halfPaymentRequested(amount: number, goodsTotal: number): NotificationContent {
    return {
      type: "HALF_PAYMENT_REQUESTED",
      title: "Your items are bought. Half-payment needed",
      body: `Send ₱${amount.toFixed(2)}, half of the ₱${goodsTotal.toFixed(2)} your rider paid, so they can bring your items. Tap to open the chat.`,
    };
  },

  /** To the dispatcher handling it: a rider is waiting at the last shop. */
  halfPaymentRequestedStaff(customerName: string, amount: number): NotificationContent {
    return {
      type: "HALF_PAYMENT_REQUESTED",
      title: `${customerName} needs to send the half-payment`,
      body: `The rider has every item and is waiting. Ask ${customerName} for ₱${amount.toFixed(2)} in the chat.`,
    };
  },

  /** To the rider: go. Names what is left to collect, which is the next question. */
  halfPaymentSettled(customerName: string, balanceDue: number): NotificationContent {
    return {
      type: "HALF_PAYMENT_SETTLED",
      title: `${customerName} settled the half-payment`,
      body: `Head to the customer. Collect ₱${balanceDue.toFixed(2)} at the door: the other half plus the fees.`,
    };
  },

  /** To the customer: their receipt counted. */
  halfPaymentReceived(amount: number): NotificationContent {
    return {
      type: "HALF_PAYMENT_RECEIVED",
      title: "Half-payment received",
      body: `We got your ₱${amount.toFixed(2)}. Your rider is on the way with your items.`,
    };
  },

  itemOutOfStock(itemName: string, storeName?: string): NotificationContent {
    return {
      type: "ITEM_OUT_OF_STOCK",
      title: `Item Out of Stock: ${itemName}`,
      body: storeName
        ? `Rider reported ${itemName} is out of stock at ${storeName}. Check with customer for substitutes.`
        : `Rider reported ${itemName} is out of stock. Check with customer for substitutes.`,
    };
  },

  substituteDeclined(itemName: string): NotificationContent {
    return {
      type: "SUBSTITUTE_DECLINED",
      title: `No Substitute: ${itemName}`,
      body: `Customer declined substitute for ${itemName}. Proceeding without this item.`,
    };
  },

  riderNearby(storeSummary: string): NotificationContent {
    return {
      type: "RIDER_NEARBY",
      title: "Your rider is almost there",
      body: storeSummary
        ? `Your rider for ${storeSummary} is within 500m of your delivery address. Please prepare your payment (COD)!`
        : "Your rider is within 500m of your delivery address. Please prepare your payment (COD)!",
    };
  },

  customerChat(reference: string, customerName: string, snippet: string): NotificationContent {
    return {
      type: "CUSTOMER_CHAT_MESSAGE",
      title: `Message from ${customerName || "Customer"}`,
      body: `Errand ${reference}: ${snippet ? (snippet.length > 80 ? snippet.slice(0, 77) + "..." : snippet) : "Sent a message"}`,
    };
  },
};
