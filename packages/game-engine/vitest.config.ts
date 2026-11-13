import { defineConfig } from "vitest/config";

// TECHNICAL_SPEC §14.1（T11）：game-engine 行涵蓋率 ≥ 90%。`pnpm --filter @mining/game-engine coverage` 會強制門檻
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/dev-marker.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
