import bcrypt from "bcrypt";
import type { Request, Response } from "express";

import db from "../config/db.config.js";
import asyncHandler from "../middleware/asyncHandler.js";
import type { AuthRequest } from "../middleware/authMiddleware.js";

import AppError from "../services/AppError.js";
import logger from "../config/logger.config.js";

import { generateToken } from "../services/jwt.generator.js";
import { signupEmailJob } from "../jobs/signupEmail.job.js";

import {
  signUpSchema,
  loginSchema,
  updateUserSchema,
  changePasswordSchema,
} from "../validations/user.validation.js";

/* =====================================================
   SIGN UP
===================================================== */

export const signUpController = asyncHandler(
  async (req: Request, res: Response) => {
    const result = signUpSchema.safeParse(req.body);

    if (!result.success) {
      throw new AppError(
        "Validation failed",
        400,
        result.error.flatten().fieldErrors
      );
    }

    const { username, email, password } = result.data;

    const existingUser = await db.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new AppError(
        "User already exists",
        409
      );
    }

    const existingUsername = await db.user.findFirst({
      where: { username },
    });

    if (existingUsername) {
      throw new AppError(
        "Username already exists",
        409
      );
    }

    const hashedPassword = await bcrypt.hash(
      password,
      12
    );

    const user = await db.user.create({
      data: {
        username,
        email,
        password: hashedPassword,
      },

      select: {
        id: true,
        username: true,
        email: true,
        isVerified: true,
        createdAt: true,
      },
    });

    const token = generateToken(
      user.id,
      user.email
    );

    // Background job
    await signupEmailJob(
      user.id,
      user.username,
      user.email
    );

    logger.info("User registered", {
      userId: user.id,
      email: user.email,
      ip: req.ip,
    });

    return res.status(201).json({
      success: true,
      message: "User registered successfully",

      data: {
        user,
        token,
      },
    });
  }
);


/* =====================================================
   LOGIN
===================================================== */

export const loginController = asyncHandler(
  async (req: Request, res: Response) => {
    const result = loginSchema.safeParse(req.body);

    if (!result.success) {
      throw new AppError(
        "Validation failed",
        400,
        result.error.flatten().fieldErrors
      );
    }

    const { email, password } = result.data;

    const user = await db.user.findUnique({
      where: { email },
    });

    if (!user) {
      logger.warn("Login failed", {
        email,
        ip: req.ip,
        reason: "User not found",
      });

      throw new AppError(
        "Invalid email or password",
        401
      );
    }

    if (!user.isActive) {
      throw new AppError(
        "Account is disabled",
        403
      );
    }

    const passwordMatch = await bcrypt.compare(
      password,
      user.password
    );

    if (!passwordMatch) {
      logger.warn("Login failed", {
        userId: user.id,
        ip: req.ip,
        reason: "Invalid password",
      });

      throw new AppError(
        "Invalid email or password",
        401
      );
    }

    const token = generateToken(
      user.id,
      user.email
    );

    await db.user.update({
      where: {
        id: user.id,
      },

      data: {
        lastLoginAt: new Date(),
      },
    });

    logger.info("User logged in", {
      userId: user.id,
      email: user.email,
      ip: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: "Login successful",

      data: {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          isVerified: user.isVerified,
        },

        token,
      },
    });
  }
);


/* =====================================================
   LOGOUT
===================================================== */

export const logoutController = asyncHandler(
  async (
    req: AuthRequest,
    res: Response
  ) => {
    if (!req.userId) {
      throw new AppError(
        "Authentication required",
        401
      );
    }

    logger.info("User logged out", {
      userId: req.userId,
      ip: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  }
);


/* =====================================================
   GET CURRENT USER
===================================================== */

export const getMeController = asyncHandler(
  async (
    req: AuthRequest,
    res: Response
  ) => {
    if (!req.userId) {
      throw new AppError(
        "Authentication required",
        401
      );
    }

    const user = await db.user.findUnique({
      where: {
        id: req.userId,
      },

      select: {
        id: true,
        username: true,
        email: true,
        avatarUrl: true,
        isVerified: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new AppError(
        "User not found",
        404
      );
    }

    return res.status(200).json({
      success: true,
      data: {
        user,
      },
    });
  }
);


/* =====================================================
   UPDATE ACCOUNT
===================================================== */

export const updateUserController =
  asyncHandler(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      if (!req.userId) {
        throw new AppError(
          "Authentication required",
          401
        );
      }

      const result =
        updateUserSchema.safeParse(req.body);

      if (!result.success) {
        throw new AppError(
          "Validation failed",
          400,
          result.error.flatten().fieldErrors
        );
      }

      const { username, email } = result.data;

      if (email) {
        const emailExists =
          await db.user.findFirst({
            where: {
              email,
              NOT: {
                id: req.userId,
              },
            },
          });

        if (emailExists) {
          throw new AppError(
            "Email already in use",
            409
          );
        }
      }

      if (username) {
        const usernameExists =
          await db.user.findFirst({
            where: {
              username,
              NOT: {
                id: req.userId,
              },
            },
          });

        if (usernameExists) {
          throw new AppError(
            "Username already in use",
            409
          );
        }
      }

      const user = await db.user.update({
        where: {
          id: req.userId,
        },

        data: {
          ...(username && { username }),

          ...(email && {
            email,
            isVerified: false,
          }),
        },

        select: {
          id: true,
          username: true,
          email: true,
          avatarUrl: true,
          isVerified: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      logger.info("User account updated", {
        userId: req.userId,
        ip: req.ip,
      });

      return res.status(200).json({
        success: true,
        message: "Account updated successfully",

        data: {
          user,
        },
      });
    }
  );


/* =====================================================
   CHANGE PASSWORD
===================================================== */

export const changePasswordController =
  asyncHandler(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      if (!req.userId) {
        throw new AppError(
          "Authentication required",
          401
        );
      }

      const result =
        changePasswordSchema.safeParse(
          req.body
        );

      if (!result.success) {
        throw new AppError(
          "Validation failed",
          400,
          result.error.flatten().fieldErrors
        );
      }

      const {
        currentPassword,
        newPassword,
      } = result.data;

      const user = await db.user.findUnique({
        where: {
          id: req.userId,
        },
      });

      if (!user) {
        throw new AppError(
          "User not found",
          404
        );
      }

      const validPassword =
        await bcrypt.compare(
          currentPassword,
          user.password
        );

      if (!validPassword) {
        throw new AppError(
          "Current password is incorrect",
          400
        );
      }

      const hashedPassword =
        await bcrypt.hash(
          newPassword,
          12
        );

      await db.user.update({
        where: {
          id: req.userId,
        },

        data: {
          password: hashedPassword,
        },
      });

      logger.info(
        "User password changed",
        {
          userId: req.userId,
          ip: req.ip,
        }
      );

      return res.status(200).json({
        success: true,
        message:
          "Password changed successfully",
      });
    }
  );


/* =====================================================
   DELETE ACCOUNT
===================================================== */

export const deleteAccountController =
  asyncHandler(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      if (!req.userId) {
        throw new AppError(
          "Authentication required",
          401
        );
      }

      await db.user.delete({
        where: {
          id: req.userId,
        },
      });

      logger.info(
        "User account deleted",
        {
          userId: req.userId,
          ip: req.ip,
        }
      );

      return res.status(200).json({
        success: true,
        message:
          "Account deleted successfully",
      });
    }
  );