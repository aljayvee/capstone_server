/**
 * sysAdminLogService.ts
 *
 * Reads system logs (PM2, Nginx) with strict server-side credential and secret redaction.
 */

import fs from "fs";
import readline from "readline";
import os from "os";

export type LogSource = "pm2_out" | "pm2_error" | "nginx_access" | "nginx_error";

const LOG_PATHS_LINUX: Record<LogSource, string> = {
  pm2_out: "/root/.pm2/logs/capstone-backend-out.log",
  pm2_error: "/root/.pm2/logs/capstone-backend-error.log",
  nginx_access: "/var/log/nginx/access.log",
  nginx_error: "/var/log/nginx/error.log",
};

// Patterns that MUST be redacted before client delivery
const REDACTION_PATTERNS = [
  { pattern: /Bearer\s+ey[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, replacement: "Bearer [REDACTED_JWT]" },
  { pattern: /ey[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, replacement: "[REDACTED_JWT]" },
  { pattern: /mysql:\/\/[^:]+:[^@]+@[^\/]+/g, replacement: "mysql://[REDACTED_DB_USER]:[REDACTED_DB_PASS]@[REDACTED_HOST]" },
  { pattern: /("password"\s*:\s*)"[^"]+"/gi, replacement: '$1"[REDACTED_PASSWORD]"' },
  { pattern: /(password=)[^&\s]+/gi, replacement: "$1[REDACTED_PASSWORD]" },
  { pattern: /AIzaSy[a-zA-Z0-9_-]{33}/g, replacement: "[REDACTED_GOOGLE_KEY]" },
  { pattern: /(token=)[a-f0-9]{32,}/gi, replacement: "$1[REDACTED_TOKEN]" },
  { pattern: /(JWT_SECRET|JWT_REFRESH_SECRET|SMTP_PASS|FIREBASE_PRIVATE_KEY)=["']?[^"'\s\n]+/g, replacement: "$1=[REDACTED_SECRET]" },
];

export function sanitizeLogLine(line: string): string {
  let sanitized = line;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

export const sysAdminLogService = {
  /**
   * Retrieves sanitized tail lines from a specified system log.
   */
  async getTailLogs(
    source: LogSource,
    linesCount: number = 100,
    searchTerm?: string
  ): Promise<{
    source: LogSource;
    filePath: string;
    totalLines: number;
    lines: string[];
  }> {
    const maxLines = Math.min(Math.max(linesCount, 10), 500);
    const filePath = LOG_PATHS_LINUX[source];

    if (!fs.existsSync(filePath)) {
      // Local / Dev Fallback
      return {
        source,
        filePath: `${filePath} (Not present in local environment)`,
        totalLines: 1,
        lines: [
          `[DevEnvironment] File '${filePath}' is not present on this host (${os.platform()}).`,
          `This log source is active and streamed in the production Linux Contabo VPS.`,
        ],
      };
    }

    const fileStream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const buffer: string[] = [];
    const searchLower = searchTerm ? searchTerm.toLowerCase() : null;

    for await (const line of rl) {
      if (searchLower && !line.toLowerCase().includes(searchLower)) {
        continue;
      }
      buffer.push(line);
      // Keep only last maxLines
      if (buffer.length > maxLines) {
        buffer.shift();
      }
    }

    // Apply strict credential redaction
    const sanitizedLines = buffer.map((l) => sanitizeLogLine(l));

    return {
      source,
      filePath,
      totalLines: sanitizedLines.length,
      lines: sanitizedLines,
    };
  },
};
