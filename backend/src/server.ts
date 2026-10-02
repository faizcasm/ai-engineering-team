import "dotenv/config";

import app from "./index.js";
import logger from "./config/logger.config.js";

const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || "0.0.0.0";

const server = app.listen(port, host, () => {
  logger.info("Server listening", {
    port,
    host,
    env: process.env.NODE_ENV || "development",
  });
});

server.on("error", (error) => {
  logger.error("Server failed to start", {
    message: error.message,
    stack: error.stack,
  });

  process.exit(1);
});

function shutdown(signal: string): void {
  logger.info("Shutting down", { signal });

  server.close(() => {
    process.exit(0);
  });

  // Force exit when connections refuse to drain.
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export default server;
