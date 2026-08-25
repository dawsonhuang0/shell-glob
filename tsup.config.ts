import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", pattern: "src/pattern-export.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "node18",
});
