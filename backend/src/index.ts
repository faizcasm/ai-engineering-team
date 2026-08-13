import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import compression from "compression";
import dotenv from "dotenv";
import morgan from "morgan";

import type {
  Request,
  Response,
} from "express";

import logger from "./config/logger.config.js";
import errorHandler from "./middleware/errorHandler.js";
import userRoutes from "./routes/user.routes.js";

dotenv.config();

const app = express();

app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy:
      process.env.NODE_ENV === "production",
  })
);

const allowedOrigins =
  process.env.CORS_ORIGIN
    ?.split(",")
    .map((origin) => origin.trim()) || [];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      logger.warn("Blocked CORS request", {
        origin,
      });

      return callback(
        new Error("Not allowed by CORS")
      );
    },
    credentials: true,
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
    ],
  })
);

app.use(
  express.json({
    limit: "10kb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10kb",
  })
);

app.use(cookieParser());

app.use(compression());

morgan.token(
  "user-agent",
  (req) => req.headers["user-agent"] || "-"
);

app.use(
  morgan(
    ":method :url :status :response-time ms :user-agent",
    {
      stream: {
        write: (message) => {
          logger.http(message.trim());
        },
      },
    }
  )
);

app.get(
  "/health",
  (req: Request, res: Response) => {
    return res.status(200).json({
      success: true,
      status: "healthy",
      timestamp: new Date().toISOString(),
    });
  }
);

app.get(
  "/",
  (req: Request, res: Response) => {
    return res.status(200).json({
      success: true,
      message: "Backend is up and running",
    });
  }
);

app.use("/api/users", userRoutes);

app.use(
  (
    req: Request,
    res: Response
  ) => {
    return res.status(404).json({
      success: false,
      message: `Route ${req.method} ${req.originalUrl} not found`,
    });
  }
);

app.use(errorHandler);

export default app;