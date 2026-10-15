import { vi } from "vitest";

/**
 * No test may write to the live Realtime Database.
 *
 * The server's .env names a real service account and env.ts reloads it over
 * anything a test sets, so code under test that writes to Firebase
 * (lib/chatAccess.ts) wrote to production: the first full run after chat access
 * shipped left `chat_access/e1` there (2026-10-07). Every database handle now
 * throws unless a test mocks firebase-admin/database itself, and the code that
 * writes logs the failure and carries on, as it does when Firebase is down.
 */
vi.mock("firebase-admin/database", () => {
  const refuse = () => {
    throw new Error("Tests may not reach the live Realtime Database. Mock firebase-admin/database in this test.");
  };
  return { getDatabase: refuse, getDatabaseWithUrl: refuse };
});
