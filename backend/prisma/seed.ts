import "dotenv/config";

import { pathToFileURL } from "node:url";

import bcrypt from "bcrypt";

import db from "../src/config/db.config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";

/* =====================================================
   SEED DATA
===================================================== */

export interface SeedUser {
  username: string;
  email: string;
  isVerified?: boolean;
  isActive?: boolean;
}

export const seedUsers: SeedUser[] = [
  {
    username: "faizan",
    email: "faizan@example.com",
    isVerified: true,
  },

  {
    username: "tech_lead",
    email: "tech.lead@example.com",
    isVerified: true,
  },

  {
    username: "qa_engineer",
    email: "qa@example.com",
    isVerified: true,
  },
];

export const SEED_PASSWORD = "Password123!";

/* =====================================================
   SEED RUNNER
===================================================== */

export async function seedDatabase(
  client: PrismaClient = db,
  password: string = SEED_PASSWORD
): Promise<void> {
  const hashedPassword = await bcrypt.hash(password, 12);

  for (const user of seedUsers) {
    await client.user.upsert({
      where: { email: user.email },

      update: {
        username: user.username,
      },

      create: {
        ...user,
        password: hashedPassword,
      },
    });
  }

  console.log(
    `Seeded ${seedUsers.length} user(s) — password: ${SEED_PASSWORD}`
  );
}

async function main(): Promise<void> {
  await seedDatabase();
  await db.$disconnect();
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch(async (error) => {
    console.error("Seed failed", error);
    await db.$disconnect();
    process.exit(1);
  });
}
