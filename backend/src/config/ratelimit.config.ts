import type {
  Request,
  Response,
  NextFunction,
} from "express";

import redis from "../config/redis.config.js";
import AppError from "../services/AppError.js";
import asyncHandler from "../middleware/asyncHandler.js";

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
}

const rateLimit = ({
  windowMs,
  maxRequests,
  keyPrefix = "rate-limit",
}: RateLimitOptions) => {
  return asyncHandler(
    async (
      req: Request,
      res: Response,
      next: NextFunction
    ) => {
      const identifier =
        req.ip || "unknown";

      const key = `${keyPrefix}:${identifier}`;

      const currentCount =
        await redis.incr(key);

      if (currentCount === 1) {
        await redis.pexpire(
          key,
          windowMs
        );
      }

      const ttl =
        await redis.pttl(key);

      res.setHeader(
        "X-RateLimit-Limit",
        maxRequests
      );

      res.setHeader(
        "X-RateLimit-Remaining",
        Math.max(
          0,
          maxRequests - currentCount
        )
      );

      res.setHeader(
        "X-RateLimit-Reset",
        Math.ceil(
          (Date.now() + ttl) / 1000
        )
      );

      if (currentCount > maxRequests) {
        throw new AppError(
          "Too many requests. Please try again later.",
          429
        );
      }

      next();
    }
  );
};

export default rateLimit;