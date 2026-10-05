import { describe, it, expect, vi, beforeEach } from "vitest";
import { notificationFactory } from "../src/services/patterns/notificationFactory.js";
import { notifyDispatcherCustomerChat } from "../src/services/notificationService.js";
import { notificationRepository } from "../src/repositories/notificationRepository.js";
import { eventPublisher } from "../src/lib/eventPublisher.js";

vi.mock("../src/repositories/notificationRepository.js", () => ({
  notificationRepository: {
    create: vi.fn(),
    findForUser: vi.fn(),
    findForCustomer: vi.fn(),
    markRead: vi.fn(),
    markAllReadForUser: vi.fn(),
    markAllReadForCustomer: vi.fn(),
  },
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
      const content = notificationFactory.customerChat("abc-1234-xyz", "Maria Santos", longMessage);

      expect(content.type).toBe("CUSTOMER_CHAT_MESSAGE");
      expect(content.title).toBe("Message from Maria Santos");
      expect(content.body).toContain("Errand #abc-1234");
      expect(content.body).toContain("Please add 2 bottles");
    });

    it("falls back to Customer if customer name is missing", () => {
      const content = notificationFactory.customerChat("abc-1234-xyz", "", "Hello!");
      expect(content.title).toBe("Message from Customer");
      expect(content.body).toBe("Errand #abc-1234: Hello!");
    });
  });

  describe("notifyDispatcherCustomerChat", () => {
    it("creates persisted notification for assigned dispatcher and emits to DISPATCHER role", async () => {
      const mockRecord = {
        id: 99,
        userId: 5,
        type: "CUSTOMER_CHAT_MESSAGE",
        title: "Message from John",
        body: "Errand #err-0001: Where is my order?",
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
        body: "Errand #err-0001: Where is my order?",
      });

      expect(eventPublisher.emitToRole).toHaveBeenCalledWith(
        "DISPATCHER",
        "notification:new",
        expect.objectContaining({
          id: 99,
          type: "CUSTOMER_CHAT_MESSAGE",
          title: "Message from John",
          errandId: "err-0001-uuid",
        })
      );

      expect(result).toEqual(mockRecord);
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
