import typescript from "@rollup/plugin-typescript";
import replace from "@rollup/plugin-replace";
import terser from "@rollup/plugin-terser";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

/** 构建输出目录 */
const outDir = "./dist";

/**
 * 运行时依赖保持 external，由 npm 安装到用户环境，不打进产物
 */
const external = [...Object.keys(pkg.dependencies || {}), /^node:/];

/**
 * 构建开始前清空输出目录，避免残留旧产物
 * @param {string} dir - 需要清空的目录（相对配置文件的路径）
 * @returns {import('rollup').Plugin} rollup 插件对象
 */
function cleanOutDir(dir) {
  return {
    name: "clean-out-dir",
    buildStart() {
      rmSync(path.resolve(import.meta.dirname, dir), {
        recursive: true,
        force: true,
      });
    },
  };
}

/** @type {import('rollup').RollupOptions} */
export default {
  input: "./src/cli.ts",
  external,
  output: {
    dir: outDir,
    format: "commonjs",
    // CLI 产物需要可直接执行
    banner: "#!/usr/bin/env node",
    sourcemap: false,
  },
  plugins: [
    // 每次构建前清空 dist，避免旧文件残留
    cleanOutDir(outDir),
    // 版本号在构建时内联，避免把整个 package.json 打进产物
    replace({
      preventAssignment: true,
      values: {
        __CLI_VERSION__: JSON.stringify(pkg.version),
      },
    }),
    typescript({
      tsconfig: "./tsconfig.json",
      // 构建只处理 src，测试文件不参与打包；global.d.ts 提供注入常量的类型
      include: ["src/**/*.ts", "global.d.ts"],
      compilerOptions: {
        removeComments: true,
      },
    }),
    // 压缩产物，保留 shebang 注释
    terser({
      format: {
        comments: /^!|^#!/,
      },
    }),
  ],
  // 依赖为 external 时无需 node-resolve/commonjs，此处保持最小插件集
  onwarn(warning, warn) {
    // 入口带 shebang 时 rollup 会提示 banner 位置，属预期行为
    if (warning.code === "EMPTY_BUNDLE") return;
    warn(warning);
  },
};
