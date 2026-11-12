import { describe, it, expect, vi, beforeEach } from "vitest";
import { notificationFactory } from "../src/services/patterns/notificationFactory.js";
import { notifyDispatcherCustomerChat } from "../src/services/notificationService.js";
import { notificationRepository } from "../src/repositories/notificationRepository.js";
import { eventPublisher } from "../src/lib/eventPublisher.js";

vi.mock("../src/repositories/notificationRepository.js", () => ({
  notificationRepository: {
    create: vi.fn(),
    findUnreadByRef: vi.fn(async () => null),
    bump: vi.fn(),
    findForUser: vi.fn(),
    findForCustomer: vi.fn(),
    markRead: vi.fn(),
    markAllReadForUser: vi.fn(),
    markAllReadForCustomer: vi.fn(),
  },
}));

// deliverToStaff asks which recipients are owners (chat is held back from them); none here.
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { user: { findMany: vi.fn(async () => []) } },
}));

vi.mock("../src/lib/errandReference.js", () => ({
  referenceLabel: vi.fn(async () => "261019-1UUID-0007"),
}));

vi.mock("../src/lib/eventPublisher.js", () => ({
  eventPublisher: {
    emit: vi.fn(),
    emitToUser: vi.fn(),
    emitToCustomer: vi.fn(),
    emitToRole: vi.fn(),
    emitToErrand: vi.fn(),
    emitToErrandParties: vi.fn(),
  },
}));

describe("Notification System & Factory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("notificationFactory.customerChat", () => {
    it("formats customer chat notification with truncated snippet", () => {
      const longMessage = "Please add 2 bottles of mineral water and 1 pack of biscuits to the grocery store list thank you";
      const content = notificationFactory.customerChat("261019-4XYZ0-0042", "Maria Santos", longMessage);

      expect(content.type).toBe("CUSTOMER_CHAT_MESSAGE");
      expect(content.title).toBe("Message from Maria Santos");
      expect(content.body).toContain("Errand 261019-4XYZ0-0042");
      expect(content.body).toContain("Please add 2 bottles");
    });

    it("falls back to Customer if customer name is missing", () => {
      const content = notificationFactory.customerChat("261019-4XYZ0-0042", "", "Hello!");
      expect(content.title).toBe("Message from Customer");
      expect(content.body).toBe("Errand 261019-4XYZ0-0042: Hello!");
    });
  });

  describe("notifyDispatcherCustomerChat", () => {
    it("creates persisted notification for assigned dispatcher and emits to DISPATCHER role", async () => {
      const mockRecord = {
        id: 99,
        userId: 5,
        type: "CUSTOMER_CHAT_MESSAGE",
        title: "Message from John",
        body: "Errand 261019-1UUID-0007: Where is my order?",
        isRead: false,
        createdAt: new Date(),
      };

      vi.mocked(notificationRepository.create).mockResolvedValue(mockRecord as any);

      const result = await notifyDispatcherCustomerChat(
        "err-0001-uuid",
        5,
        "John",
        "Where is my order?"
      );

      expect(notificationRepository.create).toHaveBeenCalledWith({
        userId: 5,
        type: "CUSTOMER_CHAT_MESSAGE",
        title: "Message from John",
        body: "Errand 261019-1UUID-0007: Where is my order?",
        priority: "NORMAL",
        refKey: "errand:err-0001-uuid",
      });

      expect(eventPublisher.emitToRole).toHaveBeenCalledWith(
        "DISPATCHER",
        "notification:new",
        expect.objectContaining({
          id: 99,
          type: "CUSTOMER_CHAT_MESSAGE",
          title: "Message from John",
          errandId: "err-0001-uuid",
          ephemeral: true,
        })
      );

      expect(result).toEqual(mockRecord);
    });

    it("folds a second message into the dispatcher's unread row for that errand", async () => {
      const open = { id: 99, userId: 5, title: "Message from John", isRead: false };
      vi.mocked(notificationRepository.findUnreadByRef).mockResolvedValueOnce(open as any);
      vi.mocked(notificationRepository.bump).mockResolvedValue({ ...open, title: "Message from John (2 new)" } as any);

      await notifyDispatcherCustomerChat("err-0001-uuid", 5, "John", "Hello again");

      expect(notificationRepository.findUnreadByRef).toHaveBeenCalledWith(5, "CUSTOMER_CHAT_MESSAGE", "errand:err-0001-uuid");
      expect(notificationRepository.create).not.toHaveBeenCalled();
      expect(notificationRepository.bump).toHaveBeenCalledWith(99, {
        title: "Message from John (2 new)",
        body: "Errand 261019-1UUID-0007: Hello again",
        priority: "NORMAL",
      });
    });

    it("still emits broadcast alert even if no dispatcher is assigned yet", async () => {
      const result = await notifyDispatcherCustomerChat(
        "err-unassigned",
        null,
        "Alice",
        "Is anyone available?"
      );

      expect(notificationRepository.create).not.toHaveBeenCalled();
      expect(eventPublisher.emitToRole).toHaveBeenCalledWith(
        "DISPATCHER",
        "notification:new",
        expect.objectContaining({
          type: "CUSTOMER_CHAT_MESSAGE",
          title: "Message from Alice",
          errandId: "err-unassigned",
        })
      );
      expect(result).toBeNull();
    });
  });
});
