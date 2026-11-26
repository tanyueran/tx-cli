import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    globalSetup: ["packages/cli/test/global-setup.ts"],
    coverage: {
      include: ["packages/*/src/**/*.ts"],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 75,
        lines: 75,
      },
    },
  },
  resolve: {
    alias: {
      "@tanyueran/agent-core": new URL("./packages/agent-core/src", import.meta.url).pathname,
      "@tanyueran/agent-common": new URL("./packages/agent-common/src", import.meta.url).pathname,
      "@tanyueran/agent-scaffold": new URL("./packages/agent-scaffold/src", import.meta.url).pathname,
      "@tanyueran/cli": new URL("./packages/cli/src", import.meta.url).pathname,
    },
  },
});
