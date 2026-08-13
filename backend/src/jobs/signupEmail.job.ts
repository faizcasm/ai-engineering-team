import { emailQueue } from "../config/queue.config.js";

interface SignupEmailData {
  userId: string;
  username: string;
  email: string;
}

export const signupEmailJob = async (
  userId: string,
  username: string,
  email: string
) => {
  await emailQueue.add(
    "signup-email",
    {
      userId,
      username,
      email,
    },
    {
      attempts: 3,

      backoff: {
        type: "exponential",
        delay: 5000,
      },

      removeOnComplete: {
        age: 60 * 60,
        count: 100,
      },

      removeOnFail: {
        age: 24 * 60 * 60,
      },
    }
  );
};