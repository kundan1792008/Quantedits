/**
 * Structured logging via Pino.
 *
 * Usage:
 *   import { logger } from '@/lib/logger';
 *   logger.info({ projectId }, 'Timeline generated');
 *   logger.error({ err }, 'Render failed');
 */

import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(process.env.NODE_ENV !== "production" && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true },
    },
  }),
  base: {
    service: "quantedits",
    env: process.env.NODE_ENV ?? "development",
  },
});
