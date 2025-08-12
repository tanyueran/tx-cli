import typescript from "@rollup/plugin-typescript";
import pluginJson from "@rollup/plugin-json";
import commonjs from "@rollup/plugin-commonjs";
import { terser } from "rollup-plugin-terser";

/** @type {import('rollup').RollupOptions} */
export default {
  input: "./src/index.ts",
  output: {
    dir: "./dist",
    format: "commonjs",
  },
  plugins: [
    typescript({
      tsconfig: "./tsconfig.json",
    }
    ),
    commonjs(),
    pluginJson(),
    terser({
      compress: {
        dead_code: true, // 移除不可达代码
      },
      output: {
        comments: false, // 移除注释
      },
    }),
  ],
};
