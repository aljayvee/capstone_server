import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Blocks the live Realtime Database in every test (see the file).
    setupFiles: ["tests/setup/noLiveFirebase.ts"],
  },
});
