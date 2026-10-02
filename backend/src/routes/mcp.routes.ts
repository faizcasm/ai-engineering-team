import { Router } from "express";

import {
  createServerController,
  deleteServerController,
  getServerController,
  listServersController,
  pingServerController,
} from "../controller/mcp.controller.js";

const router = Router();

router.get(
  "/servers",
  listServersController
);

router.post(
  "/servers",
  createServerController
);

router.get(
  "/servers/:id",
  getServerController
);

router.delete(
  "/servers/:id",
  deleteServerController
);

router.post(
  "/servers/:id/ping",
  pingServerController
);

export default router;
