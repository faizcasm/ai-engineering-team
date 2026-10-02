import { Router } from "express";
import type { NextFunction, Request, Response } from "express";

import rateLimit from "../config/ratelimit.config.js";

import {
  chatController,
  completeController,
  modelsController,
} from "../controller/ai.controller.js";

const router = Router();

/* LLM calls are expensive, so the AI endpoints are throttled
   with the limits configured in the environment. */
const aiRateLimit = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const limiter = rateLimit({
    windowMs:
      Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000,

    maxRequests:
      Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 30,

    keyPrefix: "ai",
  });

  return limiter(req, res, next);
};

router.post(
  "/chat",
  aiRateLimit,
  chatController
);

router.post(
  "/complete",
  aiRateLimit,
  completeController
);

router.get(
  "/models",
  modelsController
);

export default router;
