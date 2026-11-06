import typescript from "@rollup/plugin-typescript";
import replace from "@rollup/plugin-replace";
import terser from "@rollup/plugin-terser";
import { createRequire } from "node:module";
import { rmSync, mkdirSync, cpSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

/** 构建输出目录 */
const outDir = "./dist";

/**
 * 运行时依赖保持 external，由 npm 安装到用户环境，不打进产物
 * 依赖的子路径导入（如 @modelcontextprotocol/sdk/client/index.js）同样视为 external
 * @param {string} id - 待判定的模块标识
 * @returns {boolean} 是否 external
 */
function external(id) {
  if (id.startsWith("node:")) {
    return true;
  }
  // workspace 包不 external，需要打进产物
  if (id.startsWith("@tx-cli/")) {
    return false;
  }
  return Object.keys(pkg.dependencies || {}).some(
    (dep) => id === dep || id.startsWith(`${dep}/`),
  );
}

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

/**
 * 构建结束后把 scaffold 模板目录复制进产物
 * 运行时 loadTemplates 从产物所在位置向上查找 template 目录，
 * 复制到 dist/template 后，无论本地直接运行还是发布为 npm 包均可正确定位
 * @param {string} srcDir - 模板源目录（相对配置文件的路径）
 * @param {string} destDir - 产物内目标目录（相对配置文件的路径）
 * @returns {import('rollup').Plugin} rollup 插件对象
 */
function copyTemplates(srcDir, destDir) {
  return {
    name: "copy-templates",
    closeBundle() {
      const source = path.resolve(import.meta.dirname, srcDir);
      const target = path.resolve(import.meta.dirname, destDir);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
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
      include: ["**/*.ts"],
      compilerOptions: {
        // monorepo 中 rollup 会把跨包源码（@tx-cli/shared/core/scaffold）纳入同一 TS 程序，
        // 必须显式指定 rootDir/outDir 为仓库根，否则 rootDir 自动推断不稳定，
        // 导致 emit 路径与插件预期的产物路径不一致而拿不到转译后的代码
        rootDir: "../..",
        outDir: "./dist",
        removeComments: true,
      },
    }),
    // 压缩产物，保留 shebang 注释
    terser({
      format: {
        comments: /^!|^#!/,
      },
    }),
    // 把 scaffold 模板复制进产物，保证运行时 loadTemplates 可定位
    copyTemplates("../scaffold/template", "./dist/template"),
  ],
  // 依赖为 external 时无需 node-resolve/commonjs，此处保持最小插件集
  onwarn(warning, warn) {
    // 入口带 shebang 时 rollup 会提示 banner 位置，属预期行为
    if (warning.code === "EMPTY_BUNDLE") return;
    warn(warning);
  },
};
