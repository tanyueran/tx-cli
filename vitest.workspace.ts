import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "integration",
      include: ["test/**/*.test.ts"],
    },
    resolve: {
      alias: {
        "@tx-cli/core": new URL("./packages/core/src", import.meta.url).pathname,
        "@tx-cli/shared": new URL("./packages/shared/src", import.meta.url).pathname,
        "@tx-cli/scaffold": new URL("./packages/scaffold/src", import.meta.url).pathname,
        "@tx-cli/cli": new URL("./packages/cli/src", import.meta.url).pathname,
      },
    },
  },
]);
