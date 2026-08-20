import { Router } from "express";
import authRoutes from "./authRoutes.js";
import userRoutes from "./userRoutes.js";
import customerRoutes from "./customerRoutes.js";
import errandRoutes from "./errandRoutes.js";
import riderRoutes from "./riderRoutes.js";
import customerLocationRoutes from "./customerLocationRoutes.js";
import merchantCategoryRoutes from "./merchantCategoryRoutes.js";
import rateConfigRoutes from "./rateConfigRoutes.js";
import analyticsRoutes from "./analyticsRoutes.js";
import reportRoutes from "./reportRoutes.js";
import paymentModeRoutes from "./paymentModeRoutes.js";
import notificationRoutes from "./notificationRoutes.js";
import connectivityIncidentRoutes from "./connectivityIncidentRoutes.js";
import routingRoutes from "./routingRoutes.js";
import placeRoutes from "./placeRoutes.js";

const router = Router();

router.use("/", authRoutes);
router.use("/users", userRoutes);
router.use("/customers", customerRoutes);
router.use("/errands", errandRoutes);
router.use("/riders", riderRoutes);
router.use("/customer-locations", customerLocationRoutes);
router.use("/merchant-categories", merchantCategoryRoutes);
router.use("/rate-config", rateConfigRoutes);
router.use("/analytics", analyticsRoutes);
router.use("/reports", reportRoutes);
router.use("/payment-modes", paymentModeRoutes);
router.use("/notifications", notificationRoutes);
router.use("/connectivity-incidents", connectivityIncidentRoutes);
router.use("/routing", routingRoutes);
router.use("/places", placeRoutes);

export default router;
