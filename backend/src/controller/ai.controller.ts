import type { Request, Response } from "express";

import asyncHandler from "../middleware/asyncHandler.js";
import AppError from "../services/AppError.js";
import logger from "../config/logger.config.js";

import { chat, listModels, streamChat } from "../ai/llm.js";
import type { LLMOptions } from "../ai/llm.js";

import { chatCompletionSchema } from "../validations/ai.validation.js";
import type { ChatCompletionInput } from "../validations/ai.validation.js";

/* =====================================================
   HELPERS
===================================================== */

function parseBody(req: Request): ChatCompletionInput {
  const result = chatCompletionSchema.safeParse(req.body);

  if (!result.success) {
    throw new AppError(
      "Validation failed",
      400,
      result.error.flatten().fieldErrors
    );
  }

  return result.data;
}

function toOptions(body: ChatCompletionInput): LLMOptions {
  return {
    ...(body.model && { model: body.model }),
    ...(body.system && { system: body.system }),

    ...(body.temperature !== undefined && {
      temperature: body.temperature,
    }),

    ...(body.maxTokens && {
      maxTokens: body.maxTokens,
    }),
  };
}

function startSse(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.flushHeaders();
  res.write("retry: 3000\n\n");
}

/* =====================================================
   CHAT (STREAMING)
===================================================== */

export const chatController = asyncHandler(
  async (req: Request, res: Response) => {
    const body = parseBody(req);
    const options = toOptions(body);

    startSse(res);

    // `req` closes once the body is consumed; the response closes
    // when the client actually disconnects mid-stream.
    let aborted = false;

    const markAborted = () => {
      aborted = !res.writableEnded;
    };

    res.on("close", markAborted);

    res.on("error", (error: Error) => {
      markAborted();

      logger.warn("SSE response error", {
        message: error.message,
      });
    });

    try {
      for await (const delta of streamChat(
        body.messages,
        options
      )) {
        if (aborted) {
          break;
        }

        res.write(
          `data: ${JSON.stringify({ delta })}\n\n`
        );
      }

      if (!aborted) {
        res.write(
          `data: ${JSON.stringify({ done: true })}\n\n`
        );

        res.write("data: [DONE]\n\n");
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      logger.error("Streaming chat failed", {
        message,
        ip: req.ip,
      });

      if (!aborted) {
        res.write(
          `data: ${JSON.stringify({ error: message })}\n\n`
        );
      }
    } finally {
      res.end();
    }
  }
);

/* =====================================================
   COMPLETE (NON-STREAMING)
===================================================== */

export const completeController = asyncHandler(
  async (req: Request, res: Response) => {
    const body = parseBody(req);

    const response = await chat(
      body.messages,
      toOptions(body)
    );

    logger.info("Chat completion served", {
      provider: response.provider,
      model: response.model,
      latencyMs: response.latencyMs,
      ip: req.ip,
    });

    return res.status(200).json({
      success: true,
      data: { response },
    });
  }
);

/* =====================================================
   MODELS
===================================================== */

export const modelsController = asyncHandler(
  async (req: Request, res: Response) => {
    return res.status(200).json({
      success: true,
      data: { providers: listModels() },
    });
  }
);
