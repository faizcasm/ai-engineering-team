import type { Request, Response } from "express";

import asyncHandler from "../middleware/asyncHandler.js";
import AppError from "../services/AppError.js";
import logger from "../config/logger.config.js";

import {
  createServer,
  deleteServer,
  getServer,
  listServers,
  pingServer,
} from "../services/mcp.service.js";

import {
  createMcpServerSchema,
  mcpIdParamSchema,
} from "../validations/mcp.validation.js";

/* =====================================================
   HELPERS
===================================================== */

function parseId(req: Request): string {
  const result = mcpIdParamSchema.safeParse(req.params.id);

  if (!result.success) {
    throw new AppError(
      "Validation failed",
      400,
      result.error.flatten().fieldErrors
    );
  }

  return result.data;
}

/* =====================================================
   LIST
===================================================== */

export const listServersController = asyncHandler(
  async (req: Request, res: Response) => {
    const servers = listServers();

    return res.status(200).json({
      success: true,
      data: {
        servers,
        count: servers.length,
      },
    });
  }
);

/* =====================================================
   GET ONE
===================================================== */

export const getServerController = asyncHandler(
  async (req: Request, res: Response) => {
    const id = parseId(req);
    const server = getServer(id);

    return res.status(200).json({
      success: true,
      data: { server },
    });
  }
);

/* =====================================================
   CREATE
===================================================== */

export const createServerController = asyncHandler(
  async (req: Request, res: Response) => {
    const result = createMcpServerSchema.safeParse(req.body);

    if (!result.success) {
      throw new AppError(
        "Validation failed",
        400,
        result.error.flatten().fieldErrors
      );
    }

    const server = createServer(result.data);

    logger.info("MCP server created via API", {
      id: server.id,
      name: server.name,
      ip: req.ip,
    });

    return res.status(201).json({
      success: true,
      message: "MCP server registered",
      data: { server },
    });
  }
);

/* =====================================================
   DELETE
===================================================== */

export const deleteServerController = asyncHandler(
  async (req: Request, res: Response) => {
    const id = parseId(req);

    deleteServer(id);

    logger.info("MCP server deleted via API", {
      id,
      ip: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: "MCP server removed",
      data: { id },
    });
  }
);

/* =====================================================
   PING
===================================================== */

export const pingServerController = asyncHandler(
  async (req: Request, res: Response) => {
    const id = parseId(req);
    const ping = await pingServer(id);

    return res.status(200).json({
      success: true,
      data: { ping },
    });
  }
);
