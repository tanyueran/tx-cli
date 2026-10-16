import pico from "picocolors";

/**
 * 以黄字逐条打印警告（配置读取、技能扫描等非致命提示的统一出口）
 * @param {string[]} warnings - 警告列表
 * @returns {void}
 */
export function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.warn(pico.yellow(warning));
  }
}
