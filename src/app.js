import fs from "node:fs";
import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { paths } from "./config/paths.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { authRouter } from "./modules/auth/auth.module.js";
import { publicAwardRouter } from "./modules/award/award.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import legacyRoutes from "./routes/legacy.routes.js";
import publicRoutes from "./routes/public.routes.js";
import seoRoutes from "./routes/seo.routes.js";
import { logger } from "./utils/logger.js";

fs.mkdirSync(paths.uploads, { recursive: true });
fs.mkdirSync(paths.privateStorage, { recursive: true });

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Behind one reverse proxy (nginx) in production, so req.ip is the client address
  app.set("trust proxy", 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin)),
    exposedHeaders: ["Content-Disposition"],
    maxAge: 600,
  }));
  app.use(compression());
  app.use(express.json({ limit: "1mb" }));
  if (!env.isTest) {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url.startsWith("/uploads/") } }));
  }

  // Public, EXIF-free processed images. File names are random and never reused, so cache hard.
  app.use("/uploads", express.static(paths.uploads, { maxAge: "30d", immutable: true, fallthrough: false, index: false }));

  app.use("/api", apiLimiter);
  app.use("/api/auth", authRouter);
  app.use("/api/admin", adminRoutes);
  app.use("/api/shivdurg-award", publicAwardRouter);
  app.use("/api", publicRoutes);
  app.use(seoRoutes);
  app.use(legacyRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
