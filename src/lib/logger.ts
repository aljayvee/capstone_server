/* Centralized logger. Swap the console calls for a real transport (e.g. pino) if log volume grows. */
export const logger = {
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};
