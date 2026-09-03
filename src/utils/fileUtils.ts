import { basename, dirname } from "node:path";
import { existsSync, readdirSync } from "node:fs";

/**
 * 严格区分大小写地判断文件是否存在
 * 说明：macOS/Windows 的文件系统对大小写不敏感，existsSync 无法区分 Foo.ts 与 foo.ts，
 * 因此需要再读取父目录列表做一次精确比对
 * @param {string} filepath - 待判断的文件路径
 * @returns {boolean} 文件存在且名称大小写完全一致时返回 true
 */
export function existsWithExactCase(filepath: string): boolean {
  if (!existsSync(filepath)) {
    return false;
  }

  const parentDir = dirname(filepath);
  const targetFile = basename(filepath);
  const files = readdirSync(parentDir);

  return files.includes(targetFile); // 严格匹配大小写
}
