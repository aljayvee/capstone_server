import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import http from "http";

import { io } from "./lib/socket.js";
import { logger } from "./lib/logger.js";
import { PORT, ALLOWED_ORIGINS } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { schedulePruneBlocklistJob } from "./jobs/pruneBlocklist.js";
import { scheduleRiderStatusSnapshotJob } from "./jobs/riderStatusSnapshot.js";
import { scheduleDwellLearningJob } from "./jobs/dwellLearning.js";
import apiRoutes from "./routes/index.js";

const app = express();

// Behind a reverse proxy (Cloudflare Tunnel / nginx) the client IP arrives in
// X-Forwarded-For. Without this, express-rate-limit throws ValidationError and
// every rate-limited route fails for mobile clients.
app.set("trust proxy", 1);

app.use(helmet());

// CORS Configuration — Restrict to allowed origins with credentials
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);

      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, origin);
      }
      return callback(new Error("CORS policy violation: Origin not allowed"));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// Initialize HTTP Server and attach the shared Socket.IO singleton (lib/socket.ts)
const httpServer = http.createServer(app);
io.attach(httpServer);

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    message: "Node.js Express MariaDB Backend Server is running (Strict Security Standard Enabled)",
    timestamp: new Date().toISOString(),
  });
});

// All domain routes (auth, users, errands, riders, customer-locations, merchant-categories, rate-config)
app.use("/api", apiRoutes);

// Centralized error handler — MUST be registered last, after all routes.
app.use(errorHandler);

schedulePruneBlocklistJob();
scheduleRiderStatusSnapshotJob();
scheduleDwellLearningJob();

// Start HTTP Server (which includes Express and Socket.IO)
httpServer.listen(Number(PORT), "0.0.0.0", () => {
  logger.info(`Backend Server running on http://0.0.0.0:${PORT}`);
});
