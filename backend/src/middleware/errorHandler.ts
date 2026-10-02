import type {
  Request,
  Response,
  NextFunction,
} from "express";

import AppError from "../services/AppError.js";
import logger from "../config/logger.config.js";

const errorHandler = (
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  logger.error("Request failed", {
    method: req.method,
    url: req.originalUrl,
    message: error.message,
    stack: error.stack,
    ip: req.ip,
  });

  if (error instanceof AppError) {
    const body: Record<string, unknown> = {
      success: false,
      message: error.message,
    };

    if (error.errors !== undefined) {
      body.errors = error.errors;
    }

    return res.status(error.statusCode).json(body);
  }

  return res.status(500).json({
    success: false,
    message: "Internal Server Error",
  });
};

export default errorHandler;