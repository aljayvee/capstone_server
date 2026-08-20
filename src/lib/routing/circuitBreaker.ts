import { logger } from "../logger.js";

const FAILURE_THRESHOLD = 3;
const OPEN_DURATION_MS = 60 * 1000;

// One breaker per routing provider. Without this, an OSRM box that has gone
// down costs every single routing call a full 5s timeout before the chain falls
// through to Google — which in turn stalls errand creation, repricing, and
// every ETA recompute behind it. After three consecutive failures the provider
// is skipped outright for a minute, then given one probe request to prove it
// has recovered.
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  constructor(private readonly label: string) {}

  // False while the breaker is open and the cool-off has not elapsed. The first
  // call after the cool-off is allowed through as a probe (half-open).
  canAttempt(): boolean {
    if (this.openedAt === null) return true;
    if (Date.now() - this.openedAt >= OPEN_DURATION_MS) {
      logger.info(`Circuit breaker for ${this.label} is half-open — probing.`);
      this.openedAt = null;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    if (this.consecutiveFailures > 0 || this.openedAt !== null) {
      logger.info(`Circuit breaker for ${this.label} closed after a successful call.`);
    }
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= FAILURE_THRESHOLD && this.openedAt === null) {
      this.openedAt = Date.now();
      logger.error(
        `Circuit breaker for ${this.label} opened after ${this.consecutiveFailures} consecutive failures.`
      );
    }
  }
}
