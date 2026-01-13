import { basename, dirname } from "node:path";
import { existsSync, readdirSync } from "node:fs";

export function existsWithExactCase(filepath: string): boolean {
  if (!existsSync(filepath)) {
    return false;
  }

  const parentDir = dirname(filepath);
  const targetFile = basename(filepath);
  const files = readdirSync(parentDir);

  return files.includes(targetFile); // 严格匹配大小写
}


existsWithExactCase("./fileUtils.ts")