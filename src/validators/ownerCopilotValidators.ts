import { z } from "zod";

export const copilotMessageSchema = z
  .object({
    role: z.enum(["user", "model", "assistant"]),
    content: z.string().trim().min(1, "Message cannot be empty").max(10000, "Message exceeds 10,000 characters"),
  })
  .refine((m) => m.role !== "user" || m.content.length <= 2000, {
    message: "User message exceeds 2,000 characters",
    path: ["content"],
  });

export const copilotChatSchema = z.object({
  messages: z.array(copilotMessageSchema).min(1, "At least one message is required").max(60, "Conversation history is too long"),
  portalContext: z
    .object({
      activeModule: z.string().optional(),
      activeTab: z.string().optional(),
    })
    .optional(),
});

export type CopilotChatMessage = z.infer<typeof copilotMessageSchema>;
export type CopilotChatInput = z.infer<typeof copilotChatSchema>;
