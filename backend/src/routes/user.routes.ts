import { Router } from "express";

import {
  signUpController,
  loginController,
  logoutController,
  getMeController,
  updateUserController,
  changePasswordController,
  deleteAccountController,
} from "../controller/user.controller.js";

import authMiddleware from "../middleware/authMiddleware.js";

const router = Router();

router.post(
  "/signup",
  signUpController
);

router.post(
  "/login",
  loginController
);

router.post(
  "/logout",
  authMiddleware,
  logoutController
);

router.get(
  "/me",
  authMiddleware,
  getMeController
);

router.patch(
  "/me",
  authMiddleware,
  updateUserController
);

router.patch(
  "/me/password",
  authMiddleware,
  changePasswordController
);

router.delete(
  "/me",
  authMiddleware,
  deleteAccountController
);

export default router;