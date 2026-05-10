import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    // Note: For full Worker integration tests (with Durable Objects), use
    // @cloudflare/vitest-pool-workers with pool: "workers" config.
    // These smoke tests run in node environment to avoid wrangler dependency in CI.
  },
  resolve: {
    alias: {
      // Allow test imports of src/ directly
    },
  },
});
