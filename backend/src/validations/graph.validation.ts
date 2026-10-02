import { z } from "zod";

import {
  MAX_TASKS_PER_PLAN,
  TEAM_ROLES,
} from "../graph/state.js";

import { chatMessageSchema } from "./ai.validation.js";

/* =====================================================
   WORKFLOW INPUT
===================================================== */

export const runGraphSchema = z.object({
  goal: z
    .string()
    .min(10, "Goal must be at least 10 characters")
    .max(8000, "Goal must be at most 8000 characters")
    .trim(),

  maxIterations: z
    .number()
    .int("maxIterations must be an integer")
    .min(1, "maxIterations must be at least 1")
    .max(10, "maxIterations must be at most 10")
    .optional(),

  messages: z
    .array(chatMessageSchema)
    .max(30, "At most 30 messages are allowed")
    .optional(),
});

export type RunGraphInput = z.infer<typeof runGraphSchema>;

/* =====================================================
   LLM OUTPUT CONTRACTS
===================================================== */

export const taskAssignmentSchema = z
  .array(
    z.object({
      title: z
        .string()
        .min(1, "Task title is required")
        .max(200, "Task title is too long"),

      description: z
        .string()
        .min(1, "Task description is required")
        .max(4000, "Task description is too long"),

      role: z.enum(TEAM_ROLES),
    })
  )
  .min(1, "At least one task is required")
  .max(MAX_TASKS_PER_PLAN);

export type TaskAssignment = z.infer<
  typeof taskAssignmentSchema
>;

export const reviewDecisionSchema = z.object({
  approved: z.boolean(),

  feedback: z
    .string()
    .max(4000)
    .default(""),

  reworkTaskIds: z
    .array(z.string().max(60))
    .max(MAX_TASKS_PER_PLAN)
    .default([]),
});

export type ReviewDecision = z.infer<
  typeof reviewDecisionSchema
>;
