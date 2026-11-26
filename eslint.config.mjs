import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "coverage/", "script/", "packages/*/dist/", "packages/*/dist-debug/", "packages/agent-scaffold/template/"],
  },
  {
    rules: {
      // 允许未使用的函数参数（常见于回调中预留参数接口）
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      // 允许使用 any（项目成熟度阶段暂不强制）
      "@typescript-eslint/no-explicit-any": "off",
      // 包边界守卫（Phase 3）：禁止跨包相对路径导入（如 ../core/src/...），
      // 跨包一律经 @tanyueran/* 包名导入，确保依赖只走各包公开出口
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^(?:\\.\\.?/)+(?:[a-z0-9-]+/)*(?:core|shared|scaffold|cli|desktop|server)/(?:src|test)(?:/|$)",
              message:
                "禁止跨包相对路径导入：请改用 @tanyueran/* 包名导入（包公开出口见各包 package.json exports）",
            },
          ],
        },
      ],
    },
  }
);