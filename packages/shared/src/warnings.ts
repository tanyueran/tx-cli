import pico from "picocolors";

/**
 * 以黄字逐条打印警告（配置读取、技能扫描等非致命提示的统一出口）
 * @param {string[]} warnings - 警告列表
 * @param {string} [indent] - 每行前缀缩进（REPL 就绪面板下方展示时缩进两格），缺省不缩进
 * @returns {void}
 */
export function printWarnings(warnings: string[], indent = ""): void {
  for (const warning of warnings) {
    console.warn(pico.yellow(`${indent}${warning}`));
  }
}
