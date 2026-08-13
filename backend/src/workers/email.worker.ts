import { Worker } from "bullmq";

import redis from "../config/redis.config.js";
import transporter from "../config/mail.config.js";

import {
  signupEmailTemplate,
} from "../emails/signup.email.js";

import logger from "../config/logger.config.js";

const emailWorker = new Worker(
  "email-queue",

  async (job) => {
    logger.info("Processing email job", {
      jobId: job.id,
      jobName: job.name,
    });

    if (job.name === "signup-email") {
      const {
        userId,
        username,
        email,
      } = job.data;

      const template =
        signupEmailTemplate({
          username,
        });

      await transporter.sendMail({
        from: `"Your App" <${process.env.SMTP_FROM}>`,
        to: email,
        subject: template.subject,
        html: template.html,
      });

      logger.info(
        "Signup email sent successfully",
        {
          jobId: job.id,
          userId,
          email,
        }
      );

      return;
    }

    throw new Error(
      `Unknown email job: ${job.name}`
    );
  },

  {
    connection: redis,

    concurrency: 5,
  }
);

emailWorker.on(
  "completed",
  (job) => {
    logger.info(
      "Email job completed",
      {
        jobId: job.id,
        jobName: job.name,
      }
    );
  }
);

emailWorker.on(
  "failed",
  (job, error) => {
    logger.error(
      "Email job failed",
      {
        jobId: job?.id,
        jobName: job?.name,
        error: error.message,
        stack: error.stack,
      }
    );
  }
);

emailWorker.on(
  "error",
  (error) => {
    logger.error(
      "Email worker error",
      {
        error: error.message,
        stack: error.stack,
      }
    );
  });

export default emailWorker;