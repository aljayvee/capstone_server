process.env.TZ = process.env.TZ || "Asia/Manila";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import http from "http";

import { io } from "./lib/socket.js";
import { registerRiderLocationChannel } from "./lib/riderLocationBroadcast.js";
import { registerRiderLiveLink } from "./lib/riderLiveLink.js";
import { logger } from "./lib/logger.js";
import { isEmailConfigured } from "./lib/mailer.js";
import { PORT, ALLOWED_ORIGINS } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { schedulePruneBlocklistJob } from "./jobs/pruneBlocklist.js";
import { scheduleRiderStatusSnapshotJob } from "./jobs/riderStatusSnapshot.js";
import { scheduleDwellLearningJob } from "./jobs/dwellLearning.js";
import { scheduleNightlyBackupJob } from "./jobs/nightlyBackup.js";
import { scheduleRiderShiftJobs } from "./jobs/riderShiftJobs.js";
import { scheduleCategoryRetrainingJob } from "./jobs/categoryRetraining.js";
import { scheduleRiderWatchReconcileJob } from "./jobs/riderWatchReconcile.js";
import { scheduleOfferExpiryJob } from "./jobs/offerExpiry.js";
import { threatInterceptor } from "./middleware/threatInterceptor.js";
import { sysAdminThreatService } from "./services/sysAdminThreatService.js";
import apiRoutes from "./routes/index.js";
import { TRUSTED_PROXIES } from "./lib/trustedProxies.js";

const app = express();

// Behind Cloudflare -> nginx -> Express. Trust exactly those hops, by address,
// so req.ip is the real client and never an address the client wrote into
// X-Forwarded-For. See lib/trustedProxies.ts for why it is not `true` (any
// caller could pick their IP) or a hop count (the origin is also reachable
// without Cloudflare).
app.set("trust proxy", TRUSTED_PROXIES);

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
    // Expose headers for client-side streaming and PDF/APK file downloads
    exposedHeaders: [
      "Content-Disposition",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "X-Chunk-Index",
      "X-Total-Chunks",
      "X-Chunk-Size",
      "X-Total-Size",
      // Rate limits: the portal's sign-in screen counts down the real wait and
      // warns before the lock (middleware/rateLimiters.ts, reportLoginAllowance)
      "Retry-After",
      "X-Login-Attempts-Remaining",
      "X-Login-Attempts-Reset",
      "X-Login-Attempts-Scope",
    ],
  })
);

// Early threat defense & directory probe interception
app.use(threatInterceptor);

app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true, limit: "30mb" }));
app.use(cookieParser());

// Initialize HTTP Server and attach the shared Socket.IO singleton (lib/socket.ts)
const httpServer = http.createServer(app);
io.attach(httpServer);
// Live rider positions over Socket.IO, alongside the Firebase RTDB feed.
registerRiderLocationChannel();
// One-second rider heartbeat over the same sockets (signal loss in ~3 s).
registerRiderLiveLink();

// Robots exclusion standard for API Gateway (Crawlers must not index API endpoints)
app.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send("User-agent: *\nDisallow: /\n");
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  const healthData = {
    status: "online",
    message: "Node.js Express MariaDB Backend Server is running (Strict Security Standard Enabled)",
    timestamp: new Date().toISOString(),
  };

  if (req.accepts("html")) {
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>API Health Status | SUGO Express</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #0F2035; color: #F8FAFC; padding: 2rem; }
          .container { max-w-2xl mx-auto bg-[#0B132B] p-6 rounded-xl border border-slate-800 shadow-lg mt-10; max-width: 600px; margin: 0 auto; }
          .status { display: inline-block; padding: 0.25rem 0.75rem; background-color: rgba(16, 185, 129, 0.15); color: #34D399; border-radius: 9999px; font-weight: bold; font-size: 0.875rem; margin-bottom: 1rem; border: 1px solid rgba(16, 185, 129, 0.3); }
          h1 { margin-top: 0; font-size: 1.5rem; }
          p { color: #94A3B8; line-height: 1.5; }
          .timestamp { margin-top: 1.5rem; font-size: 0.875rem; color: #64748B; font-family: monospace; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="status">🟢 System Online</div>
          <h1>SUGO Express API Gateway</h1>
          <p>${healthData.message}</p>
          <div class="timestamp">Last Updated: ${healthData.timestamp}</div>
        </div>
      </body>
      </html>
    `);
  } else {
    res.json(healthData);
  }
});

// SSE Stream for real-time health updates
app.get("/api/health/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const sendUpdate = () => {
    const data = JSON.stringify({
      status: "online",
      message: "System is operating normally",
      timestamp: new Date().toISOString(),
      connections: Object.keys(io.sockets.sockets).length
    });
    res.write(`data: ${data}\n\n`);
  };

  sendUpdate();
  const interval = setInterval(sendUpdate, 5000);

  req.on("close", () => {
    clearInterval(interval);
  });
});

// All domain routes (auth, users, errands, riders, customer-locations, merchant-categories, rate-config)
app.use("/api", apiRoutes);

// Centralized error handler — MUST be registered last, after all routes.
app.use(errorHandler);

schedulePruneBlocklistJob();
scheduleRiderStatusSnapshotJob();
scheduleDwellLearningJob();
scheduleNightlyBackupJob();
scheduleRiderShiftJobs();
scheduleCategoryRetrainingJob();
scheduleRiderWatchReconcileJob();
scheduleOfferExpiryJob();

// Start HTTP Server (which includes Express and Socket.IO)
httpServer.listen(Number(PORT), "0.0.0.0", () => {
  logger.info(`Backend Server running on http://0.0.0.0:${PORT}`);

  // Initialize SysAdmin Dual-Tier Threat Cache and IP Defense
  sysAdminThreatService.initThreatEngine().catch((err) => {
    logger.error("Failed to initialize SysAdmin threat engine:", err);
  });

  // Staff first-login verification cannot complete without outbound mail, so a
  // missing SMTP config is worth saying out loud at boot rather than letting it
  // surface as a mysterious 503 the first time someone new signs in.
  if (!isEmailConfigured()) {
    logger.error(
      "SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS). Staff first-login OTP and sign-in alerts will fail."
    );
  }
});
