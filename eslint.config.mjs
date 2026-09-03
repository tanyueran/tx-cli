import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "template/", "script/", "bin/"],
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
    },
  }
);