import type { Request, Response } from "express";

import asyncHandler from "../middleware/asyncHandler.js";
import AppError from "../services/AppError.js";
import logger from "../config/logger.config.js";

import {
  ROLE_DESCRIPTIONS,
  TEAM_ROLES,
  createInitialState,
} from "../graph/state.js";

import { TEAM_GRAPH_NODES, teamGraph } from "../graph/workflow.js";

import { runGraphSchema } from "../validations/graph.validation.js";
import type { RunGraphInput } from "../validations/graph.validation.js";

/* =====================================================
   HELPERS
===================================================== */

function parseBody(req: Request): RunGraphInput {
  const result = runGraphSchema.safeParse(req.body);

  if (!result.success) {
    throw new AppError(
      "Validation failed",
      400,
      result.error.flatten().fieldErrors
    );
  }

  return result.data;
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
   INVOKE (ONE-SHOT)
===================================================== */

export const invokeGraphController = asyncHandler(
  async (req: Request, res: Response) => {
    const input = parseBody(req);
    const state = createInitialState(input);

    logger.info("Graph workflow invoked", {
      goal: state.goal.slice(0, 120),
      maxIterations: state.maxIterations,
      ip: req.ip,
    });

    const finalState = await teamGraph.invoke(state);

    logger.info("Graph workflow finished", {
      status: finalState.status,
      iteration: finalState.iteration,
      tasks: finalState.tasks.length,
      results: finalState.results.length,
    });

    const message =
      finalState.status === "completed"
        ? "Workflow completed"
        : `Workflow stopped with status "${finalState.status}"`;

    return res.status(200).json({
      success: finalState.status === "completed",
      message,
      data: { state: finalState },
    });
  }
);

/* =====================================================
   STREAM (SSE)
===================================================== */

export const streamGraphController = asyncHandler(
  async (req: Request, res: Response) => {
    const input = parseBody(req);
    const state = createInitialState(input);

    logger.info("Graph workflow stream opened", {
      goal: state.goal.slice(0, 120),
      ip: req.ip,
    });

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

    let finalStatus = state.status;

    try {
      for await (const event of teamGraph.stream(state)) {
        if (aborted) {
          break;
        }

        finalStatus = event.state.status;

        res.write(
          `event: ${event.type}\n` +
            `data: ${JSON.stringify(event)}\n\n`
        );
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      logger.error("Graph workflow stream failed", {
        message,
        ip: req.ip,
      });

      finalStatus = "failed";

      if (!aborted) {
        res.write(
          `event: error\n` +
            `data: ${JSON.stringify({ message })}\n\n`
        );
      }
    } finally {
      if (!aborted) {
        res.write(
          `event: done\n` +
            `data: ${JSON.stringify({ status: finalStatus })}\n\n`
        );
      }

      res.end();
    }
  }
);

/* =====================================================
   ROLES
===================================================== */

export const listRolesController = asyncHandler(
  async (req: Request, res: Response) => {
    const roles = TEAM_ROLES.map((role) => ({
      role,
      description: ROLE_DESCRIPTIONS[role],
    }));

    return res.status(200).json({
      success: true,
      data: {
        roles,
        graphNodes: [...TEAM_GRAPH_NODES],
      },
    });
  }
);
