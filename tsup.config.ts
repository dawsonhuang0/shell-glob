import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", pattern: "src/pattern-export.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "node18",
  // tsup rewrites `node:fs` to `fs` by default, for hosts too old to know the
  // prefix.  Keep it: Deno needs it to recognise a Node builtin at all, and it
  // cannot be shadowed by a package that happens to be called `fs`.
  removeNodeProtocol: false,
});
