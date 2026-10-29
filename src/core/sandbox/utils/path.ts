import { compilePathGlob } from "./glob";

/**
 * 判断路径是否命中路径模式（fs 边界检查的匹配口径）
 * 模式不含 / 时视为文件名模式，按任意目录下的同名（glob）匹配，使 .env、*.pem 命中任意层级；
 * 含 / 且含 * 时按完整路径 glob 匹配（** 跨目录、* 单段内）；
 * 含 / 且不含 * 时按路径前缀匹配（模式是目录时其子树全部命中，模式是文件时精确匹配）
 * @param {string} pattern - 路径模式（已展开 ~）
 * @param {string} path - 待检查的绝对路径
 * @returns {boolean} 命中时为 true
 */
export function matchPathPattern(pattern: string, path: string): boolean {
  if (pattern.includes("*") || !pattern.includes("/")) {
    const variants = pattern.includes("/") ? [pattern] : [`**/${pattern}`];
    return variants.some((candidate) => compilePathGlob(candidate).test(path));
  }
  const prefix = pattern.endsWith("/") ? pattern : `${pattern}/`;
  return path === pattern || path.startsWith(prefix);
}
