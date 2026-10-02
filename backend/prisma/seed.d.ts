import type { PrismaClient } from "../src/generated/prisma/client.js";

/* =====================================================
   SEED TYPES
   Type-safe contract for prisma/seed.ts.
===================================================== */

export interface SeedUser {
  username: string;
  email: string;
  isVerified?: boolean;
  isActive?: boolean;
}

export declare const seedUsers: SeedUser[];

export declare const SEED_PASSWORD: string;

export declare function seedDatabase(
  client?: PrismaClient,
  password?: string
): Promise<void>;
