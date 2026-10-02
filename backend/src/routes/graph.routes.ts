import { Router } from "express";

import workflowRoutes from "../graph/routes.js";
import { listRolesController } from "../controller/graph.controller.js";

const router = Router();

router.get(
  "/roles",
  listRolesController
);

router.use("/", workflowRoutes);

export default router;
