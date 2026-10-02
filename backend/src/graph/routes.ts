import { Router } from "express";

import {
  invokeGraphController,
  streamGraphController,
} from "../controller/graph.controller.js";

const router = Router();

router.post(
  "/invoke",
  invokeGraphController
);

router.post(
  "/stream",
  streamGraphController
);

export default router;
