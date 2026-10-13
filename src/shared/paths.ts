import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

let cachedRoot: string | undefined;

/**
 * 定位 template 目录所在的包根目录
 * 说明：产物运行时位于 dist/，源码调试时位于 src/**，两者与 template 的相对层级不同，
 * 因此从当前文件所在目录逐级向上查找同时含 package.json 与 template 的目录
 * @returns {string} 包根目录的绝对路径
 */
export function findPackageRoot(): string {
  if (cachedRoot) {
    return cachedRoot;
  }

  let current = typeof __dirname !== "undefined" ? __dirname : process.cwd();

  for (;;) {
    if (
      existsSync(join(current, "package.json")) &&
      existsSync(join(current, "template"))
    ) {
      cachedRoot = current;
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("未能定位到 template 目录，安装包可能已损坏");
    }
    current = parent;
  }
}

/**
 * 把模板元数据里的相对路径解析为绝对路径
 * @param {string} relativePath - 相对于 template 目录的路径，如 project/vue/vite-vue-ts
 * @returns {string} 模板目录的绝对路径
 */
export function resolveTemplatePath(relativePath: string): string {
  return resolve(findPackageRoot(), "template", relativePath);
}

/**
 * 读取 CLI 版本号
 * 构建产物中 __CLI_VERSION__ 会被 rollup 替换为字面量；直跑源码（tsx）时该常量不存在，
 * 此时回退到读取 package.json，保证两种运行方式行为一致
 * @returns {string} 版本号
 */
export function getVersion(): string {
  if (typeof __CLI_VERSION__ !== "undefined") {
    return __CLI_VERSION__;
  }
  const pkgPath = join(findPackageRoot(), "package.json");
  return JSON.parse(readFileSync(pkgPath, "utf-8")).version;
}

/**
 * 把路径解析为绝对路径：空值回退到当前工作目录，相对路径基于当前工作目录解析
 * @param {string} input - 原始路径（可为空）
 * @param {string} [fallback] - 输入为空时的回退路径，缺省为当前工作目录
 * @returns {string} 绝对路径
 */
export function resolveFromCwd(
  input: string,
  fallback: string = process.cwd()
): string {
  const raw = input.trim();
  if (!raw) {
    return fallback;
  }
  return isAbsolute(raw) ? raw : resolve(raw);
}
