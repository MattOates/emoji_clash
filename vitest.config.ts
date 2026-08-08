import { defineConfig } from "vitest/config";

// The simulation is pure integer TypeScript with no DOM anywhere, so it runs
// under plain Node. Only src/render.ts and src/main.ts touch a browser, and
// neither is under test.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
