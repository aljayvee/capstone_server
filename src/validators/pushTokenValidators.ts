import { z } from "zod";

export const pushTokenSchema = z.object({
  token: z.string().trim().min(1, "token is required."),
});

export type PushTokenInput = z.infer<typeof pushTokenSchema>;
