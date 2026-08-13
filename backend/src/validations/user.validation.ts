import { z } from "zod";

export const signUpSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(
      /^[a-zA-Z0-9_]+$/,
      "Username can only contain letters, numbers and underscores"
    ),

  email: z
    .string()
    .email("Invalid email address")
    .toLowerCase(),

  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(100),
});

export const loginSchema = z.object({
  email: z
    .string()
    .email("Invalid email address")
    .toLowerCase(),

  password: z
    .string()
    .min(1, "Password is required"),
});

export const updateUserSchema = z
  .object({
    username: z
      .string()
      .min(3)
      .max(30)
      .regex(
        /^[a-zA-Z0-9_]+$/,
        "Username can only contain letters, numbers and underscores"
      )
      .optional(),

    email: z
      .string()
      .email("Invalid email address")
      .toLowerCase()
      .optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    {
      message: "At least one field is required",
    }
  );

export const changePasswordSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1),

    newPassword: z
      .string()
      .min(8)
      .max(100),
  })
  .refine(
    (data) =>
      data.currentPassword !== data.newPassword,
    {
      message:
        "New password must be different from current password",
      path: ["newPassword"],
    }
  );