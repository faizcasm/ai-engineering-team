import { Queue } from "bullmq";
import redis from "./redis.config.js";

export const emailQueue = new Queue("email-queue", {
    connection: redis,
});