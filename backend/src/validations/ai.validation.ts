import { z } from "zod";

/* =====================================================
   CHAT
===================================================== */

export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),

  content: z
    .string()
    .min(1, "Message content is required")
    .max(20000, "Message content is too long")
    .trim(),

  name: z
    .string()
    .max(60)
    .optional(),
});

export type ChatMessageInput = z.infer<
  typeof chatMessageSchema
>;

export const chatCompletionSchema = z.object({
  messages: z
    .array(chatMessageSchema)
    .min(1, "At least one message is required")
    .max(50, "At most 50 messages are allowed"),

  model: z
    .string()
    .min(1)
    .max(100)
    .optional(),

  system: z
    .string()
    .max(8000, "System prompt is too long")
    .optional(),

  temperature: z
    .number()
    .min(0, "Temperature must be at least 0")
    .max(2, "Temperature must be at most 2")
    .optional(),

  maxTokens: z
    .number()
    .int("maxTokens must be an integer")
    .min(1, "maxTokens must be at least 1")
    .max(32000, "maxTokens must be at most 32000")
    .optional(),
});

export type ChatCompletionInput = z.infer<
  typeof chatCompletionSchema
>;
