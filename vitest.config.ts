import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/ast.ts", "src/index.ts", "src/pattern-export.ts"],
      reporter: ["text"],
    },
  },
});
