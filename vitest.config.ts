import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@tx-cli/core": new URL("./packages/core/src", import.meta.url).pathname,
      "@tx-cli/shared": new URL("./packages/shared/src", import.meta.url).pathname,
      "@tx-cli/scaffold": new URL("./packages/scaffold/src", import.meta.url).pathname,
      "@tx-cli/cli": new URL("./packages/cli/src", import.meta.url).pathname,
    },
  },
});
