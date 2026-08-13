import type {
  Request,
  Response,
  NextFunction,
} from "express";

import jwt from "jsonwebtoken";
import AppError from "../services/AppError.js";
import asyncHandler from "./asyncHandler.js";

interface JwtPayload {
  userId: string;
  email: string;
}

export interface AuthRequest extends Request {
  userId?: string;
}

const authMiddleware = asyncHandler(
  async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ) => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      throw new AppError(
        "Authentication required",
        401
      );
    }

    const token = authHeader.split(" ")[1];

    try {
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET as string
      ) as JwtPayload;

      req.userId = decoded.userId;

      next();
    } catch {
      throw new AppError(
        "Invalid or expired token",
        401
      );
    }
  }
);

export default authMiddleware;